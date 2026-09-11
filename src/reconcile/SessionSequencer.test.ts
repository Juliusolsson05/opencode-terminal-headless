import { afterEach, describe, expect, it, vi } from 'vitest'

import { LiveStateProjector } from '../live/LiveStateProjector.js'
import type { LiveOutput } from '../live/types.js'
import { listLiveFixtures, loadLiveFixture } from '../testing/fixtures.js'
import type { OpencodeMessageRecord } from '../transcript/records.js'
import { SessionSequencer, type SequencerDurable } from './SessionSequencer.js'

// The sequencer's one cross-source rule is ordering. These tests feed it the
// projector's outputs for real recordings and a durable stub that "commits" a
// record whenever it is drained, then check the order consumers observe.

afterEach(() => {
  vi.useRealTimers()
})

type Logged = { what: string; detail?: string }

function harness() {
  const log: Logged[] = []
  let pending: OpencodeMessageRecord[] = []
  const record = (id: string): OpencodeMessageRecord => ({
    info: { id, sessionID: 'ses_x', role: 'assistant', time: { created: 1, completed: 2 } },
    parts: [{ id: `${id}_p`, messageID: id, sessionID: 'ses_x', type: 'text', text: `answer ${id}` }],
  })
  let sequencer!: SessionSequencer
  const durable: SequencerDurable = {
    ring: () => log.push({ what: 'ring' }),
    drainNow: () => {
      log.push({ what: 'drain' })
      const batch = pending
      pending = []
      sequencer.onDurableRecords(batch)
    },
    flushPendingUsers: () => log.push({ what: 'flush' }),
  }
  sequencer = new SessionSequencer({
    durable: () => durable,
    now: () => 1,
    heartbeatMs: 0,
    sink: {
      entry: r => log.push({ what: 'entry', detail: r.info.id }),
      semantic: e => log.push({ what: e.type, detail: e.type === 'stream_phase' ? e.phase : e.type === 'turn_completed' ? e.fullText : undefined }),
      activity: a => log.push({ what: 'activity', detail: String(a.active) }),
      requests: () => log.push({ what: 'requests' }),
    },
  })
  return { log, sequencer, commitLater: (id: string) => pending.push(record(id)) }
}

describe('SessionSequencer over recorded turns', () => {
  for (const name of listLiveFixtures().filter(n => n !== 'port-conflict.json')) {
    it(`${name}: the committed answer reaches consumers before the turn ends`, () => {
      const fixture = loadLiveFixture(name)
      const projector = new LiveStateProjector(fixture.sessionID, { now: () => 1 })
      const { log, sequencer, commitLater } = harness()
      let turn = 0
      for (const { event } of fixture.sse) {
        const outputs = projector.apply(event)
        // Simulate OpenCode: the final answer becomes readable just before the
        // bus says idle (the durable row precedes its bus event).
        if (outputs.some(o => o.kind === 'turn-end')) commitLater(`msg_final_${(turn += 1)}`)
        sequencer.onLiveOutputs(outputs)
      }
      const order = log.map(entry => entry.what)
      for (let t = 1; t <= turn; t += 1) {
        const entryAt = log.findIndex(entry => entry.what === 'entry' && entry.detail === `msg_final_${t}`)
        const completedAt = order.indexOf('turn_completed', entryAt)
        expect(entryAt).toBeGreaterThanOrEqual(0)
        expect(completedAt).toBeGreaterThan(entryAt)
        // …and the turn's idle phase and inactive activity come after that.
        const idleAt = log.findIndex((entry, i) => i > completedAt && entry.what === 'stream_phase' && entry.detail === 'idle')
        const inactiveAt = log.findIndex((entry, i) => i > idleAt && entry.what === 'activity' && entry.detail === 'false')
        expect(idleAt).toBeGreaterThan(completedAt)
        expect(inactiveAt).toBeGreaterThan(idleAt)
        // The completed turn carries the committed answer's text.
        expect(log[completedAt]!.detail).toBe(`answer msg_final_${t}`)
      }
    })
  }
})

describe('SessionSequencer contract', () => {
  it('re-emits activity while active and stops when the turn ends', () => {
    vi.useFakeTimers()
    const emitted: boolean[] = []
    const sequencer = new SessionSequencer({
      durable: () => null,
      heartbeatMs: 1000,
      sink: { entry: () => {}, semantic: () => {}, activity: a => emitted.push(a.active), requests: () => {} },
    })
    sequencer.onLiveOutputs([{ kind: 'activity', active: true, status: 'requesting' }])
    vi.advanceTimersByTime(3500)
    expect(emitted).toEqual([true, true, true, true])
    sequencer.onLiveOutputs([{ kind: 'activity', active: false, status: null }])
    vi.advanceTimersByTime(5000)
    expect(emitted).toEqual([true, true, true, true, false])
  })

  it('on exit drains and flushes, closes the open turn once, and then ignores the stream', () => {
    const { log, sequencer } = harness()
    const turnStart: LiveOutput[] = [
      { kind: 'turn-start', turnId: 't1' },
      { kind: 'activity', active: true, status: 'requesting' },
    ]
    sequencer.onLiveOutputs(turnStart)
    sequencer.onExit([
      { kind: 'durable-hint' },
      { kind: 'turn-end', turnId: 't1' },
      { kind: 'phase', phase: 'idle', turnId: 't1' },
      { kind: 'activity', active: false, status: null },
    ])
    const afterExit = log.length
    sequencer.onLiveOutputs(turnStart)
    expect(log.length).toBe(afterExit)
    const whats = log.map(entry => entry.what)
    expect(whats.slice(whats.indexOf('drain'))).toEqual(['drain', 'flush', 'ring', 'drain', 'flush', 'turn_completed', 'stream_phase', 'activity'])
    expect(log[log.length - 1]).toEqual({ what: 'activity', detail: 'false' })
  })

  it('never emits a second inactive activity when exit follows a completed turn', () => {
    const activity: boolean[] = []
    const sequencer = new SessionSequencer({
      durable: () => null,
      heartbeatMs: 0,
      sink: { entry: () => {}, semantic: () => {}, activity: a => activity.push(a.active), requests: () => {} },
    })
    sequencer.onLiveOutputs([{ kind: 'activity', active: true, status: 'x' }, { kind: 'activity', active: false, status: null }])
    sequencer.onExit([])
    expect(activity).toEqual([true, false])
  })
})

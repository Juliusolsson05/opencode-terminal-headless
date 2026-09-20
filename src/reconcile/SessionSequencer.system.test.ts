import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LiveStateProjector } from '../live/LiveStateProjector.js'
import { LiveFixtureWriter } from '../testing/fixtureDatabase.js'
import { sessionRowFor, settle, waitUntil } from '../testing/replay.js'
import { DurableReader } from '../transcript/DurableReader.js'
import { openOpencodeStore, OpencodeStoreError, type OpencodeStore } from '../transcript/OpencodeStore.js'
import { SessionSequencer, type SequencerExitOutcome } from './SessionSequencer.js'

// The sequencer wired to the REAL durable reader over a real SQLite file and
// the real projector, so the ordering claim is proven against the code that
// ships, not against a stub that commits on demand (review R1, "sequencer +
// real reader"). The rows and bus events are hand-authored from OpenCode's
// own write order for the cases no recording contains:
// - an abort or API error: SessionProcessor's `.catch(halt)` publishes
//   `session.status idle` (and `session.idle`) BEFORE `.ensuring(cleanup)`
//   writes the completion row with the error (sst/opencode@v1.18.30
//   packages/opencode/src/session/processor.ts; same order in the installed
//   1.18.30 binary; review R1-F2 probe G);
// - a busy database at the moment the turn ends (review R1-F5 probe C, R8-F3);
// - a busy database when the TUI exits (review R8-F3 `busy-exit`).
// Expected orders come from the rule in SessionSequencer's header, never from
// running the sequencer.

const S = 'ses_seq'
const T = 1000
const SETTLE_DEADLINE_MS = 300

const user = { id: 'msg_u', sessionID: S, role: 'user', time: { created: T }, agent: 'build', model: { providerID: 'p', modelID: 'm' } }
const userPart = { id: 'prt_u', messageID: 'msg_u', sessionID: S, type: 'text', text: 'do it' }
const assistant = (id: string, parentID: string, extra: Record<string, unknown> = {}) => ({
  id, sessionID: S, role: 'assistant', parentID, time: { created: T + 1 }, agent: 'build', mode: 'build', modelID: 'm', providerID: 'p',
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, path: { cwd: '/x', root: '/x' }, ...extra,
})
const textPart = (messageID: string, text: string) => ({ id: `prt_${messageID}_text`, messageID, sessionID: S, type: 'text', text })

let dir: string
let writer: LiveFixtureWriter | null
let store: OpencodeStore | null
let reader: DurableReader | null
let sequencer: SessionSequencer | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oth-seq-'))
  writer = store = reader = sequencer = null
})
afterEach(() => {
  sequencer?.dispose()
  reader?.stop()
  store?.release()
  // A test that takes a real lock releases it on a timer; unlock again so an
  // early failure inside the window cannot leave the file locked at close().
  try { writer?.unlock() } catch { /* not locked */ }
  writer?.close()
  rmSync(dir, { recursive: true, force: true })
})

function setUp(opts: { refuseReads?: () => boolean; journal?: 'wal' | 'delete'; afterRead?: () => void } = {}) {
  const file = join(dir, 'opencode.db')
  writer = new LiveFixtureWriter(file, S, sessionRowFor(S))
  // Journal mode is a property of the FILE, and switching it needs the only
  // connection, so it has to happen before the store under test opens it.
  // `delete` is what a test that takes a REAL `BEGIN EXCLUSIVE` needs: in WAL
  // a writer never refuses a reader that is already connected.
  if (opts.journal) writer.setJournalMode(opts.journal)
  const real = openOpencodeStore(file)
  store = real
  // A store whose reads are refused while `refuseReads()` says so: the
  // deterministic stand-in for SQLITE_BUSY (the translation of a real lock is
  // proven in OpencodeStore.system.test.ts and DurableReader.faults).
  // `afterRead` fires once each read transaction has COMMITTED, which is the
  // only way to place an event in the gap BETWEEN two of the exit drain's
  // transactions.
  const used: OpencodeStore = opts.refuseReads || opts.afterRead
    ? new Proxy(real, {
        get(target, key) {
          if (key === 'read') {
            return (fn: unknown) => {
              if (opts.refuseReads?.()) throw new OpencodeStoreError('busy', 'OpenCode store read: database busy')
              const value = target.read(fn as never)
              opts.afterRead?.()
              return value
            }
          }
          const value = Reflect.get(target, key) as unknown
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
        },
      })
    : real
  const order: string[] = []
  const errors: string[] = []
  const seq = new SessionSequencer({
    durable: () => reader,
    heartbeatMs: 0,
    now: () => 1,
    settleDeadlineMs: SETTLE_DEADLINE_MS,
    settleRecheckMs: 10,
    sink: {
      entry: r => order.push(`entry:${r.info.id}`),
      semantic: e => order.push(e.type === 'turn_completed' ? `turn_completed(${e.fullText})` : e.type === 'stream_phase' ? `phase:${e.phase}` : e.type),
      activity: a => order.push(`activity:${a.active}`),
      requests: () => order.push('requests'),
    },
  })
  sequencer = seq
  reader = new DurableReader({ store: used, sessionID: S, onRecords: r => seq.onDurableRecords(r), onError: e => errors.push(e.code) })
  reader.setLiveConnected(true)
  reader.start(-1)
  const projector = new LiveStateProjector(S, { now: () => 1 })
  const bus = (type: string, properties: Record<string, unknown>) => seq.onLiveOutputs(projector.apply({ type, properties }))
  const row = (type: string, data: Record<string, unknown>) => writer!.apply(type, data)
  // OpenCode commits the row, then publishes its bus twin (Stage 0).
  const both = (type: string, data: Record<string, unknown>) => {
    row(`${type}.1`, data)
    bus(type, data)
  }
  return { order, errors, bus, row, both, projector, sequencer: seq }
}

const indexOf = (order: string[], prefix: string) => order.findIndex(item => item.startsWith(prefix))

describe('SessionSequencer with the real reader over a real file', () => {
  it('an aborted turn: idle arrives before the completion row, and the answer still precedes turn_completed, with its partial text', async () => {
    const { order, errors, bus, both } = setUp()
    both('message.updated', { sessionID: S, info: user })
    both('message.part.updated', { sessionID: S, time: T, part: userPart })
    bus('session.status', { sessionID: S, status: { type: 'busy' } })
    both('message.updated', { sessionID: S, info: assistant('msg_a', 'msg_u') })
    both('message.part.updated', { sessionID: S, time: T + 2, part: textPart('msg_a', 'partial answer before abort') })
    await settle(0) // let the doorbell's microtask drain run
    // Esc: halt() publishes idle before cleanup() writes the completion.
    bus('session.status', { sessionID: S, status: { type: 'idle' } })
    bus('session.idle', { sessionID: S })
    expect(order.filter(item => item.startsWith('turn_completed'))).toEqual([])
    expect(order).toContain('entry:msg_u')
    // cleanup(): the completion row with the abort error, up to 250 ms later.
    both('message.updated', { sessionID: S, info: assistant('msg_a', 'msg_u', { time: { created: T + 1, completed: T + 50 }, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }) })
    bus('session.status', { sessionID: S, status: { type: 'idle' } }) // the runner's second idle
    await waitUntil(() => indexOf(order, 'turn_completed') >= 0, 2000, 'turn end after the completion row')
    expect(errors).toEqual([])
    const entryAt = order.indexOf('entry:msg_a')
    const completedAt = indexOf(order, 'turn_completed')
    expect(entryAt).toBeGreaterThanOrEqual(0)
    expect(entryAt).toBeLessThan(completedAt)
    expect(order.slice(completedAt)).toEqual(['turn_completed(partial answer before abort)', 'phase:idle', 'activity:false'])
  })

  it('a busy database at turn end: the turn end waits for the re-drain, so the answer still comes first', async () => {
    let refuse = false
    const { order, errors, bus, row } = setUp({ refuseReads: () => refuse })
    row('message.updated.1', { sessionID: S, info: user })
    row('message.part.updated.1', { sessionID: S, time: T, part: userPart })
    bus('session.status', { sessionID: S, status: { type: 'busy' } })
    row('message.updated.1', { sessionID: S, info: assistant('msg_a', 'msg_u', { time: { created: T + 1, completed: T + 5 }, finish: 'stop' }) })
    row('message.part.updated.1', { sessionID: S, time: T + 2, part: textPart('msg_a', 'answer') })
    refuse = true
    bus('session.status', { sessionID: S, status: { type: 'idle' } })
    bus('session.idle', { sessionID: S })
    // Negative window: nothing of the turn end may go out while unreadable.
    await settle(60)
    expect(order.some(item => item.startsWith('turn_completed') || item === 'activity:false' || item.startsWith('entry:'))).toBe(false)
    refuse = false
    await waitUntil(() => indexOf(order, 'turn_completed') >= 0, 2000, 'turn end after the database frees up')
    expect(errors).toEqual([])
    expect(order.slice(order.indexOf('entry:msg_u'))).toEqual(['entry:msg_u', 'entry:msg_a', 'turn_completed(answer)', 'phase:idle', 'activity:false'])
  })

  it('at the deadline the turn ends with the open assistant\'s partial text; its late entry follows, and later turns do not wait on it', async () => {
    const { order, bus, both, row } = setUp()
    both('message.updated', { sessionID: S, info: user })
    both('message.part.updated', { sessionID: S, time: T, part: userPart })
    bus('session.status', { sessionID: S, status: { type: 'busy' } })
    both('message.updated', { sessionID: S, info: assistant('msg_a', 'msg_u') })
    both('message.part.updated', { sessionID: S, time: T + 2, part: textPart('msg_a', 'partial') })
    await settle(0)
    bus('session.status', { sessionID: S, status: { type: 'idle' } })
    // The completion never comes (OpenCode died mid-cleanup, or is stuck on a snapshot patch).
    await waitUntil(() => indexOf(order, 'turn_completed') >= 0, SETTLE_DEADLINE_MS + 2000, 'the deadline')
    expect(order).not.toContain('entry:msg_a')
    expect(order.slice(indexOf(order, 'turn_completed'))).toEqual(['turn_completed(partial)', 'phase:idle', 'activity:false'])
    // The documented degraded order: if OpenCode does complete it later, the
    // entry lands after the turn end (it can still be committed only once).
    both('message.updated', { sessionID: S, info: assistant('msg_a', 'msg_u', { time: { created: T + 1, completed: T + 900 } }) })
    await waitUntil(() => order.includes('entry:msg_a'), 2000, 'late entry')
    expect(order.indexOf('entry:msg_a')).toBeGreaterThan(indexOf(order, 'turn_completed'))
    // A following ordinary turn settles at once: the abandoned assistant is
    // not waited on again, and the answer precedes its turn end.
    const user2 = { ...user, id: 'msg_u2', time: { created: T + 1000 } }
    row('message.updated.1', { sessionID: S, info: user2 })
    row('message.part.updated.1', { sessionID: S, time: T + 1000, part: { ...userPart, id: 'prt_u2', messageID: 'msg_u2' } })
    bus('session.status', { sessionID: S, status: { type: 'busy' } })
    row('message.updated.1', { sessionID: S, info: assistant('msg_a2', 'msg_u2', { time: { created: T + 1001, completed: T + 1005 }, finish: 'stop' }) })
    row('message.part.updated.1', { sessionID: S, time: T + 1002, part: textPart('msg_a2', 'second') })
    const before = order.length
    bus('session.status', { sessionID: S, status: { type: 'idle' } })
    // Synchronous: no deadline, no re-check.
    expect(order.slice(before)).toEqual(['entry:msg_u2', 'entry:msg_a2', 'turn_completed(second)', 'phase:idle', 'activity:false'])
  })

  it('exit with a busy database: the final drain retries before exit completes, and delivers the answer first', async () => {
    let refuse = false
    const { order, errors, bus, row, projector, sequencer: seq } = setUp({ refuseReads: () => refuse })
    row('message.updated.1', { sessionID: S, info: user })
    row('message.part.updated.1', { sessionID: S, time: T, part: userPart })
    bus('session.status', { sessionID: S, status: { type: 'busy' } })
    row('message.updated.1', { sessionID: S, info: assistant('msg_a', 'msg_u', { time: { created: T + 1, completed: T + 5 }, finish: 'stop' }) })
    row('message.part.updated.1', { sessionID: S, time: T + 2, part: textPart('msg_a', 'answer') })
    refuse = true
    const outcomes: SequencerExitOutcome[] = []
    seq.onExit(projector.endForExit(), outcome => outcomes.push(outcome))
    await settle(60)
    expect(outcomes).toEqual([])
    expect(order.some(item => item.startsWith('entry:') || item.startsWith('turn_completed'))).toBe(false)
    refuse = false
    await waitUntil(() => outcomes.length > 0, 2000, 'exit drain to finish')
    expect(outcomes).toEqual([{ complete: true }])
    expect(errors).toEqual([])
    expect(order.slice(order.indexOf('entry:msg_u'))).toEqual(['entry:msg_u', 'entry:msg_a', 'turn_completed(answer)', 'phase:idle', 'activity:false'])
  })

  it('exit with a REAL lock taken between the drain and the pending-user flush: the prompt is still committed', async () => {
    // #910 item 1, reproduced the way the verifier did: a real `BEGIN
    // EXCLUSIVE` in the gap between the exit drain's transaction and the
    // pending-user flush's, not a thrown stand-in. The retry loop used to
    // watch only the drain, so this closed the session at once, and the host
    // tears the reader down in that callback — the owed flush never ran and
    // the user's last prompt was gone.
    let armLock = false
    const { order, errors, bus, row, projector, sequencer: seq } = setUp({
      journal: 'delete',
      afterRead: () => {
        if (!armLock) return
        armLock = false
        writer!.lock()
        // Released on the next macrotask: the attempt running now meets the
        // lock, every retry after it does not. So a loop that retries at all
        // recovers, and one that does not cannot.
        setTimeout(() => writer!.unlock(), 0)
      },
    })
    // An answered turn (drained and delivered normally) followed by a prompt
    // with no answer, which the assembler holds pending until the flush.
    row('message.updated.1', { sessionID: S, info: user })
    row('message.part.updated.1', { sessionID: S, time: T, part: userPart })
    row('message.updated.1', { sessionID: S, info: assistant('msg_a', 'msg_u', { time: { created: T + 1, completed: T + 5 }, finish: 'stop' }) })
    row('message.part.updated.1', { sessionID: S, time: T + 2, part: textPart('msg_a', 'answer') })
    const user2 = { ...user, id: 'msg_u2', time: { created: T + 100 } }
    row('message.updated.1', { sessionID: S, info: user2 })
    row('message.part.updated.1', { sessionID: S, time: T + 100, part: { ...userPart, id: 'prt_u2', messageID: 'msg_u2' } })
    bus('session.status', { sessionID: S, status: { type: 'busy' } })

    const outcomes: SequencerExitOutcome[] = []
    armLock = true
    seq.onExit(projector.endForExit(), outcome => outcomes.push(outcome))
    // Positive control for where the lock landed: the drain itself got
    // through, synchronously, before the lock existed. Had the lock landed
    // earlier the drain would have deferred, and the old loop — which watched
    // exactly that — would have covered the case, proving nothing.
    expect(order).toContain('entry:msg_a')
    expect(outcomes).toEqual([])

    await waitUntil(() => outcomes.length > 0, SETTLE_DEADLINE_MS + 2000, 'the exit drain to finish')
    expect(outcomes).toEqual([{ complete: true }])
    expect(order).toContain('entry:msg_u2')
    expect(errors).toEqual([])
  })

  it('exit with a database that stays busy: reports the drain incomplete at the deadline instead of dropping records in silence', async () => {
    const { order, bus, row, projector, sequencer: seq } = setUp({ refuseReads: () => true })
    row('message.updated.1', { sessionID: S, info: user })
    bus('session.status', { sessionID: S, status: { type: 'busy' } })
    const outcomes: SequencerExitOutcome[] = []
    seq.onExit(projector.endForExit(), outcome => outcomes.push(outcome))
    await waitUntil(() => outcomes.length > 0, SETTLE_DEADLINE_MS + 2000, 'the exit deadline')
    expect(outcomes[0]!.complete).toBe(false)
    expect((outcomes[0] as { detail: string }).detail).toContain('busy')
    expect(order.some(item => item.startsWith('entry:'))).toBe(false)
    // The pane must not stay busy after its process died.
    expect(order.slice(-3)).toEqual(['turn_completed()', 'phase:idle', 'activity:false'])
  })
})

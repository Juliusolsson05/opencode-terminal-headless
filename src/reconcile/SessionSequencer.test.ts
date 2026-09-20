import { afterEach, describe, expect, it, vi } from 'vitest'

import { LiveStateProjector } from '../live/LiveStateProjector.js'
import type { LiveOutput } from '../live/types.js'
import { listLiveFixtures, loadLiveFixture } from '../testing/fixtures.js'
import type { DrainResult, DrainStatus } from '../transcript/DurableReader.js'
import type { OpencodeMessageRecord } from '../transcript/records.js'
import { SessionSequencer, type SequencerDurable, type SequencerExitOutcome } from './SessionSequencer.js'

// The sequencer's one cross-source rule is ordering. These tests feed it the
// projector's outputs for real recordings and a durable stub that "commits" a
// record whenever it is drained, then check the order consumers observe.
//
// The stub can also refuse (busy), report an open or held assistant, or throw
// from a sink, which are the cases no recording contains; those expectations
// are hand-authored from the rule in the sequencer's header. The same rules
// are proven against the real reader over a real file in
// SessionSequencer.system.test.ts.

afterEach(() => {
  vi.useRealTimers()
})

type Logged = { what: string; detail?: string }

const record = (id: string, text = `answer ${id}`): OpencodeMessageRecord => ({
  info: { id, sessionID: 'ses_x', role: 'assistant', time: { created: 1, completed: 2 } },
  parts: [{ id: `${id}_p`, messageID: id, sessionID: 'ses_x', type: 'text', text }],
})

// WHY the stub can be busy per OPERATION rather than as a whole: the exit
// drain runs three transactions (drain, settle, flush) and the database can
// go BUSY between any two of them — OpenCode's own writer takes the lock
// while the TUI is shutting down. `setBusy(true)` still means all three, so
// every older test reads the same; `setBusy({ flush: true })` is the window
// #910 item 1 names, where the drain got through and the flush did not.
type BusyOps = { drain: boolean; settle: boolean; flush: boolean }

function harness(opts: { settleDeadlineMs?: number; settleRecheckMs?: number; throwingSink?: 'entry'; now?: () => number; onSinkError?: (error: unknown) => void } = {}) {
  const log: Logged[] = []
  let pending: OpencodeMessageRecord[] = []
  let held: OpencodeMessageRecord[] = []
  let busy: BusyOps = { drain: false, settle: false, flush: false }
  // A channel the reader has permanently failed (a non-busy read error). It
  // has already reported through onError and will never read again.
  let failed = false
  let settleOverride: { status: DrainStatus; openAssistant?: OpencodeMessageRecord | null } | null = null
  let open: OpencodeMessageRecord | null = null
  let sequencer!: SessionSequencer
  const result = (records: OpencodeMessageRecord[], op: keyof BusyOps): DrainResult => (busy[op] ? { status: 'deferred', records: [] } : { status: 'complete', records })
  const durable: SequencerDurable = {
    ring: () => log.push({ what: 'ring' }),
    drainNow: () => {
      log.push({ what: 'drain' })
      if (failed) return { status: 'failed', records: [] }
      if (busy.drain) return result([], 'drain')
      const batch = pending
      pending = []
      sequencer.onDurableRecords(batch)
      return result(batch, 'drain')
    },
    flushPendingUsers: () => {
      log.push({ what: 'flush' })
      return result([], 'flush')
    },
    hasOpenAssistant: () => open !== null,
    hasHeldAssistants: () => held.length > 0,
    settleOpenWork: () => {
      log.push({ what: 'settle' })
      // The real reader abandons open assistants whenever its READ succeeded,
      // so it can hand one back on a path that still reports `deferred` (its
      // delivery was refused). `settleOverride` stages that, and the terminal
      // `failed` status, which no busy flag can express.
      if (settleOverride) return { ...settleOverride, openAssistant: settleOverride.openAssistant ?? null }
      if (busy.settle) return { status: 'deferred', openAssistant: null }
      const released = held
      held = []
      sequencer.onDurableRecords(released)
      const openAssistant = open
      open = null
      return { status: 'complete', openAssistant }
    },
  }
  sequencer = new SessionSequencer({
    durable: () => durable,
    now: opts.now ?? (() => 1),
    heartbeatMs: 0,
    settleDeadlineMs: opts.settleDeadlineMs,
    settleRecheckMs: opts.settleRecheckMs,
    onSinkError: opts.onSinkError,
    sink: {
      entry: r => {
        if (opts.throwingSink === 'entry') throw new Error(`host listener threw on ${r.info.id}`)
        log.push({ what: 'entry', detail: r.info.id })
      },
      semantic: e => log.push({ what: e.type, detail: e.type === 'stream_phase' ? e.phase : e.type === 'turn_completed' ? e.fullText : e.type === 'turn_started' ? e.turnId : e.type === 'api_error' ? e.errorType : undefined }),
      activity: a => log.push({ what: 'activity', detail: String(a.active) }),
      requests: () => log.push({ what: 'requests' }),
    },
  })
  return {
    log,
    sequencer,
    whats: () => log.map(entry => entry.what),
    commitLater: (id: string) => pending.push(record(id)),
    holdLater: (id: string) => held.push(record(id)),
    setBusy: (value: boolean | Partial<BusyOps>) => {
      busy = typeof value === 'boolean' ? { drain: value, settle: value, flush: value } : { ...busy, ...value }
    },
    setOpen: (value: OpencodeMessageRecord | null) => { open = value },
    setFailed: (value: boolean) => { failed = value },
    setSettleResult: (value: { status: DrainStatus; openAssistant?: OpencodeMessageRecord | null } | null) => { settleOverride = value },
  }
}

const turnEnd = (turnId: string): LiveOutput[] => [
  { kind: 'durable-hint' },
  { kind: 'turn-end', turnId },
  { kind: 'phase', phase: 'idle', turnId },
  { kind: 'activity', active: false, status: null },
]
const turnStart = (turnId: string): LiveOutput[] => [
  { kind: 'turn-start', turnId },
  { kind: 'phase', phase: 'requesting', turnId },
  { kind: 'activity', active: true, status: 'requesting' },
]
const TURN_END_TAIL = ['turn_completed', 'stream_phase', 'activity']
// The stub logs the sequencer's durable calls (drain, flush, ring, settle)
// between the events consumers receive. Orders consumers observe are compared
// on what they actually receive; the calls are pinned where they matter.
const DURABLE_CALLS = new Set(['drain', 'flush', 'ring', 'settle'])
const seen = (log: Logged[]) => log.filter(entry => !DURABLE_CALLS.has(entry.what))
const seenAfter = (log: Logged[], what: string, detail: string) => {
  const shown = seen(log)
  const at = shown.findIndex(entry => entry.what === what && entry.detail === detail)
  return at < 0 ? null : shown.slice(at + 1).map(entry => entry.what)
}

describe('SessionSequencer api errors', () => {
  it('passes the error name through, so a consumer can tell a user abort from a provider failure (Agent Code #1018)', () => {
    const { log, sequencer } = harness()
    sequencer.onLiveOutputs([{ kind: 'api-error', message: 'Aborted', turnId: null, errorType: 'MessageAbortedError' }])
    expect(seen(log)).toContainEqual({ what: 'api_error', detail: 'MessageAbortedError' })
  })
})

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

  it('on exit drains, settles and flushes, closes the open turn once, and then ignores the stream', () => {
    const { log, sequencer, whats } = harness()
    sequencer.onLiveOutputs(turnStart('t1'))
    const outcomes: SequencerExitOutcome[] = []
    sequencer.onExit(turnEnd('t1'), outcome => outcomes.push(outcome))
    const afterExit = log.length
    sequencer.onLiveOutputs(turnStart('t2'))
    expect(log.length).toBe(afterExit)
    const order = whats()
    expect(order.slice(order.indexOf('drain'))).toEqual(['drain', 'settle', 'flush', ...TURN_END_TAIL])
    expect(log[log.length - 1]).toEqual({ what: 'activity', detail: 'false' })
    expect(outcomes).toEqual([{ complete: true }])
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

  it('a throwing entry sink cannot stop the turn from closing for the other sinks (review R1-F4)', () => {
    const errors: unknown[] = []
    const { sequencer, whats, commitLater } = harness({ throwingSink: 'entry', onSinkError: error => errors.push(error) })
    sequencer.onLiveOutputs(turnStart('t1'))
    commitLater('msg_a')
    // Nothing escapes: the throw is routed to onSinkError, and turn_completed,
    // idle and inactive still reach the semantic and activity sinks.
    expect(() => sequencer.onLiveOutputs(turnEnd('t1'))).not.toThrow()
    expect(whats().slice(-3)).toEqual(TURN_END_TAIL)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('host listener threw on msg_a')
  })

  it('holds the turn end while the drain is deferred (busy), and releases it on the re-drain that completes (review R1-F5, R8-F3)', () => {
    vi.useFakeTimers()
    const { log, sequencer, whats, commitLater, setBusy } = harness({ settleDeadlineMs: 2000, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    setBusy(true)
    sequencer.onLiveOutputs(turnEnd('t1'))
    // Nothing of the turn end went out: the answer is not readable yet.
    expect(whats()).not.toContain('turn_completed')
    expect(sequencer.currentActivity().active).toBe(true)
    setBusy(false)
    commitLater('msg_a')
    vi.advanceTimersByTime(25)
    expect(seenAfter(log, 'entry', 'msg_a')).toEqual(TURN_END_TAIL)
    // Unanswered prompts are flushed after the drain and before the turn end.
    expect(whats().slice(whats().lastIndexOf('entry'))).toEqual(['entry', 'flush', ...TURN_END_TAIL])
    expect(log.find(entry => entry.what === 'turn_completed')!.detail).toBe('answer msg_a')
    expect(sequencer.currentActivity().active).toBe(false)
  })

  it('holds the turn end while an assistant is still open in the projection (an abort: idle before the completion row; review R1-F2)', () => {
    vi.useFakeTimers()
    const { log, sequencer, whats, commitLater, setOpen } = harness({ settleDeadlineMs: 2000, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    setOpen(record('msg_a', 'partial'))
    sequencer.onLiveOutputs(turnEnd('t1'))
    expect(whats()).not.toContain('turn_completed')
    // cleanup() writes the completion row a moment later.
    setOpen(null)
    commitLater('msg_a')
    vi.advanceTimersByTime(25)
    expect(seenAfter(log, 'entry', 'msg_a')).toEqual(TURN_END_TAIL)
    expect(log.find(entry => entry.what === 'turn_completed')!.detail).toBe('answer msg_a')
  })

  it('at the deadline ends the turn anyway, with the open assistant\'s partial text, and stops waiting on it for later turns', () => {
    vi.useFakeTimers()
    const { log, sequencer, whats, commitLater, setOpen } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    setOpen(record('msg_a', 'partial answer before abort'))
    sequencer.onLiveOutputs(turnEnd('t1'))
    vi.advanceTimersByTime(199)
    expect(whats()).not.toContain('turn_completed')
    vi.advanceTimersByTime(1)
    expect(whats().slice(-3)).toEqual(TURN_END_TAIL)
    expect(log.find(entry => entry.what === 'turn_completed')!.detail).toBe('partial answer before abort')
    // The next turn does not wait on the abandoned assistant.
    sequencer.onLiveOutputs(turnStart('t2'))
    commitLater('msg_b')
    sequencer.onLiveOutputs(turnEnd('t2'))
    expect(seen(log).map(entry => entry.what).slice(-4)).toEqual(['entry', ...TURN_END_TAIL])
  })

  it('hands held assistants over before the turn end at the deadline', () => {
    vi.useFakeTimers()
    const { log, sequencer, whats, holdLater } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    holdLater('msg_shell')
    sequencer.onLiveOutputs(turnEnd('t1'))
    expect(whats()).not.toContain('turn_completed')
    vi.advanceTimersByTime(200)
    expect(seenAfter(log, 'entry', 'msg_shell')).toEqual(TURN_END_TAIL)
    expect(log.find(entry => entry.what === 'turn_completed')!.detail).toBe('answer msg_shell')
  })

  it('never reorders a later turn around a waiting turn end', () => {
    vi.useFakeTimers()
    const { log, sequencer, commitLater, setBusy } = harness({ settleDeadlineMs: 2000, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    setBusy(true)
    sequencer.onLiveOutputs(turnEnd('t1'))
    sequencer.onLiveOutputs(turnStart('t2'))
    sequencer.onLiveOutputs([{ kind: 'requests', permission: null, question: null }])
    expect(log.some(entry => entry.what === 'turn_started' && entry.detail === 't2')).toBe(false)
    setBusy(false)
    commitLater('msg_a')
    vi.advanceTimersByTime(25)
    const shown = seen(log)
    const tail = shown.slice(shown.findIndex(entry => entry.what === 'entry')).map(entry => entry.detail ?? entry.what)
    expect(tail).toEqual(['msg_a', 'answer msg_a', 'idle', 'false', 't2', 'requesting', 'true', 'requests'])
  })

  it('on exit keeps retrying a deferred drain up to the deadline, then reports it incomplete', () => {
    vi.useFakeTimers()
    const { log, sequencer, whats, commitLater, setBusy } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    setBusy(true)
    const outcomes: SequencerExitOutcome[] = []
    sequencer.onExit(turnEnd('t1'), outcome => outcomes.push(outcome))
    expect(outcomes).toEqual([])
    expect(whats()).not.toContain('turn_completed')
    // The database frees up: the next attempt delivers, closes and reports.
    setBusy(false)
    commitLater('msg_a')
    vi.advanceTimersByTime(25)
    expect(outcomes).toEqual([{ complete: true }])
    expect(seenAfter(log, 'entry', 'msg_a')).toEqual(TURN_END_TAIL)


    const stuck = harness({ settleDeadlineMs: 200, settleRecheckMs: 25 })
    stuck.sequencer.onLiveOutputs(turnStart('t1'))
    stuck.setBusy(true)
    const stuckOutcomes: SequencerExitOutcome[] = []
    stuck.sequencer.onExit(turnEnd('t1'), outcome => stuckOutcomes.push(outcome))
    vi.advanceTimersByTime(199)
    expect(stuckOutcomes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(stuckOutcomes).toHaveLength(1)
    expect(stuckOutcomes[0]!.complete).toBe(false)
    expect((stuckOutcomes[0] as { detail: string }).detail).toContain('busy')
    // The turn still closes: the pane must not stay busy after its process died.
    expect(stuck.whats().slice(-3)).toEqual(TURN_END_TAIL)
    expect(stuck.sequencer.currentActivity().active).toBe(false)
  })

  it('on exit retries an operation that defers AFTER the drain, and reports what it actually waited on', () => {
    vi.useFakeTimers()
    // #910 item 1. The exit drain is three transactions, and the retry loop
    // used to watch only the first: a database that went BUSY between the
    // drain and the pending-user flush closed the session immediately,
    // cancelled the owed flush (the host tears the reader down in this
    // callback) and lost the user's last prompt — while reporting a 2 s wait
    // that never happened.
    const { log, sequencer, whats, setBusy, setOpen } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    // An assistant the TUI never completed: the settle is the only thing that
    // reads its partial text, and it reads it once.
    setOpen(record('msg_a', 'partial answer'))
    setBusy({ flush: true })
    const outcomes: SequencerExitOutcome[] = []
    sequencer.onExit(turnEnd('t1'), outcome => outcomes.push(outcome))
    expect(outcomes).toEqual([])
    vi.advanceTimersByTime(25)
    expect(outcomes).toEqual([])
    setBusy({ flush: false })
    vi.advanceTimersByTime(25)
    expect(outcomes).toEqual([{ complete: true }])
    // The settle succeeded on the first attempt and is not repeated: it is
    // the irreversible half (it abandons open assistants), so running it
    // again on every retry would be both pointless and lossy — the second
    // pass would find nothing open and blank the degraded text below.
    expect(whats().filter(what => what === 'settle')).toHaveLength(1)
    expect(whats().filter(what => what === 'flush')).toHaveLength(3)
    // Read by the FIRST attempt, delivered by the turn end two retries later.
    expect(log.find(entry => entry.what === 'turn_completed')?.detail).toBe('partial answer')

    // A flush that never frees up: the deadline still closes the session, and
    // the diagnostic names the step that was stuck and the time really spent.
    // A fabricated one ("the log stayed unreadable for 200 ms") sends the next
    // investigator after a drain that in fact got through.
    // The clock is driven apart from the timers on purpose: a deadline timer
    // fires no EARLIER than its delay and, on a blocked event loop, much
    // later. The reported wait must be the time that really passed, which is
    // also what tells this apart from printing the configured deadline back.
    let clock = 0
    const stuck = harness({ settleDeadlineMs: 200, settleRecheckMs: 25, now: () => clock })
    stuck.sequencer.onLiveOutputs(turnStart('t1'))
    stuck.setBusy({ flush: true })
    const stuckOutcomes: SequencerExitOutcome[] = []
    stuck.sequencer.onExit(turnEnd('t1'), outcome => stuckOutcomes.push(outcome))
    vi.advanceTimersByTime(199)
    expect(stuckOutcomes).toEqual([])
    clock = 517
    vi.advanceTimersByTime(1)
    expect(stuckOutcomes).toHaveLength(1)
    const detail = (stuckOutcomes[0] as { detail: string }).detail
    expect(detail).toContain('busy')
    expect(detail).toContain('517 ms')
    expect(detail).not.toContain('200 ms')
    expect(detail).toContain('prompt')
    // The drain was never refused, so the diagnostic must not claim committed
    // messages are missing.
    expect(detail).not.toContain('committed messages')
    expect(stuck.whats().slice(-3)).toEqual(TURN_END_TAIL)
  })

  it('still reports an owed flush when the channel FAILS later in the window', () => {
    vi.useFakeTimers()
    // #5 review, finding 1. The stuck list used to be rebuilt from scratch on
    // every attempt, and a `failed` drain skips the settle/flush block
    // entirely — so a flush that deferred on attempt 1 simply vanished, and
    // the exit reported `{complete: true}` with the user's prompt gone. A
    // falsely clean exit is the exact failure mode #910 item 1 is about, and
    // the pre-PR code reported this one correctly.
    const { sequencer, setBusy, setFailed } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    setBusy({ flush: true })
    const outcomes: SequencerExitOutcome[] = []
    sequencer.onExit(turnEnd('t1'), outcome => outcomes.push(outcome))
    expect(outcomes).toEqual([])

    // The reader's own retry hits a non-busy read error and fails the channel.
    setFailed(true)
    vi.advanceTimersByTime(200)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.complete).toBe(false)
    expect((outcomes[0] as { detail: string }).detail).toContain('prompt')
  })

  it('reports nothing owed when the channel was dead from the start', () => {
    vi.useFakeTimers()
    // The other side of the same rule: a channel that failed before the exit
    // never owed anything. `failed` is terminal — the reader has already
    // reported through onError — so retrying it forever would hold the pane
    // open for a session that is already gone.
    const { sequencer, whats, setFailed } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    setFailed(true)
    const outcomes: SequencerExitOutcome[] = []
    sequencer.onExit(turnEnd('t1'), outcome => outcomes.push(outcome))
    expect(outcomes).toEqual([{ complete: true }])
    // And neither step was even attempted against a dead channel.
    expect(whats().filter(what => what === 'settle' || what === 'flush')).toEqual([])
  })

  it('names the DRAIN when the drain is what stayed busy', () => {
    vi.useFakeTimers()
    // `EXIT_STEPS.drain` was the one label no test asserted, so a mutation
    // that never named it survived the whole suite.
    const { sequencer, setBusy } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    setBusy({ drain: true })
    const outcomes: SequencerExitOutcome[] = []
    sequencer.onExit(turnEnd('t1'), outcome => outcomes.push(outcome))
    vi.advanceTimersByTime(200)
    expect((outcomes[0] as { detail: string }).detail).toContain('committed messages')
  })

  it('reports the time spent waiting, not the time on the clock', () => {
    vi.useFakeTimers()
    // The one clock-driven test started its clock at 0, so `startedAt` could
    // be replaced by the constant 0 and nothing noticed. A clock that is
    // already well past zero when the exit begins tells the two apart.
    let clock = 900_000
    const { sequencer, setBusy } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25, now: () => clock })
    sequencer.onLiveOutputs(turnStart('t1'))
    setBusy({ flush: true })
    const outcomes: SequencerExitOutcome[] = []
    sequencer.onExit(turnEnd('t1'), outcome => outcomes.push(outcome))
    vi.advanceTimersByTime(199)
    clock = 900_350
    vi.advanceTimersByTime(1)
    const detail = (outcomes[0] as { detail: string }).detail
    expect(detail).toContain('350 ms')
    expect(detail).not.toContain('900')
  })

  it('never reports a negative wait when the clock steps backwards', () => {
    vi.useFakeTimers()
    // NTP can step the wall clock back mid-window. "still busy -1500 ms" is
    // the same genre of fabricated diagnostic this change set out to remove.
    let clock = 900_000
    const { sequencer, setBusy } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25, now: () => clock })
    sequencer.onLiveOutputs(turnStart('t1'))
    setBusy({ flush: true })
    const outcomes: SequencerExitOutcome[] = []
    sequencer.onExit(turnEnd('t1'), outcome => outcomes.push(outcome))
    vi.advanceTimersByTime(199)
    clock = 898_500
    vi.advanceTimersByTime(1)
    expect((outcomes[0] as { detail: string }).detail).toContain('busy 0 ms')
  })

  it('drops the degraded partial once that assistant\'s completion row arrives', () => {
    vi.useFakeTimers()
    // #5 review, finding 2. The settle runs ONCE and froze its partial text,
    // while the drain keeps running for the rest of the window — so a
    // completion row landing mid-window was delivered as an entry and then
    // contradicted by `turn_completed.fullText`, which still carried the
    // partial. Agent Code's orchestration reads that field, so a child
    // agent's answer was reported truncated.
    const { log, sequencer, setBusy, setOpen, commitLater } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    setOpen(record('msg_a', 'partial ans'))
    setBusy({ flush: true })
    const outcomes: SequencerExitOutcome[] = []
    sequencer.onExit(turnEnd('t1'), outcome => outcomes.push(outcome))
    expect(outcomes).toEqual([])

    // OpenCode's cleanup finishes writing the completion row, and the next
    // re-drain picks it up.
    commitLater('msg_a')
    setBusy({ flush: false })
    vi.advanceTimersByTime(25)

    expect(outcomes).toEqual([{ complete: true }])
    expect(log.find(entry => entry.what === 'turn_completed')?.detail).toBe('answer msg_a')
  })

  it('treats a FAILED settle as terminal, not as something to keep waiting for', () => {
    vi.useFakeTimers()
    // #5 review, finding 5: this branch was untested in either direction.
    // `failed` means the reader has already reported through onError and will
    // never read again — retrying it would hold the pane open for a channel
    // that is gone, and reporting it stuck would tell the host a BUSY database
    // is still being waited on. Only `deferred` is worth another pass.
    const { sequencer, whats, setSettleResult } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    setSettleResult({ status: 'failed' })
    const outcomes: SequencerExitOutcome[] = []
    sequencer.onExit(turnEnd('t1'), outcome => outcomes.push(outcome))
    expect(outcomes).toEqual([{ complete: true }])
    expect(whats().filter(what => what === 'settle')).toHaveLength(1)
  })

  it('keeps the open assistant a DEFERRED settle handed back', () => {
    vi.useFakeTimers()
    // #5 review, finding 7. `settleOpenWork` does its irreversible work — it
    // abandons open assistants — whenever the READ succeeded, and can still
    // report `deferred` afterwards. Taking the assistant only on the
    // `complete` path throws away the one look we get at it, and the turn end
    // then reports an empty answer.
    const { log, sequencer, setSettleResult, setBusy } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    setSettleResult({ status: 'deferred', openAssistant: record('msg_a', 'partial ans') })
    setBusy({ flush: true })
    const outcomes: SequencerExitOutcome[] = []
    sequencer.onExit(turnEnd('t1'), outcome => outcomes.push(outcome))
    expect(outcomes).toEqual([])
    vi.advanceTimersByTime(200)
    expect(outcomes).toHaveLength(1)
    expect(log.find(entry => entry.what === 'turn_completed')?.detail).toBe('partial ans')
  })

  it('dispose during a wait emits nothing more and never calls the exit callback', () => {
    vi.useFakeTimers()
    const { log, sequencer, setBusy } = harness({ settleDeadlineMs: 200, settleRecheckMs: 25 })
    sequencer.onLiveOutputs(turnStart('t1'))
    setBusy(true)
    const outcomes: SequencerExitOutcome[] = []
    sequencer.onExit(turnEnd('t1'), outcome => outcomes.push(outcome))
    const before = log.length
    sequencer.dispose()
    setBusy(false)
    vi.advanceTimersByTime(1000)
    expect(log.length).toBe(before)
    expect(outcomes).toEqual([])
  })
})

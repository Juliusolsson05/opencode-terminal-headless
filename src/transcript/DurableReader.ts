// DurableReader — tails one session's durable event log and emits committed
// records. It owns the cursor, the wake-up policy and error containment; the
// commit rules live in CommittedAssembler and the SQL lives in OpencodeStore.
//
// Wake-up policy (research/census-2026-09-10.md, "durable row precedes bus
// event"):
// - While the live channel is connected, the reader never polls. The live
//   layer calls `ring()` when a bus event for this session arrives. The row is
//   already committed at that point, so one read sees it.
// - While the live channel is disconnected (before the TUI's server is up, or
//   after the port was lost), a 1 s poll compares the session's sequence head
//   (a primary-key lookup, microseconds) with the cursor.
// - `drainNow()` is synchronous and says whether it finished: `complete`,
//   `deferred` (a retry is already scheduled: the database was busy, or the
//   sink threw and the batch is kept for redelivery) or `failed` (the channel
//   is disabled for good). The sequencer drains at turn end and must know the
//   difference: only a complete drain proves the final answer has been
//   handed over before it lets `turn_completed` and idle go out.
//
// Error containment:
// - A busy database is retried 100 ms later, and so is a busy read of the
//   starting cursor and a busy turn-end flush.
// - A version the reader does not understand, or any other read failure,
//   disables the durable channel for this session and reports why.
//   Continuing would emit a transcript with silent holes.
// - A sink that throws loses nothing: the batch is kept, redelivered first on
//   the next wake-up (at-least-once: a sink that threw half way through a
//   batch sees its first records again, and consumers key on message ids),
//   and reported once per failure streak as a non-fatal `sink_failed`.
// - Nothing escapes `drainNow`, `flushPendingUsers` or `ring`. `ring` runs
//   its drain from a microtask, where a throw would be an uncaught exception
//   in the host's main process; the timer callbacks are the same.

import { CommittedAssembler, DurableEventVersionError } from './CommittedAssembler.js'
import { OpencodeStoreError, type OpencodeStore } from './OpencodeStore.js'
import type { OpencodeMessageRecord } from './records.js'

export type DurableReaderErrorCode = 'event_version_unsupported' | 'read_failed' | 'sink_failed'

export class DurableReaderError extends Error {
  /** False only for `sink_failed`: the channel keeps reading and redelivers. */
  readonly fatal: boolean
  constructor(readonly code: DurableReaderErrorCode, message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'DurableReaderError'
    this.fatal = code !== 'sink_failed'
  }
}

export type DrainStatus = 'complete' | 'deferred' | 'failed'

/** What one drain or flush did. `records` are the ones it read, in order. */
export type DrainResult = { status: DrainStatus; records: OpencodeMessageRecord[] }

export type DurableReaderOptions = {
  store: OpencodeStore
  sessionID: string
  onRecords: (records: OpencodeMessageRecord[]) => void
  onError: (error: DurableReaderError) => void
  pollIntervalMs?: number
  batchSize?: number
}

// WHY 100 ms between retries: BUSY beside a live writer lasts as long as one
// write transaction or a WAL checkpoint (milliseconds), and a turn-end drain
// that is waiting on it holds the pane's idle transition. 100 ms is well past
// one OpenCode transaction and short enough that a held turn end usually
// settles on the first retry; the sequencer bounds the total wait separately.
const RETRY_MS = 100

function isBusy(error: unknown): boolean {
  return error instanceof OpencodeStoreError && error.code === 'busy'
}

export class DurableReader {
  private readonly assembler = new CommittedAssembler()
  private readonly pollIntervalMs: number
  private readonly batchSize: number
  private cursor = -1
  // False until the starting cursor is read. Nothing may drain before then:
  // the -1 placeholder would replay the whole log.
  private positioned = false
  private started = false
  private stopped = false
  private failed = false
  private ringScheduled = false
  private liveConnected = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  // A full (turn-end) flush that has not completed; the retry performs it.
  private flushOwed = false
  // Records a throwing sink did not take, oldest first; delivered before
  // anything newer so the committed stream keeps its order.
  private undelivered: OpencodeMessageRecord[] = []
  private sinkFailing = false
  // The cursor at the previous poll tick; see pollTick.
  private previousPollCursor: number | null = null

  constructor(private readonly options: DurableReaderOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000
    // WHY 500 events per read: one read transaction holds a WAL snapshot, and
    // OpenCode's writer cannot checkpoint past a reader's mark, so a drain
    // after a long disconnect must not hold one snapshot across thousands of
    // rows. Payloads are only fetched for the consumed types (a few hundred
    // bytes each; part updates come back as names only), so 500 rows are well
    // under a megabyte and a few milliseconds. The loop reads batch after
    // batch until one comes back short; correctness does not depend on the
    // size (the tail tests run every recording at 8).
    this.batchSize = options.batchSize ?? 500
  }

  /**
   * Begin tailing after `fromSeq`, or after the current head when omitted.
   *
   * WHY the default is the current head, not the start of the log: history is
   * the projection's job (import-seeded messages never enter the log), and the
   * host loads it separately. Replaying the whole log here would duplicate that
   * work and emit thousands of records during pane startup.
   */
  start(fromSeq?: number): void {
    if (this.started || this.stopped) return
    this.started = true
    this.position(fromSeq)
  }

  // WHY a busy cursor read is retried rather than failed: BUSY is transient
  // beside a live writer (another OpenCode process recovering the WAL while
  // this pane opens, most plausibly during a restore of many panes), and
  // failing here disabled the pane's committed stream for its whole life.
  //
  // Which case this covers, and the gap it leaves (review R1-F8): the retry
  // reads the head as of its own moment, so anything committed during the
  // wait is neither tailed here nor, if the host loaded history before it,
  // in that history. For a FRESH pane the window is empty: the TUI has not
  // been given a prompt yet. For a pane RESUMING a session that another
  // OpenCode process is writing at that moment (a second TUI on the same
  // session), messages committed between the host's history load and the
  // retried positioning are in neither until the host reloads history. The
  // package cannot position before the host loads, and nothing drives that
  // case today, so it stays a documented gap rather than a mechanism.
  private position(fromSeq: number | undefined): void {
    if (this.stopped || this.failed) return
    try {
      if (fromSeq !== undefined) this.cursor = fromSeq
      else {
        // WHY one snapshot for the head and its history-owned ids: reading
        // them separately can suppress an answer committed between the reads,
        // or re-emit an old prompt whose summary is rewritten after startup.
        // Explicit fromSeq is replay mode and intentionally skips this seed.
        const head = this.options.store.read(tx => ({
          cursor: tx.cursor(this.options.sessionID),
          ids: tx.historyMessageIDs(this.options.sessionID),
        }))
        this.assembler.seedCommitted(head.ids)
        this.cursor = head.cursor
      }
    } catch (error) {
      if (isBusy(error)) this.scheduleRetry(() => this.position(fromSeq))
      else this.fail(error)
      return
    }
    this.positioned = true
    this.previousPollCursor = this.cursor
    if (!this.liveConnected) this.startPoll()
  }

  /** Coalesced wake-up: many bus events in one tick cause one read. */
  ring(): void {
    if (!this.positioned || this.stopped || this.failed || this.ringScheduled) return
    this.ringScheduled = true
    queueMicrotask(() => {
      this.ringScheduled = false
      this.drainNow()
    })
  }

  /** Read everything after the cursor now, hand it to the sink, and say whether that finished. */
  drainNow(): DrainResult {
    if (this.stopped || this.failed) return { status: 'failed', records: [] }
    // Not positioned yet means a busy cursor read is being retried.
    if (!this.positioned) return { status: 'deferred', records: [] }
    const sessionID = this.options.sessionID
    // Collected outside the transaction callback so records committed before
    // a later event throws are still delivered: the assembler has already
    // marked them committed and will never produce them again.
    const read: OpencodeMessageRecord[] = []
    let failure: unknown = null
    try {
      for (;;) {
        let count = 0
        this.options.store.read(tx => {
          const events = tx.eventsAfter(sessionID, this.cursor, this.batchSize)
          count = events.length
          for (const event of events) {
            read.push(...this.assembler.apply(event, id => tx.loadMessage(sessionID, id)))
            // Advance per event so a version error leaves the cursor on the
            // last event that was understood.
            this.cursor = event.seq
          }
        })
        if (count < this.batchSize) break
      }
    } catch (error) {
      failure = error
    }
    return this.settle(read, failure)
  }

  /** Commit prompts still pending at turn end. Synchronous, like drainNow. */
  flushPendingUsers(): DrainResult {
    if (this.stopped || this.failed) return { status: 'failed', records: [] }
    if (!this.positioned) return { status: 'deferred', records: [] }
    const result = this.flush({})
    this.flushOwed = result.status === 'deferred'
    return result
  }

  /** An assistant of this session was seen without its completion. */
  hasOpenAssistant(): boolean {
    return this.assembler.hasOpenAssistant()
  }

  /** A completed assistant is waiting for its tool parts to settle. */
  hasHeldAssistants(): boolean {
    return this.assembler.hasHeldAssistants()
  }

  /**
   * Stop waiting: hand over held assistants as they stand, stop treating open
   * assistants as pending, and return the newest open one as the projection
   * has it now (partial text included), for a turn end that could not wait
   * longer. `deferred` means the database was busy and nothing changed.
   */
  settleOpenWork(): { status: DrainStatus; openAssistant: OpencodeMessageRecord | null } {
    if (this.stopped || this.failed) return { status: 'failed', openAssistant: null }
    if (!this.positioned) return { status: 'deferred', openAssistant: null }
    const sessionID = this.options.sessionID
    let read: OpencodeMessageRecord[] = []
    let openAssistant: OpencodeMessageRecord | null = null
    let failure: unknown = null
    try {
      this.options.store.read(tx => {
        const load = (id: string) => tx.loadMessage(sessionID, id)
        read = this.assembler.releaseHeld(load)
        const openID = this.assembler.newestOpenAssistant()
        openAssistant = openID ? load(openID) : null
      })
    } catch (error) {
      failure = error
    }
    if (failure === null) this.assembler.abandonOpenAssistants()
    return { status: this.settle(read, failure).status, openAssistant }
  }

  setLiveConnected(connected: boolean): void {
    this.liveConnected = connected
    if (!this.positioned || this.stopped || this.failed) return
    if (connected) {
      this.stopPoll()
      // Anything written while we were polling slowly is read immediately.
      this.ring()
    } else {
      this.previousPollCursor = this.cursor
      this.startPoll()
    }
  }

  getCursor(): number {
    return this.cursor
  }

  stop(): void {
    this.stopped = true
    this.stopPoll()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private flush(opts: { seenAtOrBefore?: number }): DrainResult {
    const sessionID = this.options.sessionID
    let read: OpencodeMessageRecord[] = []
    let failure: unknown = null
    try {
      read = this.options.store.read(tx => this.assembler.flushPendingUsers(id => tx.loadMessage(sessionID, id), opts))
    } catch (error) {
      failure = error
    }
    return this.settle(read, failure)
  }

  // Records first, then the failure: consumers must see everything that was
  // understood before they learn the channel stopped.
  private settle(read: OpencodeMessageRecord[], failure: unknown): DrainResult {
    const delivered = this.deliver(read)
    if (failure !== null) {
      if (isBusy(failure)) {
        this.scheduleRetry(() => this.wake())
        return { status: 'deferred', records: read }
      }
      this.fail(failure)
      return { status: 'failed', records: read }
    }
    if (!delivered) {
      this.scheduleRetry(() => this.wake())
      return { status: 'deferred', records: read }
    }
    return { status: 'complete', records: read }
  }

  private deliver(read: OpencodeMessageRecord[]): boolean {
    const batch = this.undelivered.length > 0 ? [...this.undelivered, ...read] : read
    if (batch.length === 0) return true
    try {
      this.options.onRecords(batch)
    } catch (error) {
      this.undelivered = batch
      if (!this.sinkFailing) {
        this.sinkFailing = true
        this.report(new DurableReaderError('sink_failed', `a committed-record sink threw; ${batch.length} record(s) kept for redelivery: ${error instanceof Error ? error.message : String(error)}`, error))
      }
      return false
    }
    this.undelivered = []
    this.sinkFailing = false
    return true
  }

  // The retry after BUSY or an undelivered batch: read on, and finish a
  // turn-end flush that did not complete.
  private wake(): void {
    this.drainNow()
    if (this.flushOwed) this.flushPendingUsers()
  }

  private startPoll(): void {
    if (this.pollTimer || this.stopped || this.failed) return
    this.pollTimer = setInterval(() => this.pollTick(), this.pollIntervalMs)
    // A poll must never keep a host process alive on its own.
    this.pollTimer.unref?.()
  }

  private pollTick(): void {
    try {
      if (this.options.store.cursor(this.options.sessionID) > this.cursor || this.undelivered.length > 0) this.drainNow()
    } catch (error) {
      if (!isBusy(error)) this.fail(error)
      return
    }
    if (this.stopped || this.failed) return
    // WHY the disconnected poll also flushes prompts (review R1-F9): with the
    // live channel down no turn ever ends, so a prompt that gets no answer
    // (aborted, or the model has not started) would wait for the next answer,
    // or for exit, before reaching the transcript. Flushed here only when no
    // assistant is open, because an open one will commit its prompt itself
    // and a prompt queued behind it must not overtake its answer. Only
    // prompts first seen at or before the PREVIOUS tick's cursor qualify:
    // OpenCode writes a prompt's parts one transaction each, and a flush is
    // final, so a prompt must have sat for a whole interval (by then every
    // part is in) before this commits it.
    if (this.previousPollCursor !== null && this.assembler.hasPendingUsers() && !this.assembler.hasOpenAssistant()) {
      this.flush({ seenAtOrBefore: this.previousPollCursor })
    }
    this.previousPollCursor = this.cursor
  }

  private stopPoll(): void {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private scheduleRetry(action: () => void): void {
    if (this.retryTimer || this.stopped || this.failed) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      action()
    }, RETRY_MS)
    this.retryTimer.unref?.()
  }

  private fail(error: unknown): void {
    if (this.failed) return
    this.failed = true
    this.stopPoll()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const wrapped =
      error instanceof DurableEventVersionError
        ? new DurableReaderError('event_version_unsupported', error.message, error)
        : new DurableReaderError('read_failed', error instanceof Error ? error.message : String(error), error)
    this.report(wrapped)
  }

  // WHY a throwing error callback is swallowed: it is the reader's last
  // reporting channel, and the callers (a microtask, a timer, the sequencer's
  // turn end) must not unwind. There is nowhere left to report to.
  private report(error: DurableReaderError): void {
    try {
      this.options.onError(error)
    } catch {
      /* see above */
    }
  }
}

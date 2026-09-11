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
// - `drainNow()` is synchronous. The sequencer calls it at turn end to flush
//   the final assistant BEFORE it emits idle — the ordering the renderer and
//   orchestration depend on.
//
// Error containment: a busy database is retried on the next wake-up. A
// version the reader does not understand, or any other read failure, disables
// the durable channel for this session and reports why. Continuing would emit
// a transcript with silent holes.

import { CommittedAssembler, DurableEventVersionError } from './CommittedAssembler.js'
import { OpencodeStoreError, type OpencodeStore } from './OpencodeStore.js'
import type { OpencodeMessageRecord } from './records.js'

export type DurableReaderErrorCode = 'event_version_unsupported' | 'read_failed'

export class DurableReaderError extends Error {
  constructor(readonly code: DurableReaderErrorCode, message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'DurableReaderError'
  }
}

export type DurableReaderOptions = {
  store: OpencodeStore
  sessionID: string
  onRecords: (records: OpencodeMessageRecord[]) => void
  onError: (error: DurableReaderError) => void
  pollIntervalMs?: number
  batchSize?: number
}

export class DurableReader {
  private readonly assembler = new CommittedAssembler()
  private readonly pollIntervalMs: number
  private readonly batchSize: number
  private cursor = -1
  private started = false
  private stopped = false
  private failed = false
  private ringScheduled = false
  private liveConnected = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: DurableReaderOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000
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
    try {
      this.cursor = fromSeq ?? this.options.store.cursor(this.options.sessionID)
    } catch (error) {
      this.fail(error)
      return
    }
    if (!this.liveConnected) this.startPoll()
  }

  /** Coalesced wake-up: many bus events in one tick cause one read. */
  ring(): void {
    if (!this.started || this.stopped || this.failed || this.ringScheduled) return
    this.ringScheduled = true
    queueMicrotask(() => {
      this.ringScheduled = false
      this.drainNow()
    })
  }

  /** Read everything after the cursor now, emit it, and return it. */
  drainNow(): OpencodeMessageRecord[] {
    if (!this.started || this.stopped || this.failed) return []
    const sessionID = this.options.sessionID
    // Collected outside the transaction callback so records committed before
    // a later event throws are still emitted: the assembler has already
    // marked them committed and will never produce them again.
    const emitted: OpencodeMessageRecord[] = []
    let failure: unknown = null
    try {
      for (;;) {
        let count = 0
        this.options.store.read(tx => {
          const events = tx.eventsAfter(sessionID, this.cursor, this.batchSize)
          count = events.length
          for (const event of events) {
            emitted.push(...this.assembler.apply(event, id => tx.loadMessage(sessionID, id)))
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
    // Records first, then the failure: consumers must see everything that was
    // understood before they learn the channel stopped.
    if (emitted.length > 0) this.options.onRecords(emitted)
    if (failure !== null) {
      if (failure instanceof OpencodeStoreError && failure.code === 'busy') this.scheduleRetry()
      else this.fail(failure)
    }
    return emitted
  }

  /** Commit prompts still pending at turn end. Synchronous, like drainNow. */
  flushPendingUsers(): OpencodeMessageRecord[] {
    if (!this.started || this.stopped || this.failed) return []
    const sessionID = this.options.sessionID
    let records: OpencodeMessageRecord[] = []
    try {
      records = this.options.store.read(tx => this.assembler.flushPendingUsers(id => tx.loadMessage(sessionID, id)))
    } catch (error) {
      if (!(error instanceof OpencodeStoreError && error.code === 'busy')) this.fail(error)
    }
    if (records.length > 0) this.options.onRecords(records)
    return records
  }

  setLiveConnected(connected: boolean): void {
    this.liveConnected = connected
    if (!this.started || this.stopped || this.failed) return
    if (connected) {
      this.stopPoll()
      // Anything written while we were polling slowly is read immediately.
      this.ring()
    } else {
      this.startPoll()
    }
  }

  getCursor(): number {
    return this.cursor
  }

  isFailed(): boolean {
    return this.failed
  }

  unknownEventNames(): ReadonlyMap<string, number> {
    return this.assembler.unknownEventNames()
  }

  stop(): void {
    this.stopped = true
    this.stopPoll()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private startPoll(): void {
    if (this.pollTimer || this.stopped || this.failed) return
    this.pollTimer = setInterval(() => {
      try {
        if (this.options.store.cursor(this.options.sessionID) > this.cursor) this.drainNow()
      } catch (error) {
        if (!(error instanceof OpencodeStoreError && error.code === 'busy')) this.fail(error)
      }
    }, this.pollIntervalMs)
    // A poll must never keep a host process alive on its own.
    this.pollTimer.unref?.()
  }

  private stopPoll(): void {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.drainNow()
    }, 100)
    this.retryTimer.unref?.()
  }

  private fail(error: unknown): void {
    if (this.failed) return
    this.failed = true
    this.stopPoll()
    const wrapped =
      error instanceof DurableEventVersionError
        ? new DurableReaderError('event_version_unsupported', error.message, error)
        : new DurableReaderError('read_failed', error instanceof Error ? error.message : String(error), error)
    this.options.onError(wrapped)
  }
}

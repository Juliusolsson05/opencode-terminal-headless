// SessionSequencer — THE isolated layer where OpenCode's two sources meet.
//
// It is the only module that sees both durable records (from transcript/) and
// live transitions (from live/). Its single consumer is
// OpencodeTerminalHeadless. Nothing else in the package — and nothing in Agent
// Code — may import it (docs/decomposition/opencode-terminal-headless.md,
// "What is being isolated").
//
// Ownership (one owner per signal, so there is nothing to arbitrate):
//   committed records  ← durable log only
//   turns, phases, activity, pending requests ← live server only
//
// The one cross-source rule, and the reason this layer exists at all: a turn
// end reaches consumers only AFTER the turn's committed answer. Agent Code's
// orchestration decides a child is "completed" from exactly that order
// (committed assistant entry, then a phase change to idle after the prompt
// was submitted), and `turn_completed.fullText` is read off the same answer.
//
// For an ordinary turn OpenCode commits a row before it publishes its bus
// event (Stage 0), so a synchronous drain at `idle` finds the answer and the
// turn ends at once. Three things break that, and each makes the turn end
// WAIT (it and every live output after it are held back, in order):
//   (a) the drain could not finish: the database was busy (review R1-F5,
//       R8-F3), or the sink threw and the batch is kept for redelivery;
//   (b) an assistant is still open in the projection: for an aborted or
//       failed turn OpenCode publishes idle from SessionProcessor.halt and
//       writes the completion row afterwards, in cleanup (R1-F2, R2-F5);
//   (c) a completed assistant is held because its tool part has not settled
//       yet (`!command` and subagent-command turns, R1-F1).
// The wait ends on the first re-drain that finds none of them, or at a
// bounded deadline. At the deadline the turn ends anyway, visibly degraded:
// held assistants are handed over as they stand, `fullText` comes from the
// projection's still-open assistant (its partial text), and that assistant's
// entry, if OpenCode ever completes it, arrives AFTER `turn_completed`. That
// late entry is the one documented exception to the order above.
//
// Later outputs are never reordered around a waiting turn end: a new turn's
// `turn_started` waits behind the old turn's `turn_completed`. Only the
// durable doorbell (`durable-hint`) is acted on at once, because it is what
// resolves the wait.
//
// Exit: the TUI is gone, so nothing will complete an open assistant or settle
// a held one. The final drain retries a busy database up to the same deadline;
// then held assistants are handed over, pending prompts flushed, and the open
// turn closed. If the drain never finished, the caller is told so it can
// report it instead of silently dropping records (`final_drain_incomplete`).
// All THREE of those transactions share that one retry window, and each is
// retried only while it is the one still deferring (#910 item 1): the drain
// alone used to own the loop, so a lock taken between it and the pending-user
// flush closed the session immediately — and the host tears the reader down in
// that callback, which cancelled the owed flush and lost the user's last
// prompt. The outcome's `detail` names the step that was actually stuck and
// the time actually spent waiting, never a deadline that was not reached.
//
// Sinks are isolated: one that throws cannot stop the turn from closing for
// the others (R1-F4). The error goes to `onSinkError`.

import type { SemanticEvent } from '../channels/types.js'
import type { LiveOutput, PendingPermission, PendingQuestion } from '../live/types.js'
import type { DrainResult, DrainStatus } from '../transcript/DurableReader.js'
import type { OpencodeMessageRecord } from '../transcript/records.js'

export type SequencerSink = {
  entry(record: OpencodeMessageRecord): void
  semantic(event: SemanticEvent): void
  activity(state: { active: boolean; status: string | null }): void
  requests(state: { permission: PendingPermission | null; question: PendingQuestion | null }): void
}

/** The durable reader operations the sequencer needs; null when the durable channel is disabled. */
export type SequencerDurable = {
  ring(): void
  drainNow(): DrainResult
  flushPendingUsers(): DrainResult
  hasOpenAssistant(): boolean
  hasHeldAssistants(): boolean
  settleOpenWork(): { status: DrainStatus; openAssistant: OpencodeMessageRecord | null }
}

export type SessionSequencerOptions = {
  sink: SequencerSink
  durable: () => SequencerDurable | null
  now?: () => number
  /**
   * While active, re-emit the current activity at this interval. Agent Code's
   * main process keeps no process-state cache, so a renderer that reloads or
   * re-adopts a pane mid-turn only learns "busy" from the next emission; Claude
   * and Codex re-emit about once a second for the same reason.
   */
  heartbeatMs?: number
  /** Longest a turn end (or the exit drain) waits for the durable channel. */
  settleDeadlineMs?: number
  /** How often a waiting turn end re-drains. */
  settleRecheckMs?: number
  /**
   * A sink threw. Without this, the error is rethrown on a microtask: a host
   * listener's bug stays as loud as an EventEmitter would make it, just no
   * longer in the middle of this state machine.
   */
  onSinkError?: (error: unknown) => void
}

/** How the exit drain ended. `complete: false` means records may be missing from the stream. */
export type SequencerExitOutcome = { complete: true } | { complete: false; detail: string }

// WHY 2 s: for an aborted or failed turn OpenCode publishes idle and writes
// the completion row afterwards, in SessionProcessor cleanup, which first
// waits for open tool calls (250 ms each, run concurrently, so about 250 ms
// in all), finalizes parts and, when the turn changed files, computes the
// snapshot patch, then writes `time.completed` (packages/opencode/src/
// session/processor.ts; the same order is in the 1.18.30 binary). The row
// normally lands within a few hundred milliseconds; the patch is the one
// unbounded step. 2 s covers the tool wait eight times over while keeping the
// worst case, a pane that reads busy after the TUI already shows idle, short
// enough that nobody retries the abort. BUSY (a WAL checkpoint, a second
// OpenCode opening the file) clears in milliseconds and fits the same bound.
const SETTLE_DEADLINE_MS = 2_000
// WHY 25 ms: a waiting turn end re-drains on its own instead of trusting the
// doorbell (the completion row's bus twin never comes if the stream dropped
// meanwhile). Each re-drain is one indexed read, so 80 of them over the
// whole deadline cost nothing, and 25 ms keeps the added latency invisible.
const SETTLE_RECHECK_MS = 25

// What the exit drain was still waiting on, and what the user loses for it.
// WHY name the step rather than say "the log was unreadable": the three
// transactions fail independently, and a diagnostic that blames the drain when
// the drain in fact got through sends the next investigator after the wrong
// one. A fabricated diagnostic is worse than none.
type ExitStep = 'drain' | 'settle' | 'flush'
const EXIT_STEPS: Record<ExitStep, string> = {
  drain: 'reading committed messages (they may be missing from the stream)',
  settle: 'handing over an assistant that never completed (its answer may be missing from the stream)',
  flush: 'committing a prompt that was still pending (that prompt may be missing from the stream)',
}

function exitDetail(stuck: readonly ExitStep[], waitedMs: number): string {
  return `the durable log was still busy ${waitedMs} ms after the TUI exited, on: ${stuck.map(step => EXIT_STEPS[step]).join('; ')}. The session's history on disk still has every committed row.`
}

function textOf(record: OpencodeMessageRecord): string {
  return record.parts
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('')
}

export class SessionSequencer {
  private readonly now: () => number
  private readonly heartbeatMs: number
  private readonly settleDeadlineMs: number
  private readonly settleRecheckMs: number
  private openTurn: { turnId: string; lastAssistantText: string } | null = null
  private activity: { active: boolean; status: string | null } = { active: false, status: null }
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private exited = false
  private disposed = false
  // The turn end that is waiting, and everything that arrived behind it.
  private settling: { turnId: string } | null = null
  private backlog: LiveOutput[] = []
  // The open assistant's partial text, held for the turn end that closes the
  // exit — and dropped the moment its own completion row arrives.
  private exitDegraded: { id: string; text: string } | null = null
  private recheckTimer: ReturnType<typeof setInterval> | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: SessionSequencerOptions) {
    this.now = options.now ?? Date.now
    this.heartbeatMs = options.heartbeatMs ?? 1000
    this.settleDeadlineMs = options.settleDeadlineMs ?? SETTLE_DEADLINE_MS
    this.settleRecheckMs = options.settleRecheckMs ?? SETTLE_RECHECK_MS
  }

  onDurableRecords(records: readonly OpencodeMessageRecord[]): void {
    for (const record of records) {
      if (this.openTurn && record.info.role === 'assistant') {
        const text = textOf(record)
        if (text) this.openTurn.lastAssistantText = text
      }
      // The exit's degraded text is a PARTIAL read of an assistant that had
      // not completed. If that very assistant's completion row then lands —
      // the exit drain keeps running for the rest of the window, and
      // OpenCode's cleanup can still be writing — the partial is no longer
      // the newest text the user saw, it is the oldest. Dropping it here lets
      // `completeTurn` fall back to `openTurn.lastAssistantText`, which this
      // loop has just updated with the complete answer (#5 review, finding 2:
      // orchestration reads `turn_completed.fullText`, so the alternative is
      // reporting a child agent's answer truncated).
      if (this.exitDegraded && record.info.id === this.exitDegraded.id) this.exitDegraded = null
      this.call(() => this.options.sink.entry(record))
    }
  }

  onLiveOutputs(outputs: readonly LiveOutput[]): void {
    if (this.exited) return
    for (const output of outputs) {
      if (output.kind === 'durable-hint') this.options.durable()?.ring()
      else if (this.settling) this.backlog.push(output)
      else this.handle(output)
    }
  }

  /**
   * The TUI process exited: commit whatever is readable (retrying a busy
   * database up to the deadline), close the open turn through the same path
   * a live idle would take, and go quiet. `done` runs once, synchronously
   * when nothing had to wait; it never runs if `dispose` comes first.
   */
  onExit(closingOutputs: readonly LiveOutput[], done: (outcome: SequencerExitOutcome) => void = () => {}): void {
    if (this.exited) return
    this.exited = true
    this.clearSettleTimers()
    const startedAt = this.now()
    // The settle is the irreversible half: it abandons open assistants and
    // hands over held ones. Once it has succeeded there is nothing left for it
    // to do, and re-running it would report no open assistant on the second
    // pass and silently drop the degraded text. Same for the flush: a
    // committed prompt is committed. So each is retried only while it is the
    // one still deferring.
    //
    // WHY three states and not a boolean (#5 review, finding 1): `pending`
    // means the channel never got far enough to owe us anything, `owed` means
    // a step deferred and has not since succeeded, `settled` means it will
    // never run again. Rebuilding the stuck list from THIS attempt alone lost
    // the middle one: a flush that deferred on attempt 1, followed by a drain
    // that reported `failed` on attempt 2 (the reader's own retry can fail the
    // channel mid-window), produced an empty list and reported
    // `{complete: true}` — while the user's prompt was gone. A falsely clean
    // exit is the exact failure mode #910 item 1 is about.
    type StepState = 'pending' | 'owed' | 'settled'
    let settleState: StepState = 'pending'
    let flushState: StepState = 'pending'
    const attempt = (final: boolean): boolean => {
      const durable = this.options.durable()
      const drain = durable ? durable.drainNow() : null
      const drainDeferred = drain?.status === 'deferred'
      // Nothing else may run yet: the settle would stop the wait we are still
      // willing to wait out.
      //
      // WHY this is NOT an equivalent mutant, as an earlier version of this
      // comment claimed (#5 review, finding 3): `OpencodeStore.read` opens a
      // DEFERRED transaction, so a settle or flush against an empty assembler
      // issues no statement and never meets the lock — it reports `complete`
      // and latches itself off for the rest of the window. Drop this line and
      // a lock held across the first attempt makes both steps latch against
      // nothing; the second attempt's drain then reads the prompt into the
      // assembler, and neither step ever runs again. #910 item 1, recreated,
      // and reported as a clean exit. There is a test.
      if (drainDeferred && !final) return false
      // A `failed` channel is terminal — the reader has already reported the
      // error through onError and will never read again — so only `deferred`
      // (the database was BUSY) is worth another pass.
      if (durable && drain?.status !== 'failed') {
        if (settleState !== 'settled') {
          const settled = durable.settleOpenWork()
          // `settleOpenWork` abandons open assistants whenever its READ
          // succeeded, even on a path that then reports deferred, so the
          // assistant it hands back is taken regardless of status — it is the
          // only chance to see it (#5 review, finding 7).
          if (settled.openAssistant) {
            this.exitDegraded = { id: settled.openAssistant.info.id, text: textOf(settled.openAssistant) }
          }
          settleState = settled.status === 'deferred' ? 'owed' : 'settled'
        }
        if (flushState !== 'settled') {
          flushState = durable.flushPendingUsers().status === 'deferred' ? 'owed' : 'settled'
        }
      }
      // WHY every step shares the one retry window (#910 item 1): the exit
      // drain is three separate transactions and the database can go BUSY
      // between any two of them — OpenCode's own writer takes the lock while
      // the TUI shuts down. Retrying only the first one meant a lock that
      // landed after it closed the session at once; the host tears the reader
      // down in this callback, so the owed flush never ran and the user's last
      // prompt was lost. The bound is unchanged: a stuck database must never
      // hold a session open forever.
      const stuck: ExitStep[] = []
      if (drainDeferred) stuck.push('drain')
      if (settleState === 'owed') stuck.push('settle')
      if (flushState === 'owed') stuck.push('flush')
      if (stuck.length > 0 && !final) return false
      this.clearSettleTimers()
      const degraded = this.exitDegraded?.text ?? ''
      this.exitDegraded = null
      this.closeForExit(closingOutputs, degraded)
      // Clamped: a deadline timer fires no earlier than its delay, but the
      // clock behind it can step backwards (NTP), and "still busy -1500 ms" is
      // the same genre of fabricated diagnostic this whole change removes.
      done(stuck.length === 0 ? { complete: true } : { complete: false, detail: exitDetail(stuck, Math.max(0, this.now() - startedAt)) })
      return true
    }
    if (attempt(false)) return
    this.recheckTimer = setInterval(() => {
      if (!this.disposed) attempt(false)
    }, this.settleRecheckMs)
    this.recheckTimer.unref?.()
    this.deadlineTimer = setTimeout(() => {
      if (!this.disposed) attempt(true)
    }, this.settleDeadlineMs)
    this.deadlineTimer.unref?.()
  }

  dispose(): void {
    this.exited = true
    this.disposed = true
    this.clearSettleTimers()
    this.stopHeartbeat()
  }

  currentActivity(): { active: boolean; status: string | null } {
    return this.activity
  }

  private handle(output: LiveOutput): void {
    const ts = this.now()
    switch (output.kind) {
      case 'durable-hint':
        this.options.durable()?.ring()
        return
      case 'turn-start':
        this.openTurn = { turnId: output.turnId, lastAssistantText: '' }
        this.call(() => this.options.sink.semantic({ type: 'turn_started', turnId: output.turnId, role: 'assistant', source: 'opencode-sse', confidence: 'high', ts }))
        return
      case 'turn-end': {
        const durable = this.options.durable()
        if (durable && this.mustWait(durable)) {
          this.settling = { turnId: output.turnId }
          this.armSettleTimers()
          return
        }
        this.completeTurn(output.turnId, '')
        return
      }
      case 'phase':
        this.call(() =>
          this.options.sink.semantic({
            type: 'stream_phase',
            turnId: output.turnId,
            phase: output.phase,
            ...(output.toolName ? { toolName: output.toolName } : {}),
            source: 'opencode-sse',
            ts,
          }),
        )
        return
      case 'activity':
        this.setActivity({ active: output.active, status: output.status })
        return
      case 'requests':
        this.call(() => this.options.sink.requests({ permission: output.permission, question: output.question }))
        return
      case 'api-error':
        this.call(() => this.options.sink.semantic({ type: 'api_error', turnId: output.turnId, message: output.message, ...(output.errorType ? { errorType: output.errorType } : {}), source: 'opencode-sse', ts }))
        return
    }
  }

  // Drain (records reach the sinks through onDurableRecords during the call),
  // flush unanswered prompts, and say whether the turn end must still wait.
  // A failed channel will never deliver more, so it is never waited on.
  private mustWait(durable: SequencerDurable): boolean {
    const drain = durable.drainNow()
    if (drain.status === 'failed') return false
    const flush = durable.flushPendingUsers()
    if (flush.status === 'failed') return false
    return drain.status === 'deferred' || flush.status === 'deferred' || durable.hasOpenAssistant() || durable.hasHeldAssistants()
  }

  private armSettleTimers(): void {
    this.recheckTimer = setInterval(() => this.recheck(), this.settleRecheckMs)
    this.recheckTimer.unref?.()
    this.deadlineTimer = setTimeout(() => this.settleDegraded(), this.settleDeadlineMs)
    this.deadlineTimer.unref?.()
  }

  private recheck(): void {
    if (!this.settling || this.disposed) return
    const durable = this.options.durable()
    if (durable && this.mustWait(durable)) return
    this.finishSettling('')
  }

  // The deadline: one last look, then end the turn with whatever there is.
  private settleDegraded(): void {
    if (!this.settling || this.disposed) return
    const durable = this.options.durable()
    let degradedText = ''
    if (durable) {
      durable.drainNow()
      const settled = durable.settleOpenWork()
      durable.flushPendingUsers()
      if (settled.openAssistant) degradedText = textOf(settled.openAssistant)
    }
    this.finishSettling(degradedText)
  }

  private finishSettling(degradedText: string): void {
    const turnId = this.settling!.turnId
    this.settling = null
    this.clearSettleTimers()
    this.completeTurn(turnId, degradedText)
    // Everything that arrived behind the turn end, in order. A later turn end
    // in the backlog may start waiting again; the rest stays behind it.
    while (!this.settling && this.backlog.length > 0) this.handle(this.backlog.shift()!)
  }

  // `degradedText` is the still-open assistant's partial text when the turn
  // could not wait for it: it is the newest text the user saw, so it wins.
  private completeTurn(turnId: string, degradedText: string): void {
    const own = this.openTurn?.turnId === turnId ? this.openTurn.lastAssistantText : ''
    const fullText = degradedText || own
    this.openTurn = null
    this.call(() => this.options.sink.semantic({ type: 'turn_completed', turnId, fullText, source: 'opencode-sse', confidence: 'high', ts: this.now() }))
  }

  private closeForExit(closingOutputs: readonly LiveOutput[], degradedText: string): void {
    const queue: LiveOutput[] = []
    if (this.settling) queue.push({ kind: 'turn-end', turnId: this.settling.turnId })
    queue.push(...this.backlog, ...closingOutputs)
    this.settling = null
    this.backlog = []
    // The open assistant, if any, belongs to the newest turn.
    const lastEnd = queue.map(output => output.kind).lastIndexOf('turn-end')
    queue.forEach((output, index) => {
      // The reader is about to stop; a wake-up now would read nothing new.
      if (output.kind === 'durable-hint') return
      if (output.kind === 'turn-end') this.completeTurn(output.turnId, index === lastEnd ? degradedText : '')
      else this.handle(output)
    })
    if (this.activity.active) this.setActivity({ active: false, status: null })
    this.stopHeartbeat()
  }

  private setActivity(next: { active: boolean; status: string | null }): void {
    this.activity = next
    this.call(() => this.options.sink.activity(next))
    if (next.active) this.startHeartbeat()
    else this.stopHeartbeat()
  }

  private startHeartbeat(): void {
    if (this.heartbeat || this.heartbeatMs <= 0) return
    this.heartbeat = setInterval(() => {
      if (this.activity.active && !this.exited) this.call(() => this.options.sink.activity(this.activity))
    }, this.heartbeatMs)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return
    clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private clearSettleTimers(): void {
    if (this.recheckTimer) clearInterval(this.recheckTimer)
    this.recheckTimer = null
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.deadlineTimer = null
  }

  private call(deliver: () => void): void {
    try {
      deliver()
    } catch (error) {
      if (!this.options.onSinkError) {
        queueMicrotask(() => {
          throw error
        })
        return
      }
      try {
        this.options.onSinkError(error)
      } catch {
        // The error reporter itself threw; there is nowhere left to report.
      }
    }
  }
}

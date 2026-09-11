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
// The one cross-source rule, and the reason this layer exists at all: when a
// live turn ends, the durable log is drained SYNCHRONOUSLY before the turn end
// reaches consumers. OpenCode commits a row before it publishes the bus event
// (Stage 0), so at `idle` the final assistant is readable; draining first
// guarantees the committed answer precedes `turn_completed`, `stream_phase
// idle` and `activity false`. Agent Code's orchestration decides a child is
// "completed" from exactly that order (committed assistant entry, then a phase
// change to idle after the prompt was submitted).
//
// Everything else is fan-out in arrival order.

import type { SemanticEvent } from '../channels/types.js'
import type { LiveOutput, PendingPermission, PendingQuestion } from '../live/types.js'
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
  drainNow(): void
  flushPendingUsers(): void
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
}

export class SessionSequencer {
  private readonly now: () => number
  private readonly heartbeatMs: number
  private openTurn: { turnId: string; lastAssistantText: string } | null = null
  private activity: { active: boolean; status: string | null } = { active: false, status: null }
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private exited = false

  constructor(private readonly options: SessionSequencerOptions) {
    this.now = options.now ?? Date.now
    this.heartbeatMs = options.heartbeatMs ?? 1000
  }

  onDurableRecords(records: readonly OpencodeMessageRecord[]): void {
    for (const record of records) {
      if (this.openTurn && record.info.role === 'assistant') {
        const text = record.parts
          .filter(part => part.type === 'text' && typeof part.text === 'string')
          .map(part => part.text as string)
          .join('')
        if (text) this.openTurn.lastAssistantText = text
      }
      this.options.sink.entry(record)
    }
  }

  onLiveOutputs(outputs: readonly LiveOutput[]): void {
    if (this.exited) return
    for (const output of outputs) this.handle(output)
  }

  /**
   * The TUI process exited: commit whatever is readable, close the open turn
   * through the same path a live idle would take, and go quiet.
   */
  onExit(closingOutputs: readonly LiveOutput[]): void {
    if (this.exited) return
    const durable = this.options.durable()
    durable?.drainNow()
    durable?.flushPendingUsers()
    for (const output of closingOutputs) this.handle(output)
    if (this.activity.active) this.setActivity({ active: false, status: null })
    this.exited = true
    this.stopHeartbeat()
  }

  dispose(): void {
    this.exited = true
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
        this.options.sink.semantic({ type: 'turn_started', turnId: output.turnId, role: 'assistant', source: 'opencode-sse', confidence: 'high', ts })
        return
      case 'turn-end': {
        // The cross-source rule: committed records first.
        const durable = this.options.durable()
        durable?.drainNow()
        durable?.flushPendingUsers()
        const fullText = this.openTurn?.turnId === output.turnId ? this.openTurn.lastAssistantText : ''
        this.openTurn = null
        this.options.sink.semantic({ type: 'turn_completed', turnId: output.turnId, fullText, source: 'opencode-sse', confidence: 'high', ts: this.now() })
        return
      }
      case 'phase':
        this.options.sink.semantic({
          type: 'stream_phase',
          turnId: output.turnId,
          phase: output.phase,
          ...(output.toolName ? { toolName: output.toolName } : {}),
          source: 'opencode-sse',
          ts,
        })
        return
      case 'activity':
        this.setActivity({ active: output.active, status: output.status })
        return
      case 'requests':
        this.options.sink.requests({ permission: output.permission, question: output.question })
        return
      case 'api-error':
        this.options.sink.semantic({ type: 'api_error', turnId: output.turnId, message: output.message, source: 'opencode-sse', ts })
        return
    }
  }

  private setActivity(next: { active: boolean; status: string | null }): void {
    this.activity = next
    this.options.sink.activity(next)
    if (next.active) this.startHeartbeat()
    else this.stopHeartbeat()
  }

  private startHeartbeat(): void {
    if (this.heartbeat || this.heartbeatMs <= 0) return
    this.heartbeat = setInterval(() => {
      if (this.activity.active && !this.exited) this.options.sink.activity(this.activity)
    }, this.heartbeatMs)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return
    clearInterval(this.heartbeat)
    this.heartbeat = null
  }
}

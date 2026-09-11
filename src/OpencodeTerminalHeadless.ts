// OpencodeTerminalHeadless — the native OpenCode TUI, read the way Agent Code
// reads every provider.
//
// The caller spawns the TUI (arguments and env from
// `prepareOpencodeTerminalLaunch`) and passes the PTY in, exactly as with
// claude-code-headless. This class never spawns or kills a process. It
// composes:
//
//   transcript/  durable channel: OpenCode's SQLite event log, read-only,
//                → committed `{ info, parts }` records
//   live/        live channel: the TUI's own server (`/event` SSE + re-sync)
//                → turns, phases, activity, pending permission/question
//   reconcile/   the one place both meet (drain-before-idle ordering)
//   conditions/  shared conditions core → Agent Code's condition snapshot
//   channels/    semantic / screen / committed, the siblings' shape
//
// Degradation is explicit, never silent:
// - No database path, or a database this reader refuses → `transcript-error`.
//   Activity and conditions still work.
// - A server that never answers (the port was lost to a race: the TUI then
//   neither exits nor paints, Stage 0) → `live-state { connected: false,
//   reason: 'server-unreachable' }` after the connect deadline. Committed
//   records still flow through the durable poll.
//
// See docs/decomposition/opencode-terminal-headless.md in Agent Code for the
// stages, and research/census-2026-09-10.md for the evidence behind each rule.

import { EventEmitter } from 'node:events'

import { CommittedChannel, ScreenChannel, SemanticChannel } from './channels/channels.js'
import type { SemanticEvent } from './channels/types.js'
import type { ConditionCustomAction, ConditionSnapshot } from './conditions/core/contract.js'
import { makeEvaluator } from './conditions/core/evaluator.js'
import {
  OPENCODE_TERMINAL_MODULES,
  PERMISSION_REPLY_ACTION,
  QUESTION_REJECT_ACTION,
  type OpencodeConditionInputs,
} from './conditions/modules.js'
import type { OpencodeTerminalLaunch } from './launch/prepareLaunch.js'
import { LiveServerClient, type PermissionReply } from './live/LiveServerClient.js'
import { LiveStateProjector } from './live/LiveStateProjector.js'
import { SseStream } from './live/SseStream.js'
import type { LiveBusEvent, LiveOutput } from './live/types.js'
import { SessionSequencer } from './reconcile/SessionSequencer.js'
import { PtyBinding, type PtyLike } from './terminal/PtyBinding.js'
import { DurableReader } from './transcript/DurableReader.js'
import { openOpencodeStore, OpencodeStoreError, type OpencodeStore } from './transcript/OpencodeStore.js'
import type { OpencodeMessageRecord } from './transcript/records.js'
import { opencodeTranscriptFile } from './transcript/transcriptFile.js'

export type OpencodeTerminalHeadlessOptions = {
  pty: PtyLike
  cwd: string
  launch: OpencodeTerminalLaunch
  fetch?: typeof fetch
  now?: () => number
  openStore?: (dbPath: string) => OpencodeStore
  /** How long to wait for the TUI's server before reporting `server-unreachable`. */
  liveConnectDeadlineMs?: number
  heartbeatMs?: number
  durablePollIntervalMs?: number
  sseInitialBackoffMs?: number
  sseMaxBackoffMs?: number
}

export type OpencodeTerminalError = {
  channel: 'durable' | 'live'
  code: string
  message: string
}

export type OpencodeActivity = { active: boolean; status: string | null }

export type ConditionActionResult =
  | { ok: true }
  | { ok: false; reason: string; failedAtStep?: string }

export type OpencodeTerminalHeadlessEvents = {
  activity: [OpencodeActivity]
  entry: [OpencodeMessageRecord]
  semantic: [SemanticEvent]
  conditions: [ConditionSnapshot<'opencode'>]
  'transcript-error': [OpencodeTerminalError]
  'live-state': [{ connected: boolean; reason?: string }]
  exit: [{ exitCode: number; signal?: number }]
}

export interface OpencodeTerminalHeadless {
  on<K extends keyof OpencodeTerminalHeadlessEvents>(event: K, listener: (...args: OpencodeTerminalHeadlessEvents[K]) => void): this
  off<K extends keyof OpencodeTerminalHeadlessEvents>(event: K, listener: (...args: OpencodeTerminalHeadlessEvents[K]) => void): this
  once<K extends keyof OpencodeTerminalHeadlessEvents>(event: K, listener: (...args: OpencodeTerminalHeadlessEvents[K]) => void): this
  emit<K extends keyof OpencodeTerminalHeadlessEvents>(event: K, ...args: OpencodeTerminalHeadlessEvents[K]): boolean
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isPermissionReply(value: unknown): value is PermissionReply {
  return value === 'once' || value === 'always' || value === 'reject'
}

// Bus events that change what a re-sync snapshot would say. Used to discard a
// snapshot that raced a newer live event (see handleLiveOpen).
function resyncDomain(event: LiveBusEvent): 'status' | 'requests' | null {
  if (event.type === 'session.status' || event.type === 'session.idle') return 'status'
  if (event.type.startsWith('permission.') || event.type.startsWith('question.')) return 'requests'
  return null
}

export class OpencodeTerminalHeadless extends EventEmitter {
  readonly semantic = new SemanticChannel()
  readonly screen = new ScreenChannel()
  readonly committed = new CommittedChannel()

  private readonly binding: PtyBinding
  private readonly launch: OpencodeTerminalLaunch
  private readonly now: () => number
  private readonly projector: LiveStateProjector
  private readonly sequencer: SessionSequencer
  private readonly evaluator = makeEvaluator<'opencode', OpencodeConditionInputs>('opencode', OPENCODE_TERMINAL_MODULES, () => this.now())
  private readonly file: string
  private readonly descendantCache = new Set<string>()

  private conditionInputs: OpencodeConditionInputs = { permission: null, question: null }
  private conditionSnapshot: ConditionSnapshot<'opencode'>
  private store: OpencodeStore | null = null
  private reader: DurableReader | null = null
  private client: LiveServerClient | null = null
  private stream: SseStream | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null
  private everConnected = false
  private liveState: { connected: boolean; reason?: string } | null = null
  private domainEpoch = { status: 0, requests: 0 }
  private started = false
  private stopped = false
  private exited = false

  constructor(private readonly options: OpencodeTerminalHeadlessOptions) {
    super()
    this.launch = options.launch
    this.now = options.now ?? Date.now
    this.binding = new PtyBinding(options.pty)
    this.file = opencodeTranscriptFile(options.launch.sessionID)
    this.projector = new LiveStateProjector(options.launch.sessionID, {
      now: this.now,
      isDescendant: sessionID => this.isDescendant(sessionID),
    })
    this.sequencer = new SessionSequencer({
      now: this.now,
      heartbeatMs: options.heartbeatMs,
      durable: () => this.reader,
      sink: {
        entry: record => {
          this.committed.publish({ type: 'entry', record, file: this.file, ts: this.now() })
          this.emit('entry', record)
        },
        semantic: event => {
          this.semantic.publish(event)
          this.emit('semantic', event)
        },
        activity: state => {
          this.screen.publish({ type: 'activity', active: state.active, status: state.status, ts: this.now() })
          this.emit('activity', state)
        },
        requests: state => {
          this.screen.publish({ type: 'permission', state: state.permission, ts: this.now() })
          this.screen.publish({ type: 'question', state: state.question, ts: this.now() })
          this.conditionInputs = state
          this.publishConditions(false)
        },
      },
    })
    this.conditionSnapshot = this.evaluator.evaluate(this.conditionInputs)
  }

  /**
   * Attach to the PTY and open both channels. Resolves immediately: it never
   * waits for the TUI's server, which comes up seconds after spawn (or never,
   * if the port was lost).
   */
  async start(): Promise<void> {
    if (this.started || this.stopped) return
    this.started = true
    this.binding.attach(event => this.handleExit(event))
    this.openDurable()
    this.openLive()
    // An explicit empty snapshot clears any condition a host cached under a
    // reused pane id before this backend existed.
    this.publishConditions(true)
  }

  /** Idempotent. Detaches from the PTY without killing it; the caller owns the process. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.binding.detach()
    this.teardown()
  }

  write(data: string): void {
    this.binding.write(data)
  }

  resize(cols: number, rows: number): void {
    this.binding.resize(cols, rows)
  }

  pasteAndSubmit(text: string): void {
    this.binding.pasteAndSubmit(text)
  }

  getProviderSessionId(): string {
    return this.launch.sessionID
  }

  getTranscriptFile(): string {
    return this.file
  }

  getActivity(): OpencodeActivity {
    return this.sequencer.currentActivity()
  }

  getConditionSnapshot(): ConditionSnapshot<'opencode'> {
    return this.conditionSnapshot
  }

  getLiveState(): { connected: boolean; reason?: string } | null {
    return this.liveState
  }

  isExited(): boolean {
    return this.exited
  }

  /**
   * Answer a permission or reject a question through the TUI's server. Clears
   * the condition as soon as the server accepts, instead of waiting for the
   * `*.replied` event, so the badge disappears the moment the user acts.
   */
  async resolveConditionAction(action: ConditionCustomAction): Promise<ConditionActionResult> {
    const client = this.client
    if (!client || this.stopped || this.exited) return { ok: false, reason: 'no-live-channel' }
    const payload = action.payload !== null && typeof action.payload === 'object' ? (action.payload as Record<string, unknown>) : {}

    if (action.name === PERMISSION_REPLY_ACTION) {
      const requestID = str(payload.requestID)
      if (!requestID || !isPermissionReply(payload.reply)) return { ok: false, reason: 'invalid-payload' }
      try {
        await client.replyPermission(requestID, payload.reply)
      } catch (error) {
        return { ok: false, reason: 'aborted', failedAtStep: `permission.reply: ${error instanceof Error ? error.message : String(error)}` }
      }
      this.sequencer.onLiveOutputs(this.projector.forgetRequest('permission', requestID))
      return { ok: true }
    }

    if (action.name === QUESTION_REJECT_ACTION) {
      const questionID = str(payload.questionID)
      if (!questionID) return { ok: false, reason: 'invalid-payload' }
      try {
        await client.rejectQuestion(questionID)
      } catch (error) {
        return { ok: false, reason: 'aborted', failedAtStep: `question.reject: ${error instanceof Error ? error.message : String(error)}` }
      }
      this.sequencer.onLiveOutputs(this.projector.forgetRequest('question', questionID))
      return { ok: true }
    }

    return { ok: false, reason: 'no-resolver' }
  }

  private openDurable(): void {
    const dbPath = this.launch.dbPath
    if (!dbPath) {
      this.reportError('durable', 'db_path_unavailable', this.launch.dbPathError ?? 'OpenCode database path is unavailable')
      return
    }
    try {
      this.store = (this.options.openStore ?? openOpencodeStore)(dbPath)
    } catch (error) {
      const code = error instanceof OpencodeStoreError ? error.code : 'open_failed'
      this.reportError('durable', code, error instanceof Error ? error.message : String(error))
      return
    }
    this.reader = new DurableReader({
      store: this.store,
      sessionID: this.launch.sessionID,
      pollIntervalMs: this.options.durablePollIntervalMs,
      onRecords: records => this.sequencer.onDurableRecords(records),
      onError: error => this.reportError('durable', error.code, error.message),
    })
    this.reader.start()
  }

  private openLive(): void {
    const client = new LiveServerClient({
      baseUrl: this.launch.server.url,
      username: this.launch.server.username,
      password: this.launch.server.password,
      directory: this.options.cwd,
      fetch: this.options.fetch,
    })
    this.client = client
    const stream = new SseStream({
      url: client.eventUrl(),
      headers: client.headers(),
      fetch: this.options.fetch,
      initialBackoffMs: this.options.sseInitialBackoffMs,
      maxBackoffMs: this.options.sseMaxBackoffMs,
    })
    this.stream = stream
    stream.on('open', () => this.handleLiveOpen())
    stream.on('event', event => {
      const domain = resyncDomain(event)
      if (domain) this.domainEpoch[domain] += 1
      this.sequencer.onLiveOutputs(this.projector.apply(event))
    })
    stream.on('disconnect', ({ reason }) => {
      if (this.stopped || this.exited) return
      this.reader?.setLiveConnected(false)
      this.setLiveState({ connected: false, reason })
    })
    stream.start()
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null
      if (!this.everConnected && !this.stopped && !this.exited) this.setLiveState({ connected: false, reason: 'server-unreachable' })
    }, this.options.liveConnectDeadlineMs ?? 30_000)
    this.deadlineTimer.unref?.()
  }

  private handleLiveOpen(): void {
    if (this.stopped || this.exited) return
    this.everConnected = true
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.deadlineTimer = null
    this.reader?.setLiveConnected(true)
    this.setLiveState({ connected: true })
    // Re-sync what may have happened while we were not listening. A domain
    // whose live events arrived while the snapshot was in flight is newer on
    // the stream than in the snapshot, so its part of the snapshot is dropped.
    const before = { ...this.domainEpoch }
    const client = this.client
    if (!client) return
    client.readResyncSnapshot().then(
      snapshot => {
        if (this.stopped || this.exited) return
        const outputs: LiveOutput[] = this.projector.resync({
          status: before.status === this.domainEpoch.status ? snapshot.status : undefined,
          permissions: before.requests === this.domainEpoch.requests ? snapshot.permissions : undefined,
          questions: before.requests === this.domainEpoch.requests ? snapshot.questions : undefined,
        })
        this.sequencer.onLiveOutputs(outputs)
      },
      error => this.reportError('live', 'resync_failed', error instanceof Error ? error.message : String(error)),
    )
  }

  private handleExit(event: { exitCode: number; signal?: number }): void {
    if (this.exited || this.stopped) return
    this.exited = true
    this.sequencer.onExit(this.projector.endForExit())
    this.teardown()
    this.emit('exit', event)
  }

  private teardown(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.deadlineTimer = null
    this.stream?.stop()
    this.reader?.stop()
    this.store?.release()
    this.store = null
    this.sequencer.dispose()
  }

  private setLiveState(next: { connected: boolean; reason?: string }): void {
    if (this.liveState && this.liveState.connected === next.connected && this.liveState.reason === next.reason) return
    this.liveState = next
    this.emit('live-state', next)
  }

  private publishConditions(force: boolean): void {
    const snapshot = this.evaluator.evaluate(this.conditionInputs)
    this.conditionSnapshot = snapshot
    if (this.evaluator.changed(this.evaluator.keyOf(snapshot)) || force) this.emit('conditions', snapshot)
  }

  private reportError(channel: 'durable' | 'live', code: string, message: string): void {
    this.committed.publish({ type: 'tail_error', code, message, ts: this.now() })
    this.emit('transcript-error', { channel, code, message })
  }

  /**
   * Is `sessionID` a descendant (a `task` child, grandchild, …) of this pane's
   * session? Children announced on the bus are learned by the projector; this
   * lookup covers the rest through the durable store's `session.parent_id`.
   */
  private isDescendant(sessionID: string): boolean {
    if (this.descendantCache.has(sessionID)) return true
    const store = this.store
    if (!store) return false
    let current: string | null = sessionID
    for (let depth = 0; current && depth < 8; depth += 1) {
      let parent: string | null
      try {
        parent = store.readSessionInfo(current)?.parentID ?? null
      } catch {
        return false
      }
      if (parent === this.launch.sessionID) {
        this.descendantCache.add(sessionID)
        return true
      }
      current = parent
    }
    return false
  }
}

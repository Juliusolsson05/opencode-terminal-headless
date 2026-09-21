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
import { LiveServerClient, RESYNC_PARTS, type PermissionReply, type ResyncPart } from './live/LiveServerClient.js'
import { LiveStateProjector } from './live/LiveStateProjector.js'
import { SseStream } from './live/SseStream.js'
import { submitLivePrompt, type SubmitPromptOptions, type SubmitPromptResult } from './live/submitPrompt.js'
import type { LiveOutput } from './live/types.js'
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
  /**
   * Re-resolve the database path after `launch.dbPath` came back null (#1114).
   *
   * WHY the host injects this rather than the class calling
   * `resolveOpencodeDbPath` itself: that helper runs `opencode db path` in a
   * child process, and this package's standing rule is that the host owns every
   * process — the same rule that keeps the PTY on the caller's side. Injection
   * also keeps the failure hermetic: with no resolver there is no recovery and
   * no exec, which is exactly what the `dbPath: null` system tests want.
   */
  resolveDbPath?: () => Promise<string>
  /** Delays before each `resolveDbPath` attempt, and by their count how many. */
  dbPathRetryDelaysMs?: readonly number[]
  /** How long to wait for the TUI's server before reporting `server-unreachable`. */
  liveConnectDeadlineMs?: number
  heartbeatMs?: number
  durablePollIntervalMs?: number
  sseInitialBackoffMs?: number
  sseMaxBackoffMs?: number
  /** First delay before re-reading a re-sync part that failed; doubles per attempt. */
  resyncRetryMs?: number
}

/**
 * How far the live channel has got. A diagnostic and test seam: tests wait on
 * these observable facts instead of sleeping, and nothing in the event
 * contract depends on them.
 */
export type OpencodeLiveProgress = {
  /** The event stream is open right now (the transport's own state). */
  connected: boolean
  /** Bus events applied since start. Monotonic. */
  busEvents: number
  /** Re-sync responses applied since start, partial ones included. Monotonic. */
  resyncs: number
  /**
   * Every re-sync part has been applied for the current connection. False
   * from each (re)connect until then, and while a failed part is retried.
   */
  reconciled: boolean
}

/**
 * A durable-channel diagnostic. Most codes disable the reader; `sink_failed`
 * reports a consumer callback failure and keeps reading, while
 * `final_drain_incomplete` reports an exit drain that could not finish.
 * Neither is a fatal database failure. Live connectivity and re-sync trouble
 * are reported separately through `live-state`.
 */
export type OpencodeTerminalError = {
  channel: 'durable'
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
  /**
   * The TUI started driving a different root session than the one this pane
   * observes (`/new` then a prompt, another session from `/sessions`, a
   * fork). Detection only: every channel keeps observing the launch session.
   */
  'session-switched': [{ from: string; to: string }]
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

// WHY 30 s when the Stage 0 recordings reached a healthy server in 3.5–9 s
// (8.7 s in plain.json): those were warm, sandboxed, one-pane starts. A pane
// restored alongside many others, a cold Bun start, or a project whose
// instance boot is slow (90 plugin.added events at startup; a large worktree
// can stall the first requests far longer, census "Project snapshot hazard")
// is still healthy at 10–20 s. The deadline only changes what is REPORTED —
// the stream keeps reconnecting, and a later open clears the diagnostic — so
// a late report costs a few seconds of silence on a pane that is broken
// anyway (a lost port, #881), while an early one would flag healthy panes.
const DEFAULT_LIVE_CONNECT_DEADLINE_MS = 30_000

// Re-sync part retries on a healthy stream: 250 ms doubling to a 4 s cap, six
// attempts (~12 s). A part fails when its endpoint errors or times out while
// the event stream itself is fine (an instance still booting, a transient
// 5xx). Bounded because every reconnect re-syncs from scratch anyway: after
// the last attempt `live-state` keeps naming the missing part, an explicit
// and persistent degradation, instead of a GET every few seconds forever.
const DEFAULT_RESYNC_RETRY_MS = 250
const RESYNC_RETRY_CAP_MS = 4_000
const RESYNC_MAX_RETRIES = 6

// Delays before each background re-resolution of the database path (#1114),
// and by their count the number of attempts. Explicit steps rather than a
// doubling factor because the shape is chosen, not derived: ~51 s in total is
// long enough to outlast the multi-pane restore storm that produced the only
// recorded failure (two panes, `opencode db path` killed at its 20 s budget),
// while the first step is still short enough that a pane which merely lost a
// race gets its committed stream back almost immediately. See `recoverDbPath`
// for why this must not reuse the durable-open ladder.
const DB_PATH_RECOVERY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000]

// WHY a depth bound on the descendant walk: each hop is a synchronous SQLite
// read inside the projector's `apply`, and `session.parent_id` is data, not a
// guaranteed tree (a corrupted or cyclic chain would otherwise loop forever).
// Real nesting is shallow: a subagent may start its own `task` only when its
// agent config explicitly grants the task permission (sst/opencode@v1.18.30
// packages/opencode/src/tool/task.ts denies it otherwise), so depth 1 is the
// norm and 8 is generous headroom.
const MAX_DESCENDANT_DEPTH = 8

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
  private durableOpenTimer: ReturnType<typeof setTimeout> | null = null
  private durableOpenDelayMs = 100
  // Seeded from the launch and then OWNED here, because a null path is now
  // recoverable: `launch` is the immutable record of what the host prepared,
  // while this is what the durable channel should open right now.
  private dbPath: string | null = null
  private dbPathRecoveryAttempt = 0
  private dbPathRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private dbPathRecoveryInFlight = false
  // Advanced on every live (re)connect AND every disconnect. A re-sync
  // response applies only while the connection that requested it is still the
  // open one: a response from a superseded connection carries stale state,
  // and one arriving after a disconnect has no stream behind it.
  private liveGeneration = 0
  private resyncRetryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly liveReadinessWaiters = new Set<() => void>()
  private reconciled = false
  private busEventsApplied = 0
  private resyncsApplied = 0
  private everConnected = false
  private liveState: { connected: boolean; reason?: string } | null = null
  private started = false
  private stopped = false
  private exited = false

  constructor(private readonly options: OpencodeTerminalHeadlessOptions) {
    super()
    this.launch = options.launch
    this.dbPath = options.launch.dbPath
    this.now = options.now ?? Date.now
    // Subscribes to the PTY's exit immediately; an exit before `start()` is
    // latched there and delivered by `start()` (see PtyBinding).
    this.binding = new PtyBinding(options.pty)
    this.file = opencodeTranscriptFile(options.launch.sessionID)
    this.projector = new LiveStateProjector(options.launch.sessionID, {
      now: this.now,
      isDescendant: sessionID => this.isDescendant(sessionID),
      parentOf: sessionID => this.parentOf(sessionID),
    })
    this.sequencer = new SessionSequencer({
      now: this.now,
      heartbeatMs: options.heartbeatMs,
      durable: () => this.reader,
      // The sequencer isolates consumer exceptions so one broken callback
      // cannot strand a turn. Surface them through the same durable
      // diagnostic as reader sink failures, instead of an unhandled throw.
      onSinkError: error => this.reportError('durable', 'sink_failed', `a session event sink threw: ${error instanceof Error ? error.message : String(error)}`),
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
   *
   * WHY a fence after every stage: each stage can call host code
   * synchronously — `transcript-error` from a refused database, the exit a
   * PTY may deliver from inside its own subscription — and that host code
   * may stop the instance. `stop()` is idempotent, so resources opened after
   * such a stop would never be released by a second call. Each stage
   * registers what it opens before it can call out (so teardown sees it), and
   * `start()` re-checks before the next one. The method has no awaits; if one
   * is ever added, fence after it too, because a stop or exit can land while
   * it is pending.
   */
  async start(): Promise<void> {
    if (this.started || this.isClosed()) return
    this.started = true
    // A PTY that already exited (before `start()`, or synchronously while the
    // binding subscribed) is delivered here, once. The instance is then
    // exited and does no network or store work at all.
    this.binding.onExit(event => this.handleExit(event))
    if (this.isClosed()) return
    this.openDurable()
    if (this.isClosed()) return
    this.openLive()
    if (this.isClosed()) return
    // An explicit empty snapshot clears any condition a host cached under a
    // reused pane id before this backend existed.
    this.publishConditions(true)
  }

  /** Idempotent. Detaches from the PTY without killing it; the caller owns the process. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.binding.detach()
    this.invalidateResync()
    this.teardown()
  }

  write(data: string): void {
    this.binding.write(data)
  }

  resize(cols: number, rows: number): void {
    this.binding.resize(cols, rows)
  }

  /** Terminal composer input for the host; programmatic delivery uses submitPrompt. */
  pasteAndSubmit(text: string): void {
    this.binding.pasteAndSubmit(text)
  }

  /**
   * Deliver to the bound session once its live channel has connected and
   * re-synced. The deadline covers both startup waiting and the HTTP request;
   * a 2xx acknowledges acceptance, not completion of the model's turn.
   *
   * The prompt carries the session's own agent/model/variant. It has to: the
   * server resolves an omitted agent to the CONFIGURED DEFAULT and then
   * persists that over the user's choice, so a prompt sent from Agent Code
   * would otherwise move a `plan` session to `build` and drop its variant.
   */
  submitPrompt(text: string, opts: SubmitPromptOptions = {}): Promise<SubmitPromptResult> {
    const client = this.client
    if (!client || this.isClosed()) return Promise.resolve({ ok: false, reason: 'no-live-channel' })
    const requested = opts.timeoutMs ?? this.options.liveConnectDeadlineMs ?? DEFAULT_LIVE_CONNECT_DEADLINE_MS
    // Invalid timer values must not turn a bounded API into an infinite wait.
    const timeoutMs = Number.isFinite(requested) ? Math.max(0, requested) : DEFAULT_LIVE_CONNECT_DEADLINE_MS
    return submitLivePrompt(client, text, {
      sessionID: this.launch.sessionID,
      timeoutMs,
      state: () => this.isClosed() ? 'closed' : this.stream?.isConnected() && this.reconciled ? 'ready' : 'waiting',
      subscribe: check => {
        this.liveReadinessWaiters.add(check)
        return () => this.liveReadinessWaiters.delete(check)
      },
      // Read at send time, not at call time, and never fatal: a store that
      // cannot answer costs us the selection, which is the behavior we had
      // before we read it at all. It must not cost the user the prompt.
      selection: () => {
        try {
          return this.store?.readSessionInfo(this.launch.sessionID)?.selection
            ?? { agent: null, providerID: null, modelID: null, variant: null }
        } catch {
          return { agent: null, providerID: null, modelID: null, variant: null }
        }
      },
    })
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

  getLiveProgress(): OpencodeLiveProgress {
    return {
      connected: !this.isClosed() && this.stream?.isConnected() === true,
      busEvents: this.busEventsApplied,
      resyncs: this.resyncsApplied,
      reconciled: this.reconciled,
    }
  }

  /** True once the TUI exited, including an exit latched before `start()` delivered it. */
  isExited(): boolean {
    return this.exited || this.binding.isExited()
  }

  /**
   * Scroll the TUI to its newest message through its own server (see
   * LiveServerClient.jumpToLatest for why a keystroke cannot do this safely).
   * Never throws: a jump that could not be sent is reported, and the pane
   * stays where it was.
   */
  async jumpToLatest(): Promise<{ ok: true } | { ok: false; reason: 'no-live-channel' | 'request-failed'; message?: string }> {
    const client = this.client
    if (!client || this.stopped || this.exited) return { ok: false, reason: 'no-live-channel' }
    try {
      await client.jumpToLatest()
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: 'request-failed', message: error instanceof Error ? error.message : String(error) }
    }
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
      // Tombstoned, not just removed: a re-sync captured before this answer
      // must not bring the request back (LiveStateProjector.forgetRequest).
      this.routeLiveOutputs(this.projector.forgetRequest('permission', requestID))
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
      this.routeLiveOutputs(this.projector.forgetRequest('question', questionID))
      return { ok: true }
    }

    return { ok: false, reason: 'no-resolver' }
  }

  private openDurable(): void {
    // Also reached from the durable-open retry timer, which can fire after a
    // stop or exit that raced it.
    if (this.isClosed()) return
    const dbPath = this.dbPath
    if (!dbPath) {
      this.recoverDbPath()
      return
    }
    try {
      this.store = (this.options.openStore ?? openOpencodeStore)(dbPath)
    } catch (error) {
      // BUSY is transient (a writer recovering the WAL, most plausibly while
      // many panes restore at once), so the open is retried with backoff
      // instead of disabling the pane's committed stream for its lifetime.
      if (error instanceof OpencodeStoreError && error.code === 'busy') {
        this.scheduleDurableOpen()
        return
      }
      const code = error instanceof OpencodeStoreError ? error.code : 'open_failed'
      this.reportError('durable', code, error instanceof Error ? error.message : String(error))
      return
    }
    // Assigned before `start()`: starting can report a failure to the host
    // synchronously, and a host that stops the instance from that callback
    // must find the reader to stop it.
    const reader = new DurableReader({
      store: this.store,
      sessionID: this.launch.sessionID,
      pollIntervalMs: this.options.durablePollIntervalMs,
      onRecords: records => this.sequencer.onDurableRecords(records),
      onError: error => this.reportError('durable', error.code, error.message),
    })
    this.reader = reader
    reader.start()
    if (this.isClosed()) return
    // The live channel may have connected while the open was being retried.
    // WHY the stream's own state and not `liveState`: `liveState` is what was
    // last REPORTED; the transport is the one owner of connectivity. Telling
    // the reader "connected" when no stream is open would switch off its
    // fallback poll with nothing left to wake it.
    if (this.stream?.isConnected()) reader.setLiveConnected(true)
  }

  /**
   * The database path was not resolved before launch. Report it once, then try
   * to get one anyway (#1114).
   *
   * WHY this is retried at all, when it used to be treated as permanent: the
   * recorded failure was `opencode db path` overrunning its 20 s budget during
   * a multi-pane restore and being SIGTERM'd — a machine that was busy for a
   * moment, not an OpenCode that cannot answer. Because the resolver memoises
   * per launch input, EVERY pane restoring in that window shared the one
   * rejected promise (both panes in the incident reported at the same
   * millisecond), and because this branch returned, all of them ran without a
   * committed stream until the app was restarted. One slow second should not
   * cost a pane its transcript for the rest of the day.
   *
   * WHY its own ladder instead of `scheduleDurableOpen`'s 100 ms → 2 s: that
   * one retries an `open()` against a file we already have, which is nearly
   * free. This retries a ~143 MB Bun process start that just failed for lack of
   * machine, so hammering it would feed the contention that caused the failure.
   * The ladder is spaced to outlast a restore storm and then stop: a genuinely
   * broken install (wrong binary, unsupported version) must not respawn a
   * process forever behind the user's back.
   */
  private recoverDbPath(): void {
    if (this.dbPathRecoveryInFlight || this.dbPathRecoveryTimer || this.isClosed()) return
    const resolve = this.options.resolveDbPath
    // Reported before the first retry, not after the last: a pane whose
    // committed stream is dark should say so now. The message names the
    // recovery so the banner is not claiming a permanence it no longer has.
    if (this.dbPathRecoveryAttempt === 0) {
      const detail = this.launch.dbPathError ?? 'OpenCode database path is unavailable'
      this.reportError('durable', 'db_path_unavailable', resolve
        ? `${detail}. Retrying in the background; this pane has no committed transcript until it succeeds.`
        : detail)
    }
    const ladder = this.options.dbPathRetryDelaysMs ?? DB_PATH_RECOVERY_DELAYS_MS
    if (!resolve || this.dbPathRecoveryAttempt >= ladder.length) return
    const delay = ladder[this.dbPathRecoveryAttempt] as number
    this.dbPathRecoveryAttempt += 1
    this.dbPathRecoveryTimer = setTimeout(() => {
      this.dbPathRecoveryTimer = null
      if (this.isClosed()) return
      this.dbPathRecoveryInFlight = true
      resolve().then(
        path => {
          this.dbPathRecoveryInFlight = false
          // Fenced: the awaited resolve can land after a stop or a PTY exit,
          // and opening a store then would leak one past teardown.
          if (this.isClosed()) return
          this.dbPath = path
          this.openDurable()
        },
        (error: unknown) => {
          this.dbPathRecoveryInFlight = false
          if (this.isClosed()) return
          if (this.dbPathRecoveryAttempt >= ladder.length) {
            // The second and last report. Distinct from the first so the user
            // can tell "degraded, working on it" from "this is how it stays".
            this.reportError('durable', 'db_path_unavailable', `OpenCode database path is still unavailable after ${ladder.length} retries: ${error instanceof Error ? error.message : String(error)}`)
            return
          }
          this.recoverDbPath()
        },
      )
    }, delay)
    this.dbPathRecoveryTimer.unref?.()
  }

  private scheduleDurableOpen(): void {
    if (this.durableOpenTimer || this.isClosed()) return
    const delay = this.durableOpenDelayMs
    // WHY 100 ms doubling to a 2 s cap, with no attempt limit: BUSY at open is
    // transient by definition (another OpenCode process holding the write
    // lock, typically recovering its WAL while many panes restore at once),
    // and each attempt costs one open. Doubling keeps a restore of many panes
    // from hammering a recovering writer; the cap, the same as the live
    // stream's, bounds how long the committed stream stays dark after the
    // writer lets go.
    this.durableOpenDelayMs = Math.min(delay * 2, 2_000)
    this.durableOpenTimer = setTimeout(() => {
      this.durableOpenTimer = null
      if (!this.stopped && !this.exited) this.openDurable()
    }, delay)
    this.durableOpenTimer.unref?.()
  }

  private openLive(): void {
    if (this.isClosed()) return
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
    // Stream and deadline are registered before the stream starts, so any
    // teardown from here on finds and releases both.
    this.stream = stream
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null
      if (!this.everConnected && !this.isClosed()) this.setLiveState({ connected: false, reason: 'server-unreachable' })
    }, this.options.liveConnectDeadlineMs ?? DEFAULT_LIVE_CONNECT_DEADLINE_MS)
    this.deadlineTimer.unref?.()
    stream.on('open', () => this.handleLiveOpen())
    stream.on('event', event => {
      if (this.isClosed()) return
      this.routeLiveOutputs(this.projector.apply(event))
      this.busEventsApplied += 1
    })
    stream.on('disconnect', ({ reason }) => {
      // Before the closed check on purpose: teardown's `stream.stop()` lands
      // here too, and this is what releases a pending re-sync retry on every
      // way out (a retry is only ever scheduled while the stream is open).
      this.invalidateResync()
      if (this.isClosed()) return
      this.reader?.setLiveConnected(false)
      this.setLiveState({ connected: false, reason })
    })
    stream.start()
  }

  private handleLiveOpen(): void {
    if (this.isClosed()) return
    this.everConnected = true
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.deadlineTimer = null
    this.reader?.setLiveConnected(true)
    this.setLiveState({ connected: true })
    // Re-sync what may have happened while we were not listening.
    //
    // WHY a generation per connection: a flapping connection starts one
    // re-sync per open. An older snapshot resolving after a newer one would
    // re-open a turn the newer one had just closed, and a snapshot resolving
    // after its own stream dropped would report health for a connection that
    // is gone. Disconnect advances the generation too (`invalidateResync`).
    this.invalidateResync()
    this.runResync(this.liveGeneration, RESYNC_PARTS, 0)
  }

  /**
   * Read `parts` of the re-sync and apply what answered, on the connection
   * `generation` only.
   *
   * WHY per part, per entity: one failing endpoint (say `/question`) used to
   * discard the status re-sync too, and one bus event about any session or
   * request discarded the whole matching domain. Now each part applies on its
   * own, and within a part the projector skips only the entities a newer
   * event restated (LiveStateProjector.resync). A part that failed is re-read
   * with backoff on the same healthy connection. A status part that a stream
   * event superseded lost nothing — the event restated the whole status — but
   * it is re-read as well, so `reconciled` means one thing: every part has
   * applied from a snapshot since this connection opened.
   */
  private runResync(generation: number, parts: readonly ResyncPart[], attempt: number): void {
    const client = this.client
    if (!client) return
    // Taken when the request is SENT: whatever the stream delivers from now
    // on is newer than the answer.
    const since = this.projector.revision()
    void client.readResyncSnapshot(parts).then(({ snapshot, failures, failedParts }) => {
      if (this.isClosed() || generation !== this.liveGeneration) return
      const superseded: ResyncPart[] = snapshot.status && this.projector.statusChangedSince(since) ? ['status'] : []
      this.routeLiveOutputs(this.projector.resync(snapshot, since))
      this.resyncsApplied += 1
      // A failed part does not disable anything (the stream stays up and
      // corrects state on its next event), so it is reported as live state,
      // not as a durable-channel `transcript-error`.
      this.reportResync(failures.length > 0 ? `resync-incomplete: ${failures.join('; ')}` : undefined)
      const pending = [...failedParts, ...superseded]
      if (pending.length === 0) {
        this.reconciled = true
        this.notifyLiveReadiness()
        return
      }
      // Out of attempts: `live-state` keeps naming the missing parts until
      // the next reconnect re-syncs from scratch (see RESYNC_MAX_RETRIES).
      if (attempt >= RESYNC_MAX_RETRIES) return
      const delay = Math.min((this.options.resyncRetryMs ?? DEFAULT_RESYNC_RETRY_MS) * 2 ** attempt, RESYNC_RETRY_CAP_MS)
      this.resyncRetryTimer = setTimeout(() => {
        this.resyncRetryTimer = null
        if (!this.isClosed() && generation === this.liveGeneration) this.runResync(generation, pending, attempt + 1)
      }, delay)
      this.resyncRetryTimer.unref?.()
    })
  }

  /**
   * Report a re-sync outcome. WHY it can never set `connected: true` by
   * itself: connectivity belongs to the stream's own open and disconnect
   * events. A response may only change the `reason`, and only while a stream
   * is open; the generation check already guarantees that, and this guard
   * makes it hold by construction.
   */
  private reportResync(reason: string | undefined): void {
    if (!this.stream?.isConnected()) return
    this.setLiveState(reason ? { connected: true, reason } : { connected: true })
  }

  /** Abandon the current connection's re-sync: no response or retry of it may apply. */
  private invalidateResync(): void {
    this.liveGeneration += 1
    this.reconciled = false
    if (this.resyncRetryTimer) clearTimeout(this.resyncRetryTimer)
    this.resyncRetryTimer = null
    this.notifyLiveReadiness()
  }

  private notifyLiveReadiness(): void {
    for (const check of [...this.liveReadinessWaiters]) check()
  }

  /**
   * Hand projector outputs on. WHY a session switch bypasses the sequencer:
   * it is detection only and changes no turn, request or durable state, so
   * there is nothing to order it against (see LiveOutput 'session-switched').
   */
  private routeLiveOutputs(outputs: readonly LiveOutput[]): void {
    const ordered: LiveOutput[] = []
    for (const output of outputs) {
      if (output.kind !== 'session-switched') ordered.push(output)
      else if (!this.isClosed()) this.emit('session-switched', { from: output.from, to: output.to })
    }
    this.sequencer.onLiveOutputs(ordered)
  }

  private isClosed(): boolean {
    return this.stopped || this.exited
  }

  private handleExit(event: { exitCode: number; signal?: number }): void {
    if (this.exited || this.stopped) return
    this.exited = true
    // WHY teardown and `exit` wait for the sequencer's exit drain (review
    // R8-F3): the final drain is the last chance to hand over what the TUI
    // committed before it died, and teardown releases the reader and its
    // store. When the database is busy at that moment the drain retries, up
    // to the sequencer's settle deadline, and only then does the instance tear
    // down and report `exit`. A drain that never finished is reported as a
    // durable `final_drain_incomplete` error before `exit`, instead of the
    // records being dropped in silence (the host's history still has them).
    // In the ordinary case nothing waits: the callback runs synchronously,
    // inside the PTY's exit callback, exactly as before.
    //
    // `isClosed()` is already true while the drain waits, so the live
    // channel's late events and re-syncs are ignored; the sequencer ignores
    // live outputs from the moment `onExit` is called.
    this.sequencer.onExit(this.projector.endForExit(), outcome => {
      // A stop() during the wait tears down and disposes the sequencer, which
      // then never calls back; this guard only restates that stop wins.
      if (this.stopped) return
      if (!outcome.complete) this.reportError('durable', 'final_drain_incomplete', outcome.detail)
      this.teardown()
      this.emit('exit', event)
    })
  }

  // Releases everything the instance holds, on every path that ends it
  // (stop, and natural exit once the exit drain is done). Idempotent.
  private teardown(): void {
    // WHY detach and invalidate here as well as in stop(): a natural exit
    // never goes through stop(). PtyBinding already drops its PTY
    // subscription when it latches the exit (review R2-F11); detaching again
    // is idempotent and keeps the release true if that ever changes. The
    // re-sync invalidation clears a pending re-sync retry timer, which
    // otherwise outlives the exit by up to its backoff.
    this.binding.detach()
    this.invalidateResync()
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.deadlineTimer = null
    if (this.durableOpenTimer) clearTimeout(this.durableOpenTimer)
    this.durableOpenTimer = null
    // Same reason as the durable-open timer: a pending db-path retry would
    // otherwise outlive the exit by up to its 30 s delay and then spawn a
    // process for a pane nobody is watching. The in-flight resolve itself
    // cannot be cancelled, so its continuations re-check `isClosed()`.
    if (this.dbPathRecoveryTimer) clearTimeout(this.dbPathRecoveryTimer)
    this.dbPathRecoveryTimer = null
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

  private reportError(channel: 'durable', code: string, message: string): void {
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
    for (let depth = 0; current && depth < MAX_DESCENDANT_DEPTH; depth += 1) {
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

  /**
   * A session's parent from the durable store, for session-switch detection:
   * the parent id, null for a root session, undefined when the store is not
   * open, has no row for it yet, or cannot be read right now (busy). The
   * projector treats undefined as "not a switch".
   */
  private parentOf(sessionID: string): string | null | undefined {
    const store = this.store
    if (!store) return undefined
    try {
      const info = store.readSessionInfo(sessionID)
      return info ? info.parentID : undefined
    } catch {
      return undefined
    }
  }
}

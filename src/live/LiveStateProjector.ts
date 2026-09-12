// LiveStateProjector — the only code that knows OpenCode's bus vocabulary.
// It turns TUI-server events for one session into turn, activity, phase and
// pending-request transitions. Pure and synchronous: no sockets, no timers.
//
// Rules, each pinned by a Stage 0 recording (research/census-2026-09-10.md)
// or, where the recordings have no example, by upstream source checked
// against the installed 1.18.30 binary:
// - A live turn is one `session.status` busy→idle span. `busy` repeats 2–5
//   times within one span (per model step) and a prompt queued while busy
//   runs inside the same span, so repeated `busy` never starts a new turn.
// - `session.status { type: 'idle' }` and `session.idle` arrive in the same
//   tick; whichever comes first ends the turn and the other is a no-op.
// - `status` stays `busy` while a permission or question waits for the user,
//   so attention can only come from `permission.asked` / `question.asked`.
// - `retry` (`{ type: 'retry', attempt, message, next }`, sst/opencode@v1.18.30
//   packages/opencode/src/session/status.ts) relabels activity inside the
//   span; the `busy` that follows when the retried request starts again
//   restores the ordinary label (SessionProcessor sets busy on every stream
//   `start`).
// - `session.error` never ends a turn by itself. After an ordinary error the
//   processor publishes the error and then idle, so the turn ends at that
//   idle. A context-overflow error with auto-compaction publishes the error
//   and continues into compaction inside the same busy span (the binary's
//   `SessionProcessor.halt`). Closing on the error would split one span.
// - Requests from descendant (`task` child) sessions are kept: the user answers
//   them in the parent TUI. Descendants are learned from `session.created`
//   events and from the host-provided lookup (the durable store's
//   `session.parent_id`), because the recordings never captured delegation.
// - Everything else on the bus (startup `plugin.added` ×90, catalog,
//   integration, reference, diff, delta and file events) changes neither
//   status nor committed state and is ignored.
//
// The projector never decides committed transcript content. For events that
// the durable log also records it only emits a `durable-hint`, the doorbell
// that tells the durable reader a readable row now exists.

import type { LiveBusEvent, LiveOutput, LiveResyncSnapshot, PendingPermission, PendingQuestion, StreamPhase } from './types.js'

export type LiveStateProjectorOptions = {
  /** Extra descendant lookup (e.g. the durable store's child sessions). */
  isDescendant?: (sessionID: string) => boolean
  /**
   * Parent of a session the bus has not described (the durable store's
   * `session.parent_id`): a session id, `null` for a root session, or
   * `undefined` when it cannot be known right now.
   */
  parentOf?: (sessionID: string) => string | null | undefined
  /** Clock for turn ids; injected by tests. */
  now?: () => number
}

type Props = Record<string, unknown>
type RequestKind = 'permission' | 'question'

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function obj(value: unknown): Props {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Props) : {}
}

// WHY this order: the wire shape is a NamedError `{ name, data: { message, … } }`
// (sst/opencode@v1.18.30 packages/opencode/src/util/named-schema-error.ts), and
// the installed 1.18.30 binary's own session view formats an error the same
// way: `data.message`, then `message`, then `name`. `name` covers errors that
// carry no message at all (MessageOutputLengthError has `data: {}`).
function errorMessage(error: Props): string {
  return str(obj(error.data).message) ?? str(error.message) ?? str(error.name) ?? 'OpenCode session error'
}

// Event types whose effect the durable log also records. A live copy of one
// for our session means the durable row is already readable.
const DURABLE_TYPES = new Set(['message.updated', 'message.part.updated', 'message.removed', 'message.part.removed', 'session.updated', 'session.created'])

export function permissionFromPayload(payload: Props): PendingPermission | null {
  const requestID = str(payload.id) ?? str(payload.requestID)
  const sessionID = str(payload.sessionID)
  if (!requestID || !sessionID) return null
  const permission = str(payload.permission) ?? 'permission'
  const patterns = Array.isArray(payload.patterns) ? payload.patterns.filter((p): p is string => typeof p === 'string') : []
  // 1.18.30 shape: `permission` is the verb ("bash"), `patterns` the targets.
  const title = patterns.length > 0 ? `${permission}: ${patterns.join(', ')}` : permission
  return { requestID, sessionID, title, metadata: payload }
}

export function questionFromPayload(payload: Props): PendingQuestion | null {
  const questionID = str(payload.id) ?? str(payload.requestID)
  const sessionID = str(payload.sessionID)
  if (!questionID || !sessionID) return null
  const questions = Array.isArray(payload.questions) ? payload.questions : []
  const text = questions
    .map(item => str(obj(item).question))
    .filter((line): line is string => line !== undefined)
    .join('\n')
  return { questionID, sessionID, text, metadata: payload }
}

export class LiveStateProjector {
  private readonly now: () => number
  private readonly externalIsDescendant: ((sessionID: string) => boolean) | undefined
  private readonly externalParentOf: ((sessionID: string) => string | null | undefined) | undefined
  private readonly descendants = new Set<string>()
  private readonly roles = new Map<string, 'user' | 'assistant'>()
  private readonly permissions = new Map<string, PendingPermission>()
  private readonly questions = new Map<string, PendingQuestion>()
  private busy = false
  private retrying = false
  private turnId: string | null = null
  private phase: StreamPhase = 'idle'
  private toolName: string | undefined
  private turnCounter = 0
  private lastRequestsKey = 'null|null'

  // Re-sync fencing. Every change a bus event (or a local answer) makes to an
  // entity a snapshot also describes — the owned session's status, or one
  // request id — advances `revisionCounter` and stamps that entity. A
  // snapshot requested at revision R is newer than the projector only for
  // entities stamped at or before R; for the rest the stream already said
  // something more recent. See `resync`.
  //
  // WHY per entity and not per domain: the bus is `Bus.subscribeAll` for the
  // whole instance, so a busy child, a background session or another request
  // arrives while a snapshot is in flight all the time. A domain-wide fence
  // threw away the unrelated rest of the snapshot, and nothing retried it:
  // an idle missed while disconnected, or a permission pending at reconnect,
  // could stay wrong until the next reconnect.
  private revisionCounter = 0
  private statusRevision = 0
  private readonly requestRevisions: Record<RequestKind, Map<string, number>> = { permission: new Map(), question: new Map() }
  // Requests answered through `forgetRequest`. A tombstone outlives every
  // snapshot and bus event, so a snapshot captured before the answer (or a
  // late `*.asked` / `*.updated` redelivery) can never resurrect a request
  // the user already dealt with. Growth is user-paced: one id per answer.
  private readonly answered: Record<RequestKind, Set<string>> = { permission: new Set(), question: new Set() }

  // Session-switch detection (see `observeUserMessage`).
  private drivenSessionID: string
  private readonly sessionParents = new Map<string, string | null>()
  private readonly userMessagesSeen = new Set<string>()
  private readonly busySessions = new Set<string>()
  // Per-session revision of `busySessions`, stamped by the bus and fenced
  // against in `resync`. A single status revision cannot serve here: it tracks
  // only the OWNED session, while this map deliberately spans every root the
  // TUI might switch to.
  private readonly busyRevisions = new Map<string, number>()

  constructor(private readonly sessionID: string, options: LiveStateProjectorOptions = {}) {
    this.now = options.now ?? Date.now
    this.externalIsDescendant = options.isDescendant
    this.externalParentOf = options.parentOf
    this.drivenSessionID = sessionID
  }

  apply(event: LiveBusEvent): LiveOutput[] {
    const props = obj(event.properties)
    const eventSession = str(props.sessionID) ?? str(obj(props.info).sessionID) ?? str(obj(props.part).sessionID)

    // Track sessions before the ownership filter: a child's session.created
    // names the child as its session but must still be learned, and
    // session-switch detection needs every root session's parentage and
    // busy state, not only ours.
    if (event.type === 'session.created' || event.type === 'session.updated') this.learnSession(obj(props.info))
    if (eventSession && (event.type === 'session.status' || event.type === 'session.idle')) {
      const type = event.type === 'session.idle' ? 'idle' : str(obj(props.status).type)
      if (type === 'idle') this.setBusy(eventSession, false)
      else if (type === 'busy' || type === 'retry') this.setBusy(eventSession, true)
    }
    const switched = event.type === 'message.updated' ? this.observeUserMessage(props) : []

    if (event.type.startsWith('permission.') || event.type.startsWith('question.')) {
      if (!eventSession || !this.owns(eventSession)) return switched
      return [...switched, ...this.applyRequest(event.type, props)]
    }

    if (eventSession !== this.sessionID) return switched

    switch (event.type) {
      case 'session.status':
        this.stampStatus()
        return this.applyStatus(str(obj(props.status).type), obj(props.status))
      case 'session.idle':
        this.stampStatus()
        return this.endTurn()
      case 'session.error':
        return [{ kind: 'api-error', message: errorMessage(obj(props.error)), turnId: this.turnId }]
      case 'message.updated': {
        const info = obj(props.info)
        const id = str(info.id)
        const role = info.role === 'user' || info.role === 'assistant' ? info.role : undefined
        if (id && role) this.roles.set(id, role)
        return [...switched, { kind: 'durable-hint' }]
      }
      case 'message.part.updated':
        return [...this.phaseFromPart(obj(props.part)), { kind: 'durable-hint' }]
      default:
        return DURABLE_TYPES.has(event.type) ? [{ kind: 'durable-hint' }] : []
    }
  }

  /**
   * The current change revision. Take it when a re-sync request is SENT and
   * pass it to `resync` with the response: anything the stream changed after
   * that moment is newer than the snapshot.
   */
  revision(): number {
    return this.revisionCounter
  }

  /** Did a bus event restate the owned session's status after `revision`? */
  statusChangedSince(revision: number): boolean {
    return this.statusRevision > revision
  }

  /**
   * Reconcile with what the server reported after a (re)connect.
   *
   * Each domain is optional: the host omits one whose request failed. Within
   * a domain, only entities the stream has NOT restated since `since` (the
   * revision taken when the request was sent) take the snapshot's view:
   * applying a stale status would re-open a turn that just ended, and a stale
   * request list would revive an answered permission. Everything else in the
   * snapshot still applies. Omitting `since` trusts the whole snapshot.
   */
  resync(snapshot: Partial<LiveResyncSnapshot>, since: number = this.revisionCounter): LiveOutput[] {
    const out: LiveOutput[] = []
    if (snapshot.status) {
      // Switch detection reads `busySessions` for EVERY root, not just ours,
      // and only bus events used to write it. Across a disconnect that left it
      // describing the world as it was before the outage: a root that went
      // idle while we were away stayed "busy", so the user's next prompt there
      // was swallowed as background noise and the switch was never reported;
      // a root that went busy while we were away stayed "idle", so its next
      // automatic message looked like a switch that never happened. The
      // snapshot is authoritative for exactly this, so the whole map is
      // reconciled from it — including deleting sessions it no longer lists.
      this.reconcileBusy(snapshot.status, since)
      if (!this.statusChangedSince(since)) {
        const type = str(snapshot.status[this.sessionID]?.type)
        // The status map lists only non-idle sessions ({} when idle).
        if (type && type !== 'idle') out.push(...this.applyStatus(type, obj(snapshot.status[this.sessionID])))
        else out.push(...this.endTurn())
      }
    }
    if (snapshot.permissions) {
      const listed = snapshot.permissions.map(item => permissionFromPayload(obj(item))).filter((p): p is PendingPermission => p !== null)
      this.reconcileRequests('permission', this.permissions, listed.map(p => [p.requestID, p] as const), since)
    }
    if (snapshot.questions) {
      const listed = snapshot.questions.map(item => questionFromPayload(obj(item))).filter((q): q is PendingQuestion => q !== null)
      this.reconcileRequests('question', this.questions, listed.map(q => [q.questionID, q] as const), since)
    }
    const requests = this.requestsOutput()
    if (requests) out.push(requests)
    return out
  }

  /**
   * Remove a request the host just answered, without waiting for the bus,
   * and tombstone it: a snapshot captured before the answer must not revive
   * it, and the bus confirmation that follows is then a no-op.
   */
  forgetRequest(kind: RequestKind, id: string): LiveOutput[] {
    this.answered[kind].add(id)
    this.stampRequest(kind, id)
    const deleted = kind === 'permission' ? this.permissions.delete(id) : this.questions.delete(id)
    if (!deleted) return []
    const requests = this.requestsOutput()
    return requests ? [requests] : []
  }

  isBusy(): boolean {
    return this.busy
  }

  getTurnId(): string | null {
    return this.turnId
  }

  getPhase(): StreamPhase {
    return this.phase
  }

  currentRequests(): { permission: PendingPermission | null; question: PendingQuestion | null } {
    return {
      permission: this.permissions.values().next().value ?? null,
      question: this.questions.values().next().value ?? null,
    }
  }

  /** Close an open turn because the process exited. */
  endForExit(): LiveOutput[] {
    const out = this.endTurn()
    if (this.permissions.size > 0 || this.questions.size > 0) {
      this.permissions.clear()
      this.questions.clear()
      const requests = this.requestsOutput()
      if (requests) out.push(requests)
    }
    return out
  }

  private owns(sessionID: string): boolean {
    return sessionID === this.sessionID || this.isDescendant(sessionID)
  }

  private isDescendant(sessionID: string): boolean {
    return this.descendants.has(sessionID) || (this.externalIsDescendant?.(sessionID) ?? false)
  }

  private learnSession(info: Props): void {
    const id = str(info.id)
    if (!id) return
    const parentID = str(info.parentID) ?? null
    this.sessionParents.set(id, parentID)
    if (parentID && (parentID === this.sessionID || this.isDescendant(parentID))) this.descendants.add(id)
  }

  private parentOf(sessionID: string): string | null | undefined {
    if (this.sessionParents.has(sessionID)) return this.sessionParents.get(sessionID)
    const parent = this.externalParentOf?.(sessionID)
    if (parent !== undefined) this.sessionParents.set(sessionID, parent)
    return parent
  }

  /**
   * Detect the TUI starting to drive a different ROOT session: `/new` then a
   * prompt, choosing another session in `/sessions` and prompting it, or a
   * fork (which copies the conversation into a new root session).
   *
   * WHY a user message is the signal: TUI navigation is local UI state only
   * (sst/opencode@v1.18.30 packages/opencode/src/cli/cmd/tui/context/route.tsx
   * publishes nothing), and a new session is created on the server only when
   * its first prompt is submitted (component/prompt/index.tsx). So nothing is
   * visible until the user prompts — and a prompt is a user message.
   *
   * What must NOT count, and why each guard exists:
   * - a `task` child's prompt: children are created with a `parentID`
   *   (tool/task.ts), so only sessions known to have no parent qualify;
   *   unknown parentage (no `session.created` seen, store unavailable)
   *   counts as "not a switch", because a false switch is worse than a late
   *   one;
   * - a later update of a message already seen (the TUI rewrites a prompt's
   *   `summary` after its turn ends, possibly after the user moved on);
   * - an automatic user message inside a session that is already busy
   *   (compaction's replay and continue messages, session/compaction.ts): a
   *   session left running in the background keeps writing those.
   *
   * Detection only. What to do after a switch is the owner's call; the
   * projector keeps observing the launch session exactly as before.
   */
  private observeUserMessage(props: Props): LiveOutput[] {
    const info = obj(props.info)
    if (info.role !== 'user') return []
    const messageID = str(info.id)
    const sessionID = str(info.sessionID) ?? str(props.sessionID)
    if (!messageID || !sessionID) return []
    if (this.userMessagesSeen.has(messageID)) return []
    this.userMessagesSeen.add(messageID)
    if (sessionID === this.drivenSessionID || this.busySessions.has(sessionID)) return []
    if (sessionID !== this.sessionID && (this.isDescendant(sessionID) || this.parentOf(sessionID) !== null)) return []
    const from = this.drivenSessionID
    this.drivenSessionID = sessionID
    return [{ kind: 'session-switched', from, to: sessionID }]
  }

  private setBusy(sessionID: string, busy: boolean): void {
    if (busy) this.busySessions.add(sessionID)
    else this.busySessions.delete(sessionID)
    this.revisionCounter += 1
    this.busyRevisions.set(sessionID, this.revisionCounter)
  }

  /**
   * Take the snapshot's view of which sessions are busy, per session.
   *
   * The fence is per session and not domain-wide on purpose: a status event
   * arriving for ONE session while the snapshot is in flight must not discard
   * the snapshot's account of every OTHER session — that is the same mistake
   * the request reconciler already documents. A session the stream restated
   * after `since` keeps the bus's newer value; everything else, present or
   * absent, follows the snapshot.
   */
  private reconcileBusy(status: Record<string, unknown>, since: number): void {
    const busyNow = new Set(
      Object.keys(status).filter(id => {
        const type = str(obj(status[id]).type)
        return type !== undefined && type !== 'idle'
      }),
    )
    for (const id of busyNow) {
      if ((this.busyRevisions.get(id) ?? 0) > since) continue
      this.busySessions.add(id)
    }
    for (const id of [...this.busySessions]) {
      if (busyNow.has(id)) continue
      if ((this.busyRevisions.get(id) ?? 0) > since) continue
      this.busySessions.delete(id)
    }
  }

  private stampStatus(): void {
    this.revisionCounter += 1
    this.statusRevision = this.revisionCounter
  }

  private stampRequest(kind: RequestKind, id: string): void {
    this.revisionCounter += 1
    this.requestRevisions[kind].set(id, this.revisionCounter)
  }

  private reconcileRequests<T extends { sessionID: string }>(kind: RequestKind, map: Map<string, T>, listed: ReadonlyArray<readonly [string, T]>, since: number): void {
    const newer = (id: string) => (this.requestRevisions[kind].get(id) ?? 0) > since
    const server = new Map(listed.filter(([, value]) => this.owns(value.sessionID)))
    // Gone on the server (answered or cancelled while we were not listening),
    // unless the stream restated this id after the snapshot was requested.
    for (const id of [...map.keys()]) if (!server.has(id) && !newer(id)) map.delete(id)
    // Pending on the server: add, or refresh in place (Map keeps position, so
    // the visible "oldest" request does not jump).
    for (const [id, value] of server) if (!newer(id) && !this.answered[kind].has(id)) map.set(id, value)
  }

  private applyStatus(type: string | undefined, status: Props): LiveOutput[] {
    if (type === 'idle') return this.endTurn()
    if (type !== 'busy' && type !== 'retry') return []
    const label = type === 'retry' ? `retrying${typeof status.attempt === 'number' ? ` (attempt ${status.attempt})` : ''}` : this.activityLabel()
    if (this.busy) {
      if (type === 'retry') {
        this.retrying = true
        return [{ kind: 'activity', active: true, status: label }]
      }
      // WHY busy clears a retry label: the processor sets busy when the
      // retried request's stream starts, and the phase it resumes in is often
      // the one it was in (responding → retry → responding), so the part that
      // follows is deduplicated by `phaseFromPart` and would never replace
      // "retrying (attempt n)". Repeated busy without a retry stays silent.
      if (!this.retrying) return []
      this.retrying = false
      return [{ kind: 'activity', active: true, status: this.activityLabel() }]
    }
    this.busy = true
    this.retrying = type === 'retry'
    this.turnCounter += 1
    this.turnId = `opencode-turn-${this.now().toString(36)}-${this.turnCounter}`
    this.phase = 'requesting'
    this.toolName = undefined
    return [
      { kind: 'turn-start', turnId: this.turnId },
      { kind: 'phase', phase: 'requesting', turnId: this.turnId },
      { kind: 'activity', active: true, status: type === 'retry' ? label : 'requesting' },
    ]
  }

  private endTurn(): LiveOutput[] {
    if (!this.busy || !this.turnId) return []
    const turnId = this.turnId
    this.busy = false
    this.retrying = false
    this.turnId = null
    this.phase = 'idle'
    this.toolName = undefined
    // The durable hint goes first: the sequencer drains committed records
    // before it lets the turn end reach consumers.
    return [
      { kind: 'durable-hint' },
      { kind: 'turn-end', turnId },
      { kind: 'phase', phase: 'idle', turnId },
      { kind: 'activity', active: false, status: null },
    ]
  }

  private phaseFromPart(part: Props): LiveOutput[] {
    if (!this.busy) return []
    const messageID = str(part.messageID)
    if (messageID && this.roles.get(messageID) === 'user') return []
    let next: StreamPhase | null = null
    let toolName: string | undefined
    if (part.type === 'reasoning') next = 'thinking'
    else if (part.type === 'text') next = 'responding'
    else if (part.type === 'tool') {
      const status = str(obj(part.state).status)
      if (status === 'pending' || status === 'running') {
        next = 'tool-use'
        toolName = str(part.tool)
      }
    }
    if (!next || (next === this.phase && toolName === this.toolName)) return []
    this.phase = next
    this.toolName = toolName
    // A new phase label replaces a retry label on its own.
    this.retrying = false
    return [
      { kind: 'phase', phase: next, turnId: this.turnId, ...(toolName ? { toolName } : {}) },
      { kind: 'activity', active: true, status: this.activityLabel() },
    ]
  }

  private activityLabel(): string {
    if (this.phase === 'tool-use') return this.toolName ? `running ${this.toolName}` : 'running tool'
    return this.phase === 'idle' ? 'busy' : this.phase
  }

  private applyRequest(type: string, props: Props): LiveOutput[] {
    if (type === 'permission.asked' || type === 'permission.updated') {
      const pending = permissionFromPayload(props)
      if (pending) {
        this.stampRequest('permission', pending.requestID)
        if (!this.answered.permission.has(pending.requestID)) this.permissions.set(pending.requestID, pending)
      }
    } else if (type === 'permission.replied') {
      const id = str(props.requestID) ?? str(props.id)
      if (id) {
        this.stampRequest('permission', id)
        this.permissions.delete(id)
      }
    } else if (type === 'question.asked' || type === 'question.updated') {
      const pending = questionFromPayload(props)
      if (pending) {
        this.stampRequest('question', pending.questionID)
        if (!this.answered.question.has(pending.questionID)) this.questions.set(pending.questionID, pending)
      }
    } else if (type === 'question.replied' || type === 'question.rejected') {
      const id = str(props.requestID) ?? str(props.id)
      if (id) {
        this.stampRequest('question', id)
        this.questions.delete(id)
      }
    } else {
      return []
    }
    const requests = this.requestsOutput()
    return requests ? [requests] : []
  }

  // Emit a requests snapshot only when the visible (oldest) request of either
  // kind changed, so repeated `permission.updated` does not churn consumers.
  private requestsOutput(): LiveOutput | null {
    const { permission, question } = this.currentRequests()
    const key = `${permission?.requestID ?? 'null'}|${question?.questionID ?? 'null'}`
    if (key === this.lastRequestsKey) return null
    this.lastRequestsKey = key
    return { kind: 'requests', permission, question }
  }
}

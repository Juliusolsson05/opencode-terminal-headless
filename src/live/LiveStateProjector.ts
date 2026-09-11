// LiveStateProjector — the only code that knows OpenCode's bus vocabulary.
// It turns TUI-server events for one session into turn, activity, phase and
// pending-request transitions. Pure and synchronous: no sockets, no timers.
//
// Rules, each pinned by a Stage 0 recording (research/census-2026-09-10.md):
// - A live turn is one `session.status` busy→idle span. `busy` repeats 2–5
//   times within one span (per model step) and a prompt queued while busy
//   runs inside the same span, so repeated `busy` never starts a new turn.
// - `session.status { type: 'idle' }` and `session.idle` arrive in the same
//   tick; whichever comes first ends the turn and the other is a no-op.
// - `status` stays `busy` while a permission or question waits for the user,
//   so attention can only come from `permission.asked` / `question.asked`.
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
  /** Clock for turn ids; injected by tests. */
  now?: () => number
}

type Props = Record<string, unknown>

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function obj(value: unknown): Props {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Props) : {}
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
  private readonly descendants = new Set<string>()
  private readonly roles = new Map<string, 'user' | 'assistant'>()
  private readonly permissions = new Map<string, PendingPermission>()
  private readonly questions = new Map<string, PendingQuestion>()
  private busy = false
  private turnId: string | null = null
  private phase: StreamPhase = 'idle'
  private toolName: string | undefined
  private turnCounter = 0
  private lastRequestsKey = 'null|null'

  constructor(private readonly sessionID: string, options: LiveStateProjectorOptions = {}) {
    this.now = options.now ?? Date.now
    this.externalIsDescendant = options.isDescendant
  }

  apply(event: LiveBusEvent): LiveOutput[] {
    const props = obj(event.properties)
    const eventSession = str(props.sessionID) ?? str(obj(props.info).sessionID) ?? str(obj(props.part).sessionID)

    // Track children before the ownership filter: a child's session.created
    // names the child as its session but must still be learned.
    if (event.type === 'session.created') {
      const info = obj(props.info)
      const childID = str(info.id)
      const parentID = str(info.parentID)
      if (childID && parentID && (parentID === this.sessionID || this.isDescendant(parentID))) this.descendants.add(childID)
    }

    if (event.type.startsWith('permission.') || event.type.startsWith('question.')) {
      if (!eventSession || !(eventSession === this.sessionID || this.isDescendant(eventSession))) return []
      return this.applyRequest(event.type, props)
    }

    if (eventSession !== this.sessionID) return []

    switch (event.type) {
      case 'session.status':
        return this.applyStatus(str(obj(props.status).type), obj(props.status))
      case 'session.idle':
        return this.endTurn()
      case 'session.error':
        return [{ kind: 'api-error', message: str(obj(props.error).message) ?? str(obj(obj(props.error).data).message) ?? 'OpenCode session error', turnId: this.turnId }]
      case 'message.updated': {
        const info = obj(props.info)
        const id = str(info.id)
        const role = info.role === 'user' || info.role === 'assistant' ? info.role : undefined
        if (id && role) this.roles.set(id, role)
        return [{ kind: 'durable-hint' }]
      }
      case 'message.part.updated':
        return [...this.phaseFromPart(obj(props.part)), { kind: 'durable-hint' }]
      default:
        return DURABLE_TYPES.has(event.type) ? [{ kind: 'durable-hint' }] : []
    }
  }

  /** Reconcile with what the server reports after a (re)connect. */
  resync(snapshot: LiveResyncSnapshot): LiveOutput[] {
    const out: LiveOutput[] = []
    const type = str(snapshot.status[this.sessionID]?.type)
    // The status map lists only non-idle sessions ({} when idle).
    if (type && type !== 'idle') out.push(...this.applyStatus(type, obj(snapshot.status[this.sessionID])))
    else out.push(...this.endTurn())

    this.permissions.clear()
    for (const item of snapshot.permissions) {
      const pending = permissionFromPayload(obj(item))
      if (pending && (pending.sessionID === this.sessionID || this.isDescendant(pending.sessionID))) this.permissions.set(pending.requestID, pending)
    }
    this.questions.clear()
    for (const item of snapshot.questions) {
      const pending = questionFromPayload(obj(item))
      if (pending && (pending.sessionID === this.sessionID || this.isDescendant(pending.sessionID))) this.questions.set(pending.questionID, pending)
    }
    const requests = this.requestsOutput()
    if (requests) out.push(requests)
    return out
  }

  /** Remove a request the host just answered, without waiting for the bus. */
  forgetRequest(kind: 'permission' | 'question', id: string): LiveOutput[] {
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

  private isDescendant(sessionID: string): boolean {
    return this.descendants.has(sessionID) || (this.externalIsDescendant?.(sessionID) ?? false)
  }

  private applyStatus(type: string | undefined, status: Props): LiveOutput[] {
    if (type === 'idle') return this.endTurn()
    if (type !== 'busy' && type !== 'retry') return []
    const label = type === 'retry' ? `retrying${typeof status.attempt === 'number' ? ` (attempt ${status.attempt})` : ''}` : this.activityLabel()
    if (this.busy) {
      // Repeated busy inside a span: at most refresh the retry label.
      return type === 'retry' ? [{ kind: 'activity', active: true, status: label }] : []
    }
    this.busy = true
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
      if (pending) this.permissions.set(pending.requestID, pending)
    } else if (type === 'permission.replied') {
      const id = str(props.requestID) ?? str(props.id)
      if (id) this.permissions.delete(id)
    } else if (type === 'question.asked' || type === 'question.updated') {
      const pending = questionFromPayload(props)
      if (pending) this.questions.set(pending.questionID, pending)
    } else if (type === 'question.replied' || type === 'question.rejected') {
      const id = str(props.requestID) ?? str(props.id)
      if (id) this.questions.delete(id)
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

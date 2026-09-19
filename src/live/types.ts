// Vocabulary of the live channel, pinned by Stage 0 recordings of OpenCode
// 1.18.30 (research/census-2026-09-10.md, "Live server").

/** One event from the TUI server's `/event` SSE bus. */
export type LiveBusEvent = {
  id?: string
  type: string
  properties?: Record<string, unknown>
}

export type StreamPhase = 'requesting' | 'thinking' | 'responding' | 'tool-use' | 'idle'

/** A pending permission request, in the shape Agent Code's condition state uses. */
export type PendingPermission = {
  requestID: string
  sessionID: string
  title: string
  metadata: Record<string, unknown>
}

/** A pending question request, in the shape Agent Code's condition state uses. */
export type PendingQuestion = {
  questionID: string
  sessionID: string
  text: string
  metadata: Record<string, unknown>
}

export type LiveOutput =
  | { kind: 'turn-start'; turnId: string }
  | { kind: 'turn-end'; turnId: string }
  | { kind: 'activity'; active: boolean; status: string | null }
  | { kind: 'phase'; phase: StreamPhase; turnId: string | null; toolName?: string }
  | { kind: 'requests'; permission: PendingPermission | null; question: PendingQuestion | null }
  | { kind: 'durable-hint' }
  | { kind: 'api-error'; message: string; turnId: string | null; errorType?: string }
  // The TUI started driving a different root session (see
  // LiveStateProjector.observeUserMessage). Detection only: it changes no
  // turn, request or durable state, so the composition hands it straight to
  // the host instead of through the SessionSequencer, which has nothing to
  // order it against.
  | { kind: 'session-switched'; from: string; to: string }

/** What a re-sync reads from the server after every (re)connect. */
export type LiveResyncSnapshot = {
  status: Record<string, { type?: string } | undefined>
  permissions: unknown[]
  questions: unknown[]
}

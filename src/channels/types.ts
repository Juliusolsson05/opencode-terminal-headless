// Channel vocabulary, shaped like the sibling headless packages' so Agent Code
// adapters read every provider the same way.
//
// WHY `source: 'opencode-sse'`: the semantic events genuinely come from
// OpenCode's SSE bus (via the TUI's own server), and Agent Code's OpenCode
// semantic fold policy is already keyed on that source for the structured
// runtime. Reusing it means zero renderer changes for these events.

import type { OpencodeMessageRecord } from '../transcript/records.js'
import type { PendingPermission, PendingQuestion, StreamPhase } from '../live/types.js'

export type SemanticSource = 'opencode-sse'

export type SemanticTurnStartedEvent = {
  type: 'turn_started'
  turnId: string
  role: 'assistant'
  source: SemanticSource
  confidence: 'high'
  ts: number
}

export type SemanticTurnCompletedEvent = {
  type: 'turn_completed'
  turnId: string
  fullText: string
  source: SemanticSource
  confidence: 'high'
  ts: number
}

export type SemanticStreamPhaseEvent = {
  type: 'stream_phase'
  turnId: string | null
  phase: StreamPhase
  toolName?: string
  source: SemanticSource
  ts: number
}

export type SemanticApiErrorEvent = {
  type: 'api_error'
  turnId: string | null
  message: string
  /**
   * OpenCode's own error name ('APIError', 'MessageAbortedError', …) when it
   * sent one. It lets a consumer tell a provider failure from a user's Esc
   * without parsing the message (Agent Code #1018 review). The structured
   * package, opencode-headless, sends the same field.
   */
  errorType?: string
  source: SemanticSource
  ts: number
}

export type SemanticEvent =
  | SemanticTurnStartedEvent
  | SemanticTurnCompletedEvent
  | SemanticStreamPhaseEvent
  | SemanticApiErrorEvent

export type ScreenActivityEvent = { type: 'activity'; active: boolean; status: string | null; ts: number }
export type ScreenPermissionEvent = { type: 'permission'; state: PendingPermission | null; ts: number }
export type ScreenQuestionEvent = { type: 'question'; state: PendingQuestion | null; ts: number }
export type ScreenEvent = ScreenActivityEvent | ScreenPermissionEvent | ScreenQuestionEvent

export type CommittedEntryEvent = { type: 'entry'; record: OpencodeMessageRecord; file: string; ts: number }
export type CommittedTailErrorEvent = { type: 'tail_error'; code: string; message: string; ts: number }
export type CommittedEvent = CommittedEntryEvent | CommittedTailErrorEvent

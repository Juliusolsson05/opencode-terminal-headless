// Condition modules for OpenCode Terminal, built on the shared conditions core
// (vendored by Agent Code's scripts/sync-conditions-core.mjs into ./core).
//
// WHY these kinds, state shapes and action names: they are byte-for-byte what
// Agent Code's structured OpenCode runtime already emits
// (`opencode.permission` / `opencode.question`, `opencode.permission.reply` /
// `opencode.question.reject`, state `{ visible, requestID, title, metadata }`
// and `{ visible, questionID, text, metadata }`). The renderer's OpenCode
// condition policy, Dispatch badges and the external condition-control path
// therefore treat both runtimes identically, with no new wire vocabulary.
//
// WHY module order is permission, then question: the evaluator's snapshot key is
// JSON over the conditions map in registry order, so the order is part of the
// dedupe contract. Permission first matches the structured runtime's fold.

import { defineModule, type ConditionAction } from './core/contract.js'
import type { PendingPermission, PendingQuestion } from '../live/types.js'

export const PERMISSION_REPLY_ACTION = 'opencode.permission.reply'
export const QUESTION_REJECT_ACTION = 'opencode.question.reject'

export type OpencodeConditionInputs = {
  permission: PendingPermission | null
  question: PendingQuestion | null
}

export type OpencodePermissionConditionState = {
  visible: true
  requestID: string
  title: string
  metadata: Record<string, unknown>
}

export type OpencodeQuestionConditionState = {
  visible: true
  questionID: string
  text: string
  metadata: Record<string, unknown>
}

export const permissionModule = defineModule<'opencode.permission', OpencodeConditionInputs, OpencodePermissionConditionState>({
  kind: 'opencode.permission',
  detect: inputs =>
    inputs.permission
      ? { visible: true, requestID: inputs.permission.requestID, title: inputs.permission.title, metadata: inputs.permission.metadata }
      : null,
  // Fresh objects per call: a consumer mutating one snapshot's actions must
  // never leak into the next snapshot.
  actions: (state): ConditionAction[] => [
    { kind: 'custom', id: `${state.requestID}:once`, label: 'Allow once', name: PERMISSION_REPLY_ACTION, payload: { requestID: state.requestID, reply: 'once' } },
    { kind: 'custom', id: `${state.requestID}:always`, label: 'Allow always', name: PERMISSION_REPLY_ACTION, payload: { requestID: state.requestID, reply: 'always' } },
    { kind: 'custom', id: `${state.requestID}:reject`, label: 'Reject', name: PERMISSION_REPLY_ACTION, payload: { requestID: state.requestID, reply: 'reject' } },
  ],
})

export const questionModule = defineModule<'opencode.question', OpencodeConditionInputs, OpencodeQuestionConditionState>({
  kind: 'opencode.question',
  detect: inputs =>
    inputs.question
      ? { visible: true, questionID: inputs.question.questionID, text: inputs.question.text, metadata: inputs.question.metadata }
      : null,
  // Reject-only. WHY, and what the boundary is: the upstream protocol DOES
  // take answers (`POST /question/:id/reply` with `answers`, sst/opencode@
  // v1.18.30 packages/opencode/src/server/routes/instance/question.ts), and
  // the sibling opencode-headless package exposes it as `replyQuestion`. What
  // is reject-only is Agent Code's OpenCode condition surface (its structured
  // runtime offers `opencode.question.reject` and nothing else), which this
  // package matches byte for byte so both runtimes share one renderer policy.
  // Here the user answers a question in the native TUI, where the option
  // list is rendered; rejecting from outside is the one action that is always
  // safe to offer without re-rendering that list. Adding an answer action is
  // an Agent Code condition-surface change, not a protocol gap.
  actions: (state): ConditionAction[] => [
    { kind: 'custom', id: `${state.questionID}:reject`, label: 'Reject', name: QUESTION_REJECT_ACTION, payload: { questionID: state.questionID } },
  ],
})

export const OPENCODE_TERMINAL_MODULES = [permissionModule, questionModule] as const

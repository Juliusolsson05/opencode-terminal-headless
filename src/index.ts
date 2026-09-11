// Public entry point. Only re-exports live here so the package's contract with
// Agent Code is readable in one place; every module keeps its own WHY comments.
//
// Deliberately NOT exported: `reconcile/` (the isolated layer where the two
// channels meet — its only consumer is OpencodeTerminalHeadless) and the
// channel readers' internals. Consumers get records, events and snapshots,
// never the machinery that orders them.

export {
  OpencodeTerminalHeadless,
  type ConditionActionResult,
  type OpencodeActivity,
  type OpencodeTerminalError,
  type OpencodeTerminalHeadlessEvents,
  type OpencodeTerminalHeadlessOptions,
} from './OpencodeTerminalHeadless.js'

export {
  prepareOpencodeTerminalLaunch,
  SERVER_HOSTNAME,
  SERVER_USERNAME,
  type OpencodeTerminalLaunch,
  type PrepareLaunchOptions,
} from './launch/prepareLaunch.js'
export { resolveOpencodeDbPath } from './launch/dbPath.js'
export { allocateLoopbackPort } from './launch/port.js'

export type { PtyLike, PtyDisposable } from './terminal/PtyBinding.js'

export {
  openOpencodeStore,
  OpencodeStoreError,
  type HistoryPage,
  type OpencodeSessionInfo,
  type OpencodeStore,
  type OpencodeStoreErrorCode,
} from './transcript/OpencodeStore.js'
export type { OpencodeMessageInfo, OpencodeMessageRecord, OpencodePartRecord } from './transcript/records.js'
export { opencodeTranscriptFile, parseOpencodeTranscriptFile } from './transcript/transcriptFile.js'

export {
  PERMISSION_REPLY_ACTION,
  QUESTION_REJECT_ACTION,
  type OpencodePermissionConditionState,
  type OpencodeQuestionConditionState,
} from './conditions/modules.js'
export type { ConditionAction, ConditionCustomAction, ConditionRecord, ConditionSnapshot } from './conditions/core/contract.js'

export { CommittedChannel, ScreenChannel, SemanticChannel } from './channels/channels.js'
export type {
  CommittedEvent,
  ScreenEvent,
  SemanticApiErrorEvent,
  SemanticEvent,
  SemanticSource,
  SemanticStreamPhaseEvent,
  SemanticTurnCompletedEvent,
  SemanticTurnStartedEvent,
} from './channels/types.js'
export type { PendingPermission, PendingQuestion, StreamPhase } from './live/types.js'

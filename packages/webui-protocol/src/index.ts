// Core types browser surfaces name, re-exported so they reach core only
// through this package.
export type {
  BrowserElementSelection,
  Message,
  SessionMarker,
} from '@wrongstack/contracts/types';
// One automatic-resume policy for every surface after a provider failure, so
// VibeUI cannot drift from the TUI, REPL and WebUI.
export {
  DEFAULT_FAILED_RUN_RESUME_BASE_MS,
  failedRunResumeDelayMs,
  failedRunResumePrompt,
  isResumableRunFailure,
  MAX_FAILED_RUN_RESUMES,
} from '@wrongstack/contracts/types/failed-run-resume';
// Browser surfaces must project a resumed session through the SAME function
// the TUI and the servers use, or the ordering drifts again — which is exactly
// how the four separate replay renderers came about.
export type { SessionToolMeta } from '@wrongstack/contracts/types/session-timeline';
export { projectSessionTimeline } from '@wrongstack/contracts/types/session-timeline';
export {
  reduceStreamActivity,
  STREAM_ACTIVITY_WINDOW_MS,
  type StreamActivity,
  startStreamActivity,
  streamActivityView,
} from '@wrongstack/contracts/types/stream-activity';
export {
  detectSkillMention,
  extractSkillMentions,
  insertSkillMention,
  matchSkillMentions,
  preserveSkillMentions,
  type SkillMention,
  type SkillMentionCandidate,
} from '@wrongstack/core/skill-mentions';
export {
  indexInsideCodeFence,
  isFinalTurnStopReason,
  type ParsedNextStep,
  parseNextSteps,
  projectNextStepsToolInput,
  stripNextStepsBlock,
} from '@wrongstack/core/utils/next-steps';
export {
  AUTO_WAKE_PROMPT_MARKER,
  autoWakeNoticeText,
  formatAutoWakeNotice,
  formatAutoWakeSuppressedNotice,
  formatDeliveryPendingNotice,
  isAutoWakePrompt,
} from './auto-wake.js';
export * from './automation.js';
export * from './automation-commands.js';
export * from './automation-portability.js';
export type {
  AutomationCIResult,
  AutomationPullRequestPlan,
  AutomationPullRequestReceipt,
  AutomationPullRequestView,
} from './automation-pull-request.js';
export type {
  CodeAssistDelta,
  CodeAssistMutatingPreset,
  CodeAssistPreset,
  CodeAssistResult,
  CodeAssistRunRequest,
  CodeAssistStarted,
  CodeAssistTarget,
} from './code-assist.js';
export { codeAssistAllowsEdits } from './code-assist.js';
export {
  createSurfaceConnectionState,
  DEFAULT_SURFACE_CONNECTION_CONFIG,
  enqueueBounded,
  isConnectionHeartbeatTimedOut,
  markConnectionActivity,
  markConnectionConnecting,
  markConnectionOpen,
  planConnectionReconnect,
  type ReconnectPlan,
  resetConnection,
  type SurfaceConnectionConfig,
  type SurfaceConnectionPhase,
  type SurfaceConnectionState,
  stopConnection,
} from './connection-fsm.js';
export type {
  CoreClientMessage,
  CoreServerMessage,
  SessionScopedPayload,
  WSAbort,
  WSCodeMapFileTarget,
  WSError,
  WSIterationCompleted,
  WSIterationStarted,
  WSOutputProgress,
  WSPing,
  WSPong,
  WSProviderError,
  WSProviderRetry,
  WSRunResult,
  WSSessionEnd,
  WSSessionFramesResumed,
  WSSessionNew,
  WSSessionResume,
  WSSessionRunState,
  WSSessionStart,
  WSSessionSubscribe,
  WSSessionsList,
  WSSessionsListRequest,
  WSTextDelta,
  WSThinkingDelta,
  WSToolConfirmNeeded,
  WSToolConfirmResolved,
  WSToolConfirmResult,
  WSToolExecuted,
  WSToolProgress,
  WSToolUseStart,
  WSUserMessage,
  WSUserMessageImage,
} from './conversation-core.js';
export { decodeProtocolFrame, decodeProtocolMessage } from './decoder.js';
export * from './environment-profile.js';
export type { WrongStackErrorKind, WrongStackErrorModel } from './error-model.js';
export { FrameResume } from './frame-resume.js';
export type {
  ApiErrorBody,
  ApiSession,
  ApiSessionAgent,
  ApiSessionAgents,
  ApiSessionEvent,
  ApiSessionEvents,
  ApiSessionInterruptRequest,
  ApiSessionInterruptResponse,
  ApiSessionMessageRequest,
  ApiSessionMessageResponse,
} from './http-api.js';
export type { MCPTaskView } from './mcp-tasks.js';
export {
  type ChatProjection,
  type FleetProjection,
  type HqAlertProjection,
  type HqCommandStatusProjection,
  type HqEventProjection,
  type HqFleetProjection,
  projectChatMessage,
  projectFleetMessage,
  projectHqAlertMessage,
  projectHqCommandStatusMessage,
  projectHqEventMessage,
  projectHqFleetMessage,
  projectSessionMessage,
  projectToolMessage,
  type SessionProjection,
  type ToolProjection,
} from './projections.js';
export {
  CLIENT_MESSAGE_TYPES,
  type ExactClientMessageType,
  type ExactServerMessageType,
  isRegisteredMessageType,
  SERVER_MESSAGE_TYPES,
} from './registry.js';
export {
  buildReplayPayload,
  MAX_OPEN_SESSIONS_PER_CONNECTION,
  REPLAY_MESSAGE_CAP,
  type ReplayPayloadFields,
  type ReplaySource,
} from './replay-payload.js';
export type {
  CanonicalClientMessage,
  CanonicalClientMessageType,
  CanonicalServerMessage,
  CanonicalServerMessageType,
  ProtocolDecodeIssue,
  ProtocolDecodeResult,
  ProtocolDirection,
  ProtocolEnvelope,
} from './types.js';
export {
  HOST_CAPABILITY_ETERNAL_AUTONOMY,
  negotiateProtocol,
  type ProtocolAdvertisement,
  type ProtocolNegotiation,
  protocolAdvertisement,
  SURFACE_PROTOCOL_CAPABILITIES,
  SURFACE_PROTOCOL_MIN_VERSION,
  SURFACE_PROTOCOL_VERSION,
  type SurfaceProtocolCapability,
} from './version.js';

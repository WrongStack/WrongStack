export type {
  AutomationCIResult,
  AutomationPullRequestPlan,
  AutomationPullRequestReceipt,
  AutomationPullRequestView,
} from './automation-pull-request.js';
export type { MCPTaskView } from './mcp-tasks.js';

// The two core types the projector's input names. Re-exported for the same
// reason as the projector itself: SimpleUI reaches core only through this
// package.

export type {
  BrowserElementSelection,
  Message,
  SessionEvent,
  SessionMarker,
  SessionMarkerDetail,
} from '@wrongstack/contracts/types';
// The marker projector itself, so a LIVE surface can render an event with the
// same wording its replay will use. Without it the SimpleUI would have had to
// hand-write a second copy of every marker sentence.
export {
  isSystemInjectedMessage,
  SYSTEM_INJECTION_PREFIXES,
  sessionEventToMarker,
} from '@wrongstack/contracts/types/session-markers';
// Re-exported for SimpleUI, which depends on this package rather than on
// `@wrongstack/core` directly. Both browser surfaces must project a resumed
// session through the SAME function the TUI and the servers use, or the
// ordering drifts again — which is exactly how the four separate replay
// renderers came about.
export type {
  ProjectSessionTimelineInput,
  SessionTimelineEntry,
  SessionTimelineImage,
  SessionTimelineToolEntry,
  SessionToolMeta,
  TextBlockMode,
  ThinkingPlacement,
} from '@wrongstack/contracts/types/session-timeline';
export {
  projectSessionTimeline,
  projectSessionToolMeta,
} from '@wrongstack/contracts/types/session-timeline';
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
  negotiateProtocol,
  type ProtocolAdvertisement,
  type ProtocolNegotiation,
  protocolAdvertisement,
  SURFACE_PROTOCOL_CAPABILITIES,
  SURFACE_PROTOCOL_MIN_VERSION,
  SURFACE_PROTOCOL_VERSION,
  type SurfaceProtocolCapability,
} from './version.js';

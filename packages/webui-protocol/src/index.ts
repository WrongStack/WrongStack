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
export { decodeProtocolFrame, decodeProtocolMessage } from './decoder.js';
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
  buildReplayPayload,
  MAX_OPEN_SESSIONS_PER_CONNECTION,
  REPLAY_MESSAGE_CAP,
  type ReplayPayloadFields,
  type ReplaySource,
} from './replay-payload.js';
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
} from '@wrongstack/core/types/session-timeline';
// The two core types the projector's input names. Re-exported for the same
// reason as the projector itself: SimpleUI reaches core only through this
// package.
export type {
  Message,
  SessionEvent,
  SessionMarker,
  SessionMarkerDetail,
} from '@wrongstack/core/types';
// The marker projector itself, so a LIVE surface can render an event with the
// same wording its replay will use. Without it the SimpleUI would have had to
// hand-write a second copy of every marker sentence.
export {
  isSystemInjectedMessage,
  sessionEventToMarker,
  SYSTEM_INJECTION_PREFIXES,
} from '@wrongstack/core/types/session-markers';
export {
  projectSessionTimeline,
  projectSessionToolMeta,
} from '@wrongstack/core/types/session-timeline';
export {
  CLIENT_MESSAGE_TYPES,
  type ExactClientMessageType,
  type ExactServerMessageType,
  isRegisteredMessageType,
  SERVER_MESSAGE_TYPES,
} from './registry.js';
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

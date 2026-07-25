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
  REPLAY_MESSAGE_CAP,
  type ReplayPayloadFields,
  type ReplaySource,
} from './replay-payload.js';
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

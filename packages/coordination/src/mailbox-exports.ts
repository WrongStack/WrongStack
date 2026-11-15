export { resolveProjectDir } from './global-mailbox-paths.js';

export { type MailToolsOptions, makeMailInboxTool, makeMailSendTool } from './mail-tools.js';

// Mailbox - inter-agent messaging
export type {
  MailboxActionInput,
  MailboxActionResult,
  MailboxMessageAction,
} from './mailbox-actions.js';

export { actionToAckInput } from './mailbox-actions.js';

export {
  parseMailboxAckInput,
  parseMailboxQueryInput,
  parseMailboxSendInput,
} from './mailbox-codecs.js';

// Request bounds every untrusted boundary must apply. Exported so the
// out-of-package surfaces (mailbox-mcp) enforce the same ceiling as the
// in-package ones rather than inventing their own.
export {
  MAILBOX_MAX_ACK_BATCH,
  MAILBOX_MAX_BODY_LENGTH,
  MAILBOX_MAX_QUERY_LIMIT,
  MAILBOX_MAX_SUBJECT_LENGTH,
} from './mailbox-constants.js';

export type {
  MailboxCredentialVerifier,
  RedactedMailboxCredential,
} from './mailbox-credential-store.js';

export { redactMailboxCredential } from './mailbox-credential-store.js';

export {
  CREDENTIAL_VERIFY_COOLDOWN_MS,
  CREDENTIAL_VERIFY_MAX_FAILURES,
  CREDENTIAL_VERIFY_WINDOW_MS,
  CredentialVerifyThrottle,
  credentialVerifyThrottle,
} from './mailbox-credential-throttle.js';

export { MailboxEventEmitter } from './mailbox-events.js';

export {
  buildDownAlert,
  buildRecoveryAlert,
  type DownAlertInput,
  MAILBOX_HEALTH_DEFAULT_FAILURE_THRESHOLD,
  MAILBOX_HEALTH_DEFAULT_FROM,
  MAILBOX_HEALTH_DEFAULT_INTERVAL_MS,
  MAILBOX_HEALTH_DEFAULT_TIMEOUT_MS,
  type MailboxHealthEvent,
  MailboxHealthWatchdog,
  type MailboxHealthWatchdogOptions,
  type RecoveryAlertInput,
  validateWatchdogOptions,
  type WatchdogConfig,
} from './mailbox-health.js';

// ── Mailbox hooks — tool-execution integration ────────────────────────────
export {
  createMailboxHooks,
  type MailboxHooksOptions,
} from './mailbox-hooks.js';

// The actor-scoped read projection. Exported so the Mailbox MCP server binds
// its reads to the configured actor with the SAME rule the HTTP bridge
// applies, instead of shipping a second visibility implementation.
export {
  isMessageUnreadForActor,
  type MailboxActorReadScope,
  queryMessagesForActor,
  stripAggregateReceiptState,
  unreadCountForActor,
} from './mailbox-http-actor-query.js';

export {
  authorizeMailboxBearerToken,
  authorizePersistedMailboxCredential,
  createMailboxHttpRouter,
  MAILBOX_HTTP_DEFAULT_MAX_AGE_MS,
  MAILBOX_HTTP_MAX_AGE_CEILING_MS,
  MAILBOX_HTTP_MAX_BODY_BYTES,
  MAILBOX_HTTP_RATE_LIMIT_PER_MINUTE,
  MAILBOX_HTTP_RATE_LIMIT_WINDOW_MS,
  type MailboxHttpAccessDecision,
  MailboxHttpRateLimiter,
  type MailboxHttpRouter,
  type MailboxHttpRouterOptions,
} from './mailbox-http-router.js';

export {
  MailboxProjectServerConnection,
  type MailboxProjectServerConnectionState,
} from './mailbox-project-server-client.js';
// Endpoint derivation is pure and side-effect free. Exported so daemon
// inventory surfaces (`wstack doctor --daemons`) can locate this daemon
// without importing the daemon entry itself, which would start one.
export {
  mailboxProjectServerEndpoint,
  mailboxProjectServerMetadataPath,
} from './mailbox-project-server-endpoint.js';
export { isMailboxProjectServerAvailable } from './mailbox-project-server-launch.js';

export type {
  MailboxProjectServerInfo,
  MailboxProjectServerStatus,
} from './mailbox-project-server-protocol.js';

export {
  applyMailboxSendPolicy,
  type MailboxResolver,
  type MailboxToolOptions,
  mailboxSessionTag,
  makeMailboxTool,
  resolveMailboxIdentity,
} from './mailbox-tool.js';
export type {
  ActorMailboxMessage,
  AgentHeartbeatInput,
  AgentRegistrationInput,
  ClientHeartbeatInput,
  ClientRegistrationInput,
  ClientSource,
  ClientStatus,
  Mailbox,
  MailboxAckBatchInput,
  MailboxAckInput,
  MailboxAgentStatus,
  MailboxAudience,
  MailboxMessage,
  MailboxMessageProjection,
  MailboxMessageType,
  MailboxQuery,
  MailboxRecipientState,
  MailboxSendInput,
  MailboxSendTypeCheck,
  MailboxTaskContext,
  PurgeOptions,
  PurgeResult,
  ReadReceipts,
  RegisteredAgent,
} from './mailbox-types.js';
export {
  checkMailboxSendType,
  isActionRequiredForActor,
  isMailboxLeader,
  isMailboxMessageVisibleTo,
  isMailboxSendableType,
  MAILBOX_MESSAGE_TYPES,
  MAILBOX_SENDABLE_MESSAGE_TYPES,
  MAILBOX_TYPE_PROPERTIES,
  mailboxIdentityBase,
  normalizeRecipient,
  SESSION_RECIPIENT_PREFIX,
  sessionRecipient,
  validateSendType,
} from './mailbox-types.js';

export { RemoteMailboxCredentialStore } from './remote-mailbox-credential-store.js';

export {
  startTechStackConsumer,
  type TechStackConsumerOptions,
} from './techstack-mailbox-consumer.js';

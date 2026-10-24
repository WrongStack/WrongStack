export type {
  AckRecord,
  AgentHeartbeatInput,
  AgentRegistrationInput,
  AutoCompactOptions,
  AutoCompactResult,
  ClientHeartbeatInput,
  ClientRegistrationInput,
  ClientSource,
  ClientStatus,
  Mailbox,
  MailboxAckBatchInput,
  MailboxAckInput,
  MailboxAgentStatus,
  MailboxMessageProjection,
  MailboxQuery,
  MailboxRecipientState,
  MailboxSendInput,
  PurgeOptions,
  PurgeResult,
  RegisteredAgent,
  RegisteredClient,
} from '@wrongstack/contracts/types/mailbox';
export type {
  MailboxActorContext,
  MailboxAuthMode,
  MailboxCapability,
  MailboxPrincipalKind,
} from './mailbox-auth-types.js';
export {
  expandMailboxCapabilities,
  hasMailboxCapability,
  MAILBOX_CAPABILITY_IMPLICATIONS,
} from './mailbox-auth-types.js';
export type {
  ActorMailboxMessage,
  MailboxAudience,
  MailboxLegacyReportSessionAffinity,
  MailboxMessage,
  MailboxReceiptRecordV2,
  MailboxScopedSessionAffinity,
  MailboxSessionAffinity,
  MailboxTaskContext,
  ReadReceipts,
} from './mailbox-message-types.js';
export {
  isActionRequiredForActor,
  isMailboxLeader,
  isMailboxMessageVisibleTo,
  isMailboxReceiptRecordV2,
  isMailboxSenderInFamily,
  mailboxIdentityBase,
  normalizeRecipient,
  SESSION_RECIPIENT_PREFIX,
  sessionRecipient,
  validateSendType,
} from './mailbox-predicates.js';
export type { MailboxSessionAffinityContext } from './mailbox-session-sync.js';
export {
  acceptMailboxMessageForSession,
  acceptMailboxMessageForSessionSync,
} from './mailbox-session-sync.js';
export type { MailboxMessageType } from './mailbox-type-properties.js';
export { MAILBOX_TYPE_PROPERTIES } from './mailbox-type-properties.js';

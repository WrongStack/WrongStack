import type {
  MailboxAudience,
  MailboxMessage,
  MailboxSessionAffinity,
  MailboxTaskContext,
} from './mailbox-message-types.js';
import type { MailboxMessageType } from './mailbox-type-properties.js';
import type { MailboxSessionAffinityContext } from './mailbox-session-sync.js';
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
export type { MailboxMessageType } from './mailbox-type-properties.js';
export { MAILBOX_TYPE_PROPERTIES } from './mailbox-type-properties.js';
export type { MailboxSessionAffinityContext } from './mailbox-session-sync.js';

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
  acceptMailboxMessageForSession,
  acceptMailboxMessageForSessionSync,
} from './mailbox-session-sync.js';

export interface RegisteredAgent {
  agentId: string;
  sessionId: string;
  name: string;
  role?: string | undefined;
  status: 'idle' | 'running' | 'streaming' | 'waiting_user' | 'error';
  currentTool?: string | undefined;
  currentTask?: string | undefined;
  iterations: number;
  toolCalls: number;
  registeredAt: string;
  lastSeenAt: string;
  pid: number;
  source?: 'cli' | 'webui' | 'mcp' | 'acp' | 'http' | undefined;
}

export interface MailboxAgentStatus {
  agentId: string;
  name: string;
  role?: string | undefined;
  sessionId: string;
  status: 'idle' | 'running' | 'streaming' | 'waiting_user' | 'error' | 'offline';
  currentTool?: string | undefined;
  currentTask?: string | undefined;
  iterations: number;
  toolCalls: number;
  lastActivityAt: string;
  lastSeenAt: string;
  online: boolean;
  pid: number;
  source?: 'cli' | 'webui' | 'mcp' | 'acp' | 'http' | undefined;
}

export interface MailboxQuery {
  ids?: readonly string[] | undefined;
  to?: string | undefined;
  from?: string | undefined;
  unreadBy?: string | undefined;
  readerRole?: string | undefined;
  incompleteOnly?: boolean | undefined;
  includeReceiptState?: boolean | undefined;
  type?: MailboxMessageType | undefined;
  minPriority?: 'low' | 'normal' | 'high' | undefined;
  limit?: number | undefined;
  since?: string | undefined;
  /** Filters by the message's SENDER session id (origin), not the reader's session. */
  sessionId?: string | undefined;
  /**
   * Reader's current session id. When present, messages carrying a
   * session-affinity token for a DIFFERENT session are excluded, matching the
   * inbox checker's receive-side filter (mailbox-attach applySessionAffinityFilter).
   * Kept distinct from `sessionId` (sender origin) so a reader can filter by
   * both simultaneously.
   */
  currentSessionId?: string | undefined;
  /** Resolver + unscoped policy for session-affinity tokens (see acceptMailboxMessageForSession). */
  sessionAffinityCtx?: MailboxSessionAffinityContext | undefined;
  includeDeleted?: boolean | undefined;
  replyTo?: string | undefined;
}

export interface MailboxSendInput {
  from: string;
  to: string;
  type: MailboxMessageType;
  audience?: MailboxAudience | undefined;
  subject: string;
  body: string;
  priority?: 'low' | 'normal' | 'high' | undefined;
  replyTo?: string | undefined;
  taskContext?: MailboxTaskContext | undefined;
  senderSessionId?: string | undefined;
  sessionAffinity?: MailboxSessionAffinity | undefined;
  ttlMs?: number | undefined;
}

export interface AckRecord {
  __ack: true;
  messageId: string;
  readerId: string;
  timestamp: string;
  read: boolean;
  completed?: boolean | undefined;
  completedBy?: string | undefined;
  outcome?: string | undefined;
  deleted?: boolean | undefined;
  deletedBy?: string | undefined;
}

export interface MailboxAckInput {
  messageId: string;
  readerId: string;
  read?: boolean | undefined;
  completed?: boolean | undefined;
  outcome?: string | undefined;
}

export interface MailboxAckBatchInput {
  acks: MailboxAckInput[];
}

export interface AgentRegistrationInput {
  agentId: string;
  sessionId: string;
  name: string;
  role?: string | undefined;
  pid?: number | undefined;
  source?: 'cli' | 'webui' | 'mcp' | 'acp' | 'http' | undefined;
}

export type ClientSource = 'repl' | 'tui' | 'webui' | 'http';

export interface RegisteredClient {
  clientId: string;
  sessionId: string;
  name: string;
  source: ClientSource;
  registeredAt: string;
  lastSeenAt: string;
  pid: number;
}

export interface ClientStatus {
  clientId: string;
  name: string;
  source: ClientSource;
  sessionId: string;
  lastSeenAt: string;
  online: boolean;
  pid: number;
}

export interface ClientRegistrationInput {
  clientId: string;
  sessionId: string;
  name: string;
  source: ClientSource;
  pid?: number | undefined;
}

export interface ClientHeartbeatInput {
  clientId: string;
  sessionId?: string | undefined;
}

export interface AgentHeartbeatInput {
  agentId: string;
  status?: RegisteredAgent['status'] | undefined;
  currentTool?: string | undefined;
  currentTask?: string | undefined;
  iterations?: number | undefined;
  toolCalls?: number | undefined;
  /**
   * Identity fields, carried so a heartbeat can REBUILD a pruned row.
   *
   * A registry row is deleted once it is older than AGENT_STALE_MS — either by
   * the agent's own prune or by any observer calling getAgentStatuses(). Without
   * these, `heartbeat` can only refresh a row that still exists, so a live agent
   * that lost its row stays invisible forever (it never calls registerAgent
   * again). They are optional to keep the RPC wire-compatible: a caller that
   * omits them gets the previous refresh-only behavior.
   */
  sessionId?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  pid?: number | undefined;
  source?: 'cli' | 'webui' | 'mcp' | 'acp' | 'http' | undefined;
}

export interface PurgeOptions {
  completedMaxAgeMs?: number | undefined;
  incompleteMaxAgeMs?: number | undefined;
}

export interface PurgeResult {
  completedPurged: number;
  incompletePurged: number;
  totalPurged: number;
  remaining: number;
}

export interface AutoCompactOptions {
  readMaxAgeMs?: number | undefined;
  defaultTtlMs?: number | undefined;
  typeTtlMs?: Readonly<Record<string, number>> | undefined;
  completedMaxAgeMs?: number | undefined;
  incompleteMaxAgeMs?: number | undefined;
  intervalMs?: number | undefined;
  includePurgeStale?: boolean | undefined;
}

export interface AutoCompactResult {
  readByAllRemoved: number;
  expiredRemoved: number;
  stalePurged: number;
  totalRemoved: number;
  remaining: number;
}

export interface Mailbox {
  send(input: MailboxSendInput): Promise<MailboxMessage>;
  query(query: MailboxQuery): Promise<MailboxMessage[]>;
  ack(input: MailboxAckInput): Promise<MailboxMessage | null>;
  ackMany(input: MailboxAckBatchInput): Promise<MailboxMessage[]>;
  softDelete(mailId: string, by: string): Promise<MailboxMessage | null>;
  restore(mailId: string): Promise<MailboxMessage | null>;
  getAgentStatuses(): Promise<MailboxAgentStatus[]>;
  getOnlineAgents(): Promise<MailboxAgentStatus[]>;
  registerAgent(input: AgentRegistrationInput): Promise<void>;
  deregisterAgent(agentId: string): Promise<void>;
  heartbeat(input: AgentHeartbeatInput): Promise<void>;
  unreadCount(
    forAgentId: string,
    sessionId?: string,
    ctx?: MailboxSessionAffinityContext,
  ): Promise<number>;
  close(): Promise<void>;
  clearAll(): Promise<void>;
  purgeStale(opts?: PurgeOptions): Promise<PurgeResult>;
  autoCompact(opts?: AutoCompactOptions): Promise<AutoCompactResult>;
  startAutoCompactTimer(opts?: AutoCompactOptions): () => void;
  registerClient(input: ClientRegistrationInput): Promise<void>;
  clientHeartbeat(input: ClientHeartbeatInput): Promise<void>;
  deregisterClient(clientId: string): Promise<void>;
  getClientStatuses(): Promise<ClientStatus[]>;
  purgeClients(): Promise<number>;
}

export interface MailboxRecipientState {
  actorId: string;
  readAt?: string | undefined;
  completedAt?: string | undefined;
  completedBy?: string | undefined;
  outcome?: string | undefined;
}

export interface MailboxMessageProjection extends MailboxMessage {
  recipientState: Readonly<Record<string, MailboxRecipientState>>;
  legacyGlobalCompletion?: boolean | undefined;
}

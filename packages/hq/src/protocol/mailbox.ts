import type { HqMailboxEventAction } from '@wrongstack/contracts/types/hq-mailbox-publisher';

export type HqMailboxMessageType =
  | 'note'
  | 'ask'
  | 'assign'
  | 'steer'
  | 'btw'
  | 'broadcast'
  | 'status'
  | 'result'
  | 'review'
  | 'control';

export type HqMailboxPriority = 'low' | 'normal' | 'high';
export type HqMailboxAudience = 'all' | 'leaders';

export type HqMailboxAgentStatus =
  | 'idle'
  | 'running'
  | 'streaming'
  | 'waiting_user'
  | 'error'
  | 'offline';

/** Delivery scope derived from the recipient address. */
export type HqMailboxMessageScope = 'project' | 'session' | 'agent';

export interface HqMailboxMessageSummary {
  mailId: string; // unique UUID per message record, used for deduplication
  messageId: string;
  from: string;
  to: string;
  /** Delivery scope inferred from `to` for UI labeling. */
  scope: HqMailboxMessageScope;
  /** Session id from `to` when `scope === 'session'`. */
  recipientSessionId?: string;
  type: HqMailboxMessageType;
  audience?: HqMailboxAudience;
  subject: string;
  priority: HqMailboxPriority;
  timestamp: string;
  replyTo?: string;
  senderSessionId?: string;
  completed: boolean;
  completedBy?: string;
  completedAt?: string;
  unreadCount?: number;
  readCount?: number;
  hasBody: boolean;
  bodyPreview?: string;
  outcomePreview?: string;
  task?: {
    taskId?: string;
    agentRole?: string;
    agentName?: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  };
}

export interface HqMailboxAgentSummary {
  agentId: string;
  name: string;
  role?: string;
  sessionId: string;
  status: HqMailboxAgentStatus;
  currentTool?: string;
  currentTask?: string;
  iterations: number;
  toolCalls: number;
  lastActivityAt: string;
  lastSeenAt: string;
  online: boolean;
  source?: 'cli' | 'webui' | 'mcp' | 'acp' | 'http';
}

export interface HqMailboxSnapshotPayload {
  mailboxId: string;
  scope: 'project' | 'global';
  messages: readonly HqMailboxMessageSummary[];
  agents: readonly HqMailboxAgentSummary[];
  totals: {
    messages: number;
    unread: number;
    incomplete: number;
    highPriority: number;
    onlineAgents: number;
  };
}

export interface HqMailboxEventPayload {
  mailboxId: string;
  action: HqMailboxEventAction;
  message?: HqMailboxMessageSummary;
  agent?: HqMailboxAgentSummary;
  summary?: string;
}

export interface HqMailboxSummary {
  mailboxId: string;
  projectId: string;
  scope: 'project' | 'global';
  messageCount: number;
  unreadCount: number;
  incompleteCount: number;
  highPriorityCount: number;
  onlineAgentCount: number;
  lastActivityAt: string;
}

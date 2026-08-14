/**
 * Shared mailbox message DTOs.
 *
 * Dependency leaf consumed by the mailbox helpers (mailbox-predicates,
 * mailbox-session-sync) and re-exported through the mailbox-types facade.
 * Splitting these out of the facade breaks the type-level module SCC the
 * architecture gate (ARCH-CYCLE-TYPE check) reports between the helpers and
 * the facade.
 */

import type { MailboxMessageType } from './mailbox-type-properties.js';

export type MailboxAudience = 'all' | 'leaders';

export interface ReadReceipts {
  [agentId: string]: string;
}

export interface MailboxTaskContext {
  agentRole?: string | undefined;
  agentName?: string | undefined;
  taskId?: string | undefined;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | undefined;
}

export interface MailboxScopedSessionAffinity {
  sessionId: string;
  reportId?: string | undefined;
  kind?: string | undefined;
}

export interface MailboxLegacyReportSessionAffinity {
  sessionId?: undefined;
  reportId: string;
  kind?: string | undefined;
}

export type MailboxSessionAffinity =
  | MailboxScopedSessionAffinity
  | MailboxLegacyReportSessionAffinity;

export interface MailboxMessage {
  id: string;
  from: string;
  to: string;
  type: MailboxMessageType;
  audience?: MailboxAudience | undefined;
  subject: string;
  body: string;
  priority: 'low' | 'normal' | 'high';
  readBy: ReadReceipts;
  completed: boolean;
  completedBy?: string | undefined;
  outcome?: string | undefined;
  timestamp: string;
  completedAt?: string | undefined;
  deletedAt?: string | undefined;
  deletedBy?: string | undefined;
  replyTo?: string | undefined;
  taskContext?: MailboxTaskContext | undefined;
  senderSessionId?: string | undefined;
  sessionAffinity?: MailboxSessionAffinity | undefined;
  expiresAt?: string | undefined;
}

export interface MailboxReceiptRecordV2 {
  __mailboxReceipt: 2;
  messageId: string;
  actorId: string;
  timestamp: string;
  read?: boolean | undefined;
  completed?: boolean | undefined;
  outcome?: string | undefined;
}

export interface ActorMailboxMessage
  extends Omit<MailboxMessage, 'readBy' | 'completed' | 'completedBy' | 'completedAt' | 'outcome'> {
  readByMe: boolean;
  completedByMe: boolean;
  actionRequiredForMe: boolean;
  myOutcome?: string | undefined;
  legacyGlobalCompletion?: boolean | undefined;
}

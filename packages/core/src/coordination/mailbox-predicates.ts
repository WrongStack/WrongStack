import { MAILBOX_TYPE_PROPERTIES, type MailboxMessageType } from './mailbox-type-properties.js';
import type {
  ActorMailboxMessage,
  MailboxMessage,
  MailboxReceiptRecordV2,
} from './mailbox-message-types.js';

export function mailboxIdentityBase(agentId: string): string {
  if (typeof agentId !== 'string') return '';
  return agentId.split(/[@#]/, 1)[0]!.trim().toLowerCase();
}

export function isMailboxLeader(agentId: string, role?: string): boolean {
  return mailboxIdentityBase(agentId) === 'leader' || role?.trim().toLowerCase() === 'leader';
}

export function isMailboxSenderInFamily(senderId: string, family: string): boolean {
  const base = mailboxIdentityBase(senderId);
  const normalizedFamily = family.trim().toLowerCase();
  if (normalizedFamily.length === 0) return false;
  return base === normalizedFamily || base.startsWith(`${normalizedFamily}-`);
}

export function isMailboxMessageVisibleTo(
  message: Pick<MailboxMessage, 'audience'>,
  agentId: string,
  role?: string,
): boolean {
  return message.audience !== 'leaders' || isMailboxLeader(agentId, role);
}

export function validateSendType(type: MailboxMessageType, to: string): void {
  if (type === 'control') {
    throw new TypeError('Type "control" is reserved for runtime use and cannot be set by agents');
  }
  const isMultiRecipient = to === '*' || to.startsWith('@session:');
  if (type === 'assign' && isMultiRecipient) {
    throw new TypeError(
      `Type "assign" requires a specific recipient — multi-recipient target "${to}" is ambiguous`,
    );
  }
  if (type === 'steer' && isMultiRecipient) {
    throw new TypeError(
      `Type "steer" requires a specific recipient — multi-recipient target "${to}" is ambiguous`,
    );
  }
}

export const SESSION_RECIPIENT_PREFIX = '@session:';

export function sessionRecipient(sessionId: string): string {
  const normalizedSessionId = sessionId.trim().replace(/\\/g, '/');
  if (!normalizedSessionId) {
    throw new TypeError('sessionId is required for the "@session" recipient');
  }
  return `${SESSION_RECIPIENT_PREFIX}${normalizedSessionId}`;
}

export function normalizeRecipient(to: string, sessionId?: string): string {
  const trimmed = to.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === 'all') return '*';
  if (normalized === '@session') return sessionRecipient(sessionId ?? '');
  return trimmed;
}

export function isMailboxReceiptRecordV2(value: unknown): value is MailboxReceiptRecordV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v['__mailboxReceipt'] !== 2) return false;
  if (typeof v['messageId'] !== 'string' || v['messageId'].length === 0) return false;
  if (typeof v['actorId'] !== 'string' || v['actorId'].length === 0) return false;
  if (typeof v['timestamp'] !== 'string' || v['timestamp'].length === 0) return false;
  if ('read' in v && typeof v['read'] !== 'boolean') return false;
  if ('completed' in v && typeof v['completed'] !== 'boolean') return false;
  if ('outcome' in v && v['outcome'] !== undefined && typeof v['outcome'] !== 'string')
    return false;
  return true;
}

export function isActionRequiredForActor(
  message: Pick<MailboxMessage, 'type' | 'deletedAt' | 'completed'>,
  projection: Pick<ActorMailboxMessage, 'completedByMe' | 'legacyGlobalCompletion'>,
): boolean {
  if (projection.legacyGlobalCompletion) return false;
  if (message.deletedAt !== undefined) return false;
  if (projection.completedByMe) return false;
  return MAILBOX_TYPE_PROPERTIES[message.type]?.requiresAction === true;
}

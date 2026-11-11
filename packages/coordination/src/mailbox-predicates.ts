import { SESSION_RECIPIENT_PREFIX } from '@wrongstack/contracts/types/mailbox';
import type {
  ActorMailboxMessage,
  MailboxMessage,
  MailboxReceiptRecordV2,
} from './mailbox-message-types.js';
import {
  MAILBOX_SENDABLE_MESSAGE_TYPES,
  MAILBOX_TYPE_PROPERTIES,
  type MailboxMessageType,
} from './mailbox-type-properties.js';

/** Every message type a human or an agent may send (`control` excluded). */
const SENDABLE_TYPE_SET: ReadonlySet<string> = new Set(MAILBOX_SENDABLE_MESSAGE_TYPES);

/**
 * Is this string a message type that may be SENT?
 *
 * `control` is a member of the `MailboxMessageType` union but is reserved
 * for the runtime, so it is rejected here even though the union contains it.
 */
export function isMailboxSendableType(
  value: string,
): value is Exclude<MailboxMessageType, 'control'> {
  return SENDABLE_TYPE_SET.has(value);
}

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

/**
 * The outcome of the shared send-type check.
 *
 * `ok: false` carries the SAME message on every surface, so the CLI/agent
 * tools, the HTTP bridge and the WebSocket validator cannot drift into three
 * different answers for the same (type, recipient) pair.
 */
export type MailboxSendTypeCheck = { ok: true } | { ok: false; error: string };

/**
 * The canonical send-type rule.
 *
 * One implementation, used by every send boundary:
 * - `control` is reserved for the runtime and may never be sent.
 * - `assign` and `steer` need a SPECIFIC recipient: a broadcast (`*`) or a
 *   session address (`@session:<id>`) is ambiguous.
 *
 * @returns `{ ok: true }` when the (type, recipient) pair may be sent.
 */
export function checkMailboxSendType(type: MailboxMessageType, to: string): MailboxSendTypeCheck {
  if (type === 'control') {
    return {
      ok: false,
      error: 'Type "control" is reserved for runtime use and cannot be set by agents',
    };
  }
  const isMultiRecipient = to === '*' || to.startsWith('@session:');
  if ((type === 'assign' || type === 'steer') && isMultiRecipient) {
    return {
      ok: false,
      error: `Type "${type}" requires a specific recipient — multi-recipient target "${to}" is ambiguous`,
    };
  }
  return { ok: true };
}

/**
 * Throw the shared send-type rule as a `TypeError`.
 *
 * The throwing form kept for the in-process callers; the rule itself lives
 * in {@link checkMailboxSendType} so every surface answers identically.
 */
export function validateSendType(type: MailboxMessageType, to: string): void {
  const result = checkMailboxSendType(type, to);
  if (!result.ok) throw new TypeError(result.error);
}

export { SESSION_RECIPIENT_PREFIX };

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

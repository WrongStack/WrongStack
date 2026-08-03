import type {
  AckRecord,
  MailboxAudience,
  MailboxMessage,
  MailboxMessageType,
  MailboxSessionAffinity,
  MailboxTaskContext,
  ReadReceipts,
} from './mailbox-types.js';
import { LINE_SEPARATOR } from './mailbox-constants.js';
import { normalizeRecipient, validateSendType } from './mailbox-types.js';

const MESSAGE_TYPES = new Set<MailboxMessageType>([
  'note',
  'ask',
  'assign',
  'steer',
  'btw',
  'broadcast',
  'status',
  'result',
  'review',
  'control',
]);

const PRIORITIES = new Set<MailboxMessage['priority']>(['low', 'normal', 'high']);
const AUDIENCES = new Set<MailboxAudience>(['all', 'leaders']);
const TASK_STATUSES = new Set([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'idle',
  'running',
  'streaming',
  'waiting_user',
  'error',
  'offline',
  'busy',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new TypeError(`mailbox message field "${key}" must be a string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = record[key];
  if (value === undefined) return {};
  if (typeof value !== 'string') {
    throw new TypeError(`mailbox message field "${key}" must be a string when present`);
  }
  return { [key]: value };
}

function parseMessageType(value: unknown): MailboxMessageType {
  if (value === 'info') return 'note';
  if (value === 'task') return 'assign';
  if (typeof value === 'string' && MESSAGE_TYPES.has(value as MailboxMessageType)) {
    return value as MailboxMessageType;
  }
  throw new TypeError('mailbox message field "type" is invalid');
}

/** Normalize message types emitted by pre-union mailbox builds. */
export function normalizeMailboxMessageType(value: unknown): MailboxMessageType {
  return parseMessageType(value);
}

/**
 * Resolve the message type for a SEND operation, applying default-type logic
 * and cross-field validation.
 *
 * ** Default-type rules ** (mirror the `mail_send` tool's logic):
 * - When `type` is explicitly provided, use it directly.
 * - When `type` is omitted AND the resolved `to` is `"*"` or starts with
 *   `"@session:"`, the default is `"broadcast"`.
 * - Otherwise (omitted, non-broadcast target), the default is `"note"`.
 *
 * **Send-side validation** (from `validateSendType`):
 * - `control` is rejected — it is reserved for runtime use.
 * - `assign` and `steer` with `to="*"` are rejected — these types require a
 *   specific recipient.
 *
 * @returns The resolved type (explicit or defaulted).
 * @throws {TypeError} When the type is reserved or the (type, to) pair is
 *   semantically invalid.
 */
export function resolveSendType(
  type: MailboxMessageType | undefined,
  to: string,
): MailboxMessageType {
  // Normalize recipient aliases ("all" → "*", "@session" → "@session:<id>")
  // BEFORE default-type selection and cross-field validation, so every
  // caller (mail_send, mailbox tool, HTTP bridge) gets consistent behavior
  // even when they forget to normalize beforehand.
  const normalizedTo = normalizeRecipient(to);
  const resolved: MailboxMessageType =
    type ?? (normalizedTo === '*' || normalizedTo.startsWith('@session:') ? 'broadcast' : 'note');
  // Validate the resolved type against the CANONICAL recipient — after
  // normalization — so "all" with type "assign" is correctly rejected
  // as a multi-recipient target.
  validateSendType(resolved, normalizedTo);
  return resolved;
}

/**
 * Resolve the message type for a SEND, returning a descriptive error instead
 * of throwing. Convenience wrapper for use in tool handlers where a thrown
 * TypeError would be awkward to catch.
 *
 * Returns `{ ok: true, type }` on success, or `{ ok: false, error }` when
 * the (type, to) pair is invalid.
 */
export function resolveSendTypeSafe(
  type: MailboxMessageType | undefined,
  to: string,
): { ok: true; type: MailboxMessageType } | { ok: false; error: string } {
  try {
    return { ok: true, type: resolveSendType(type, to) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function parsePriority(value: unknown): MailboxMessage['priority'] {
  if (typeof value === 'string' && PRIORITIES.has(value as MailboxMessage['priority'])) {
    return value as MailboxMessage['priority'];
  }
  // Older callers were intentionally tolerant here and ranked unknown values
  // as normal. Normalize rather than dropping an otherwise valid message.
  if (typeof value === 'string') return 'normal';
  throw new TypeError('mailbox message field "priority" must be a string');
}

function parseAudience(value: unknown): MailboxAudience | undefined {
  if (value === undefined || value === 'all') return undefined;
  if (typeof value === 'string' && AUDIENCES.has(value as MailboxAudience)) {
    return value as MailboxAudience;
  }
  throw new TypeError('mailbox message field "audience" is invalid');
}

function parseReadReceipts(record: Record<string, unknown>, to: string): ReadReceipts {
  const value = record['readBy'];
  if (value === undefined) {
    const legacyReadAt = record['readAt'];
    return record['read'] === true && typeof legacyReadAt === 'string'
      ? { [to || 'unknown']: legacyReadAt }
      : {};
  }
  if (!isRecord(value)) {
    throw new TypeError('mailbox message field "readBy" must be an object');
  }

  const receipts: ReadReceipts = {};
  for (const [agentId, timestamp] of Object.entries(value)) {
    if (typeof timestamp !== 'string') {
      throw new TypeError('mailbox message read receipt timestamps must be strings');
    }
    receipts[agentId] = timestamp;
  }
  return receipts;
}

function parseTaskContext(value: unknown): MailboxTaskContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError('mailbox message field "taskContext" must be an object');
  }

  const status = value['status'];
  if (
    status !== undefined &&
    (typeof status !== 'string' ||
      !TASK_STATUSES.has(status as NonNullable<MailboxTaskContext['status']>))
  ) {
    throw new TypeError('mailbox message taskContext status is invalid');
  }

  return {
    ...optionalString(value, 'agentRole'),
    ...optionalString(value, 'agentName'),
    ...optionalString(value, 'taskId'),
    ...(status === undefined
      ? {}
      : { status: status as NonNullable<MailboxTaskContext['status']> }),
  };
}

/**
 * Parse and structurally validate a `MailboxSessionAffinity` token persisted
 * on a mailbox message. The token is the trust boundary that lets the
 * recipient's leader filter drop cross-session chimera reports — see
 * `acceptMailboxMessageForSession` in `mailbox-types.ts`. The codec MUST
 * reject malformed tokens here so a tampered JSONL line cannot smuggle a
 * fake affinity through the receiver-side check.
 */
function parseSessionAffinity(value: unknown): MailboxSessionAffinity | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError('mailbox message field "sessionAffinity" must be an object');
  }
  const sessionId = value['sessionId'];
  const reportId = value['reportId'];
  const kind = optionalString(value, 'kind');
  if (sessionId !== undefined) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('mailbox message sessionAffinity.sessionId must be a non-empty string');
    }
    return {
      sessionId,
      ...optionalString(value, 'reportId'),
      ...kind,
    };
  }
  if (typeof reportId !== 'string' || reportId.length === 0) {
    throw new TypeError(
      'mailbox message sessionAffinity.reportId must be a non-empty string when sessionId is absent',
    );
  }
  return {
    reportId,
    ...kind,
  };
}

/** Parse, migrate, and structurally validate one persisted mailbox message. */
export function parseMailboxMessage(value: unknown): MailboxMessage {
  if (!isRecord(value)) throw new TypeError('mailbox message must be an object');

  const to = value['to'] === undefined ? '' : requiredString(value, 'to');
  const completed = value['completed'];
  if (typeof completed !== 'boolean') {
    throw new TypeError('mailbox message field "completed" must be a boolean');
  }

  const taskContext = parseTaskContext(value['taskContext']);
  const audience = parseAudience(value['audience']);
  const sessionAffinity = parseSessionAffinity(value['sessionAffinity']);
  return {
    id: requiredString(value, 'id'),
    from: requiredString(value, 'from'),
    to,
    type: parseMessageType(value['type']),
    ...(audience === undefined ? {} : { audience }),
    subject: requiredString(value, 'subject'),
    body: requiredString(value, 'body'),
    priority: parsePriority(value['priority']),
    readBy: parseReadReceipts(value, to),
    completed,
    timestamp: requiredString(value, 'timestamp'),
    ...optionalString(value, 'completedBy'),
    ...optionalString(value, 'outcome'),
    ...optionalString(value, 'completedAt'),
    ...optionalString(value, 'deletedAt'),
    ...optionalString(value, 'deletedBy'),
    ...optionalString(value, 'replyTo'),
    ...optionalString(value, 'senderSessionId'),
    ...optionalString(value, 'expiresAt'),
    ...(taskContext === undefined ? {} : { taskContext }),
    ...(sessionAffinity === undefined ? {} : { sessionAffinity }),
  };
}

/** Parse one JSONL line and validate the decoded mailbox message. */
export function parseMailboxMessageLine(line: string): MailboxMessage {
  return parseMailboxMessage(JSON.parse(line) as unknown);
}

// ── Ack record helpers ─────────────────────────────────────────────────

/**
 * Check if a parsed JSONL value is an append-only ack record (not a message).
 * Ack records carry a `__ack: true` discriminator.
 */
export function isAckRecord(value: unknown): value is AckRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['__ack'] === true
  );
}

/**
 * Parse one JSONL line, returning either a MailboxMessage or an AckRecord.
 * Returns null when the line is neither (corrupt/malformed).
 */
export function parseMailboxLine(line: string): MailboxMessage | AckRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (isAckRecord(parsed)) return parsed;
    return parseMailboxMessage(parsed);
  } catch {
    return null;
  }
}

/** Parse a JSONL mailbox body into messages, applying append-only ack records. */
export function parseMailboxLines(raw: string): MailboxMessage[] {
  const lines = raw.split(LINE_SEPARATOR).filter((line) => line.trim().length > 0);
  const messages: MailboxMessage[] = [];
  const acks: AckRecord[] = [];
  for (const line of lines) {
    const parsed = parseMailboxLine(line);
    if (isAckRecord(parsed)) {
      acks.push(parsed);
    } else if (parsed !== null) {
      messages.push(parsed);
    }
  }
  for (const ack of acks) {
    const target = messages.find((message) => message.id === ack.messageId);
    if (target) applyAckToMessage(target, ack);
  }
  return messages;
}

/**
 * Apply an ack record's effects to a MailboxMessage in-place.
 * This mutates the message object (readBy, completed, completedBy, completedAt,
 * outcome, deletedAt, deletedBy).
 */
export function applyAckToMessage(msg: MailboxMessage, ack: AckRecord): void {
  if (ack.read && !(ack.readerId in msg.readBy)) {
    msg.readBy[ack.readerId] = ack.timestamp;
  }
  if (ack.completed && !msg.completed) {
    msg.completed = true;
    msg.completedBy = ack.completedBy ?? ack.readerId;
    msg.completedAt = ack.timestamp;
  }
  if (ack.outcome !== undefined && msg.outcome !== ack.outcome) {
    msg.outcome = ack.outcome;
  }
  // Soft-delete: set deletedAt/deletedBy.
  if (ack.deleted === true) {
    msg.deletedAt = ack.timestamp;
    msg.deletedBy = ack.deletedBy ?? ack.readerId;
  }
  // Restore: clear deletedAt/deletedBy.
  if (ack.deleted === false) {
    delete msg.deletedAt;
    delete msg.deletedBy;
  }
}

/**
 * Serialize an ack record to a JSONL line.
 */
export function serializeAckRecord(ack: AckRecord): string {
  return JSON.stringify(ack) + '\n';
}

/**
 * Serialize a MailboxMessage to a JSONL line.
 *
 * Strips any extra fields added by a projection (recipientState,
 * legacyGlobalCompletion) so compaction rewrites produce clean
 * v1-parseable lines. V2 receipt records are preserved as separate
 * lines — they are NOT embedded in the message object.
 */
export function serializeMailboxMessage(msg: MailboxMessage): string {
  const obj: Record<string, unknown> = {
    id: msg.id,
    from: msg.from,
    to: msg.to,
    type: msg.type,
    subject: msg.subject,
    body: msg.body,
    priority: msg.priority,
    readBy: msg.readBy,
    completed: msg.completed,
    timestamp: msg.timestamp,
  };
  if (msg.audience !== undefined && msg.audience !== 'all') obj.audience = msg.audience;
  if (msg.completedBy !== undefined) obj.completedBy = msg.completedBy;
  if (msg.outcome !== undefined) obj.outcome = msg.outcome;
  if (msg.completedAt !== undefined) obj.completedAt = msg.completedAt;
  if (msg.deletedAt !== undefined) obj.deletedAt = msg.deletedAt;
  if (msg.deletedBy !== undefined) obj.deletedBy = msg.deletedBy;
  if (msg.replyTo !== undefined) obj.replyTo = msg.replyTo;
  if (msg.senderSessionId !== undefined) obj.senderSessionId = msg.senderSessionId;
  if (msg.expiresAt !== undefined) obj.expiresAt = msg.expiresAt;
  if (msg.taskContext !== undefined) obj.taskContext = msg.taskContext;
  if (msg.sessionAffinity !== undefined) obj.sessionAffinity = msg.sessionAffinity;
  return JSON.stringify(obj) + '\n';
}

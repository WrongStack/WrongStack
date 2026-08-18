/**
 * Reusable Global Mailbox fixtures for the P0 contract-repair effort.
 *
 * These builders construct `MailboxMessage` and `AckRecord` objects in the
 * exact wire format the JSONL codec expects, without requiring a live
 * `SqliteMailbox` instance or filesystem I/O. They are used by:
 *
 * - `global-mailbox.test.ts` — baseline behavioral snapshots
 * - `mailbox-v2-migration.test.ts` (GM-P0.12) — mixed-log migration
 * - `mailbox-contract-matrix.test.ts` (GM-P0.11) — cross-surface parity
 *
 * Every builder returns a plain object. Callers serialize with
 * `JSON.stringify(...)` when writing raw JSONL for fixture files.
 *
 * @module mailbox-fixtures
 */

import { randomUUID } from 'node:crypto';
import type {
  AckRecord,
  MailboxAudience,
  MailboxMessage,
  MailboxMessageType,
  MailboxSendInput,
} from '../../../../src/coordination/mailbox-types.js';

// ── Timestamp helpers ──────────────────────────────────────────────────

/** Fixed reference timestamp so snapshots are deterministic. */
export const FIXTURE_TIME = '2026-07-01T00:00:00.000Z';

/** One second after the reference. */
export const FIXTURE_TIME_PLUS_1S = '2026-07-01T00:00:01.000Z';

/** One minute after the reference. */
export const FIXTURE_TIME_PLUS_1M = '2026-07-01T00:01:00.000Z';

/** One hour after the reference. */
export const FIXTURE_TIME_PLUS_1H = '2026-07-01T01:00:00.000Z';

/** One day after the reference. */
export const FIXTURE_TIME_PLUS_1D = '2026-07-02T00:00:00.000Z';

// ── Message builders ───────────────────────────────────────────────────

export interface FixtureMessageOverrides extends Partial<Omit<MailboxMessage, 'id'>> {
  id?: string | undefined;
}

/**
 * Build a minimal valid v1 `MailboxMessage` with deterministic defaults.
 * Override any field via `overrides`.
 */
export function buildV1Message(overrides: FixtureMessageOverrides = {}): MailboxMessage {
  return {
    id: overrides.id ?? randomUUID(),
    from: overrides.from ?? ('sender@example' as never),
    to: overrides.to ?? ('recipient@example' as never),
    type: overrides.type ?? 'note',
    subject: overrides.subject ?? 'Test subject',
    body: overrides.body ?? 'Test body',
    priority: overrides.priority ?? 'normal',
    readBy: overrides.readBy ?? {},
    completed: overrides.completed ?? false,
    timestamp: overrides.timestamp ?? FIXTURE_TIME,
    ...overrides,
  };
}

/** Build a message for every declared `MailboxMessageType`. */
export function buildAllTypeMessages(
  base: Pick<MailboxMessage, 'from' | 'to'>,
): MailboxMessage[] {
  const types: MailboxMessageType[] = [
    'note', 'ask', 'assign', 'steer', 'btw', 'broadcast', 'status', 'result', 'review',
    // 'control' is reserved — not included; tests that need it construct manually.
  ];
  return types.map((type, i) =>
    buildV1Message({
      ...base,
      id: `msg-${type}`,
      type,
      subject: `Subject for ${type}`,
      body: `Body for ${type}`,
      timestamp: `2026-07-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    }),
  );
}

/** Build messages for every recipient form. */
export function buildAllRecipientForms(sender = 'sender@example'): MailboxMessage[] {
  return [
    buildV1Message({ id: 'msg-direct', from: sender, to: 'agent-a', subject: 'direct' }),
    buildV1Message({ id: 'msg-base-alias', from: sender, to: 'leader', subject: 'base alias' }),
    buildV1Message({
      id: 'msg-session',
      from: sender,
      to: '@session:sess-123',
      subject: 'session broadcast',
      senderSessionId: 'sess-123',
    }),
    buildV1Message({ id: 'msg-broadcast', from: sender, to: '*', subject: 'project broadcast' }),
  ];
}

/** Build messages for every priority. */
export function buildAllPriorities(): MailboxMessage[] {
  return (['low', 'normal', 'high'] as const).map((p) =>
    buildV1Message({ id: `msg-pri-${p}`, priority: p, subject: `priority ${p}` }),
  );
}

/** Build a leader-only audience message. */
export function buildLeadersOnlyMessage(overrides: FixtureMessageOverrides = {}): MailboxMessage {
  return buildV1Message({
    id: 'msg-leaders-only',
    to: 'leader',
    audience: 'leaders' as MailboxAudience,
    subject: 'leaders only',
    ...overrides,
  });
}

/** Build a message with a replyTo parent. */
export function buildReplyMessage(parentId: string, overrides: FixtureMessageOverrides = {}): MailboxMessage {
  return buildV1Message({
    id: 'msg-reply',
    subject: 'reply',
    replyTo: parentId,
    ...overrides,
  });
}

/** Build a thread of parent + N replies for replyTo query testing. */
export function buildReplyThread(parentId: string, replyCount: number): { parent: MailboxMessage; replies: MailboxMessage[] } {
  const parent = buildV1Message({ id: parentId, subject: 'parent message' });
  const replies = Array.from({ length: replyCount }, (_, i) =>
    buildReplyMessage(`${parentId}-reply-${i}`, {
      id: `${parentId}-reply-${i}`,
      replyTo: parentId,
      timestamp: `2026-07-01T00:00:${String(i + 1).padStart(2, '0')}.000Z`,
    }),
  );
  return { parent, replies };
}

// ── Read-state messages ────────────────────────────────────────────────

/** Build a message already read by one or more agents. */
export function buildReadMessage(readers: string[], overrides: FixtureMessageOverrides = {}): MailboxMessage {
  const readBy: Record<string, string> = {};
  for (const reader of readers) readBy[reader] = FIXTURE_TIME_PLUS_1S;
  return buildV1Message({ readBy, ...overrides });
}

/** Build a completed message (legacy global completion). */
export function buildCompletedMessage(completedBy = 'agent-a', overrides: FixtureMessageOverrides = {}): MailboxMessage {
  return buildV1Message({
    completed: true,
    completedBy,
    completedAt: FIXTURE_TIME_PLUS_1S,
    outcome: 'resolved',
    readBy: { [completedBy]: FIXTURE_TIME },
    ...overrides,
  });
}

/** Build a soft-deleted message. */
export function buildDeletedMessage(deletedBy = 'operator', overrides: FixtureMessageOverrides = {}): MailboxMessage {
  return buildV1Message({
    deletedAt: FIXTURE_TIME_PLUS_1S,
    deletedBy,
    ...overrides,
  });
}

// ── Ack record builders ────────────────────────────────────────────────

export interface FixtureAckOverrides extends Partial<Omit<AckRecord, '__ack' | 'messageId' | 'readerId'>> {
  messageId?: string | undefined;
  readerId?: string | undefined;
}

/** Build a minimal v1 `AckRecord` (read receipt). */
export function buildReadAck(overrides: FixtureAckOverrides = {}): AckRecord {
  return {
    __ack: true,
    messageId: overrides.messageId ?? ('msg-1' as never),
    readerId: overrides.readerId ?? ('agent-a' as never),
    timestamp: overrides.timestamp ?? FIXTURE_TIME_PLUS_1S,
    read: overrides.read ?? true,
    ...overrides,
  };
}

/** Build a completion ack record. */
export function buildCompletedAck(overrides: FixtureAckOverrides = {}): AckRecord {
  return buildReadAck({
    completed: true,
    completedBy: overrides.readerId ?? 'agent-a',
    outcome: overrides.outcome ?? 'done',
    ...overrides,
  });
}

/** Build a soft-delete ack record. */
export function buildDeleteAck(overrides: FixtureAckOverrides = {}): AckRecord {
  return buildReadAck({
    deleted: true,
    deletedBy: overrides.readerId ?? 'operator',
    ...overrides,
  });
}

// ── JSONL fixture builders ─────────────────────────────────────────────

/**
 * Serialize a set of messages and ack records into raw JSONL content
 * suitable for writing directly to a `_mailbox.jsonl` file.
 *
 * Lines are ordered: messages first, then acks — matching the append-only
 * model where acks are appended after the message they reference.
 */
export function buildMailboxJsonl(
  messages: MailboxMessage[],
  acks: AckRecord[] = [],
): string {
  const msgLines = messages.map((m) => JSON.stringify(m));
  const ackLines = acks.map((a) => JSON.stringify(a));
  return [...msgLines, ...ackLines].join('\n') + '\n';
}

/**
 * Build a mixed v1 fixture file: a direct message, a broadcast, a completed
 * direct message, a completed broadcast (legacy global), and an unread
 * message. Plus ack records for read receipts and completions.
 *
 * This fixture covers the migration scenarios in R3:
 * - v1 direct message → actor-scoped receipt on migration
 * - v1 broadcast completed globally → legacyGlobalCompletion on migration
 * - v1 read receipts → actor-scoped read state
 */
export function buildMixedV1Fixture(): { messages: MailboxMessage[]; acks: AckRecord[]; jsonl: string } {
  const directUnread = buildV1Message({ id: 'fx-direct-unread', to: 'agent-a', subject: 'direct unread' });
  const directRead = buildReadMessage(['agent-a'], { id: 'fx-direct-read', to: 'agent-a', subject: 'direct read' });
  const directCompleted = buildCompletedMessage('agent-a', {
    id: 'fx-direct-completed',
    to: 'agent-a',
    subject: 'direct completed',
  });
  const broadcastUnread = buildV1Message({ id: 'fx-broadcast-unread', to: '*', subject: 'broadcast unread' });
  const broadcastCompleted = buildCompletedMessage('agent-a', {
    id: 'fx-broadcast-completed',
    to: '*',
    subject: 'broadcast completed',
  });
  const sessionMessage = buildV1Message({
    id: 'fx-session',
    to: '@session:sess-1',
    subject: 'session message',
    senderSessionId: 'sess-1',
  });
  const leadersOnly = buildLeadersOnlyMessage({ id: 'fx-leaders-only' });

  const messages = [
    directUnread,
    directRead,
    directCompleted,
    broadcastUnread,
    broadcastCompleted,
    sessionMessage,
    leadersOnly,
  ];

  // Ack records (what would have been appended to the JSONL)
  const acks: AckRecord[] = [
    // Read receipt for directRead
    buildReadAck({ messageId: 'fx-direct-read', readerId: 'agent-a', timestamp: FIXTURE_TIME_PLUS_1S }),
    // Completion ack for directCompleted
    buildCompletedAck({ messageId: 'fx-direct-completed', readerId: 'agent-a', timestamp: FIXTURE_TIME_PLUS_1S }),
    // Completion ack for broadcastCompleted — this is the critical one:
    // in v1 it set global `completed: true`; in v2 it must NOT become
    // actor-scoped for agent-a because the original `to` was `*`.
    buildCompletedAck({ messageId: 'fx-broadcast-completed', readerId: 'agent-a', timestamp: FIXTURE_TIME_PLUS_1S }),
  ];

  // Build the JSONL as it would exist on disk after these operations.
  // Messages carry inline state (readBy, completed, etc.) because the v1
  // acks were already folded into them by the last compaction.
  return { messages, acks, jsonl: buildMailboxJsonl(messages, acks) };
}

/**
 * Build a corrupt-line fixture: valid messages interspersed with
 * malformed JSON lines. Tests that the codec skips corrupt lines
 * without dropping valid ones.
 */
export function buildCorruptLineFixture(): string {
  const valid = buildV1Message({ id: 'fx-valid-1', subject: 'before corrupt' });
  const valid2 = buildV1Message({ id: 'fx-valid-2', subject: 'after corrupt' });
  return [
    JSON.stringify(valid),
    '{not valid json',
    JSON.stringify({ broken: true }),
    JSON.stringify(valid2),
  ].join('\n') + '\n';
}

/**
 * Build a fixture with an ack record that references a nonexistent message.
 * Tests that the codec skips orphan acks without error.
 */
export function buildOrphanAckFixture(): string {
  const msg = buildV1Message({ id: 'fx-has-ack', subject: 'has ack' });
  const orphanAck = buildReadAck({ messageId: 'fx-nonexistent', readerId: 'ghost' });
  return buildMailboxJsonl([msg], [orphanAck]);
}

// ── Send-input builders ────────────────────────────────────────────────

/** Build a `MailboxSendInput` for every message type + recipient form combination. */
export function buildAllSendInputs(): Array<{ label: string; input: MailboxSendInput }> {
  const from = 'test-sender';
  const cases: Array<{ label: string; input: MailboxSendInput }> = [];

  const recipientForms = [
    { label: 'direct', to: 'agent-a' },
    { label: 'base-alias', to: 'leader' },
    { label: 'session', to: '@session:sess-1', senderSessionId: 'sess-1' },
    { label: 'broadcast', to: '*' },
  ];

  const types = ['note', 'ask', 'assign', 'steer', 'btw', 'broadcast', 'status', 'result', 'review'] as const;

  for (const recip of recipientForms) {
    for (const type of types) {
      // Skip invalid combinations per validateSendType():
      // assign/steer to '*' or '@session:*' is rejected.
      const isMultiRecipient = recip.to === '*' || recip.to.startsWith('@session');
      if ((type === 'assign' || type === 'steer') && isMultiRecipient) continue;

      cases.push({
        label: `${type}-${recip.label}`,
        input: {
          from,
          to: recip.to,
          type,
          subject: `${type} to ${recip.label}`,
          body: 'fixture body',
          ...(recip.senderSessionId ? { senderSessionId: recip.senderSessionId } : {}),
        },
      });
    }
  }

  return cases;
}

/**
 * Build send inputs that the current contract REJECTS.
 * Each case is labeled with the expected error fragment.
 */
export function buildInvalidSendInputs(): Array<{ label: string; input: MailboxSendInput; errorContains: string }> {
  return [
    {
      label: 'control-type',
      input: { from: 'a', to: 'b', type: 'control', subject: 's', body: 'b' },
      errorContains: 'control',
    },
    {
      label: 'assign-to-broadcast',
      input: { from: 'a', to: '*', type: 'assign', subject: 's', body: 'b' },
      errorContains: 'assign',
    },
    {
      label: 'steer-to-broadcast',
      input: { from: 'a', to: '*', type: 'steer', subject: 's', body: 'b' },
      errorContains: 'steer',
    },
    {
      label: 'assign-to-session',
      input: { from: 'a', to: '@session:sess-1', type: 'assign', subject: 's', body: 'b', senderSessionId: 'sess-1' },
      errorContains: 'assign',
    },
  ];
}

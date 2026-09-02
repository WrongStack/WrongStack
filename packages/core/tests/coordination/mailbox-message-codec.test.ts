import { describe, expect, it } from 'vitest';
import type { AckRecord } from '../../src/coordination/mailbox-types.js';
import {
  applyAckToMessage,
  isAckRecord,
  parseMailboxLine,
  parseMailboxLines,
  parseMailboxMessage,
  parseMailboxMessageLine,
  serializeAckRecord,
  serializeMailboxMessage,
} from '../../src/coordination/mailbox-message-codec.js';

const validMessage = {
  id: 'm1',
  from: 'leader',
  to: 'worker',
  type: 'note',
  subject: 'subject',
  body: 'body',
  priority: 'normal',
  readBy: {},
  completed: false,
  timestamp: '2026-07-12T00:00:00.000Z',
};

describe('mailbox message codec', () => {
  it('parses a valid JSONL message and keeps supported optional fields', () => {
    const parsed = parseMailboxMessageLine(
      JSON.stringify({
        ...validMessage,
        audience: 'leaders',
        replyTo: 'parent',
        taskContext: { agentRole: 'executor', status: 'running' },
        sessionAffinity: { sessionId: 'session-1', reportId: 'report-1', kind: 'chimera.review' },
      }),
    );

    expect(parsed).toMatchObject({
      id: 'm1',
      replyTo: 'parent',
      audience: 'leaders',
      taskContext: { agentRole: 'executor', status: 'running' },
      sessionAffinity: { sessionId: 'session-1', reportId: 'report-1', kind: 'chimera.review' },
    });
  });

  it('migrates legacy receipts and message types', () => {
    const parsed = parseMailboxMessage({
      ...validMessage,
      type: 'info',
      readBy: undefined,
      read: true,
      readAt: '2026-07-12T01:00:00.000Z',
    });

    expect(parsed.type).toBe('note');
    expect(parsed.readBy).toEqual({ worker: '2026-07-12T01:00:00.000Z' });
  });

  it('uses the legacy unknown recipient and normalizes unknown priorities', () => {
    const parsed = parseMailboxMessage({
      ...validMessage,
      to: undefined,
      priority: 'unexpected',
      readBy: undefined,
      read: true,
      readAt: '2026-07-12T01:00:00.000Z',
    });

    expect(parsed.priority).toBe('normal');
    expect(parsed.readBy).toEqual({ unknown: '2026-07-12T01:00:00.000Z' });
  });

  it.each([
    null,
    [],
    { ...validMessage, id: 1 },
    { ...validMessage, type: 'mystery' },
    { ...validMessage, audience: 'workers' },
    { ...validMessage, priority: 1 },
    { ...validMessage, readBy: [] },
    { ...validMessage, readBy: { worker: 1 } },
    { ...validMessage, completed: 'no' },
    { ...validMessage, taskContext: [] },
    { ...validMessage, taskContext: { status: 'mystery' } },
    { ...validMessage, sessionAffinity: [] },
    { ...validMessage, sessionAffinity: { sessionId: '' } },
    { ...validMessage, sessionAffinity: { sessionId: 1 } },
    { ...validMessage, sessionAffinity: { reportId: '' } },
  ])('rejects structurally invalid persisted values', (value) => {
    expect(() => parseMailboxMessage(value)).toThrow(TypeError);
  });

  it('rejects malformed JSON before structural validation', () => {
    expect(() => parseMailboxMessageLine('{')).toThrow(SyntaxError);
  });
});

const ackBase: AckRecord = {
  __ack: true,
  messageId: 'm1',
  readerId: 'worker',
  timestamp: '2026-07-12T02:00:00.000Z',
  read: true,
};

function messageLine(overrides: Partial<typeof validMessage> = {}): string {
  return JSON.stringify({ ...validMessage, ...overrides });
}

function ackLine(overrides: Partial<AckRecord> = {}): string {
  return JSON.stringify({ ...ackBase, ...overrides });
}

describe('isAckRecord', () => {
  it('identifies objects carrying the __ack discriminator', () => {
    expect(isAckRecord({ __ack: true, messageId: 'm1' })).toBe(true);
  });

  it.each([null, undefined, {}, { __ack: false }, { __ack: 'true' }, [], { __ack: 1 }])(
    'rejects non-ack values (%s)',
    (value) => {
      expect(isAckRecord(value)).toBe(false);
    },
  );
});

describe('parseMailboxLine', () => {
  it('returns an AckRecord for ack lines', () => {
    const parsed = parseMailboxLine(ackLine());
    expect(isAckRecord(parsed)).toBe(true);
    expect(parsed).toMatchObject({ messageId: 'm1', readerId: 'worker', read: true });
  });

  it('returns a MailboxMessage for message lines', () => {
    const parsed = parseMailboxLine(messageLine());
    expect(isAckRecord(parsed)).toBe(false);
    expect(parsed).toMatchObject({ id: 'm1', from: 'leader' });
  });

  it('returns null for malformed JSON', () => {
    expect(parseMailboxLine('{not-json')).toBeNull();
  });

  it('returns null for structurally invalid messages', () => {
    expect(parseMailboxLine(JSON.stringify({ ...validMessage, type: 'mystery' }))).toBeNull();
  });

  it('returns null for empty lines', () => {
    expect(parseMailboxLine('')).toBeNull();
  });
});

describe('applyAckToMessage', () => {
  it('records a read receipt without overwriting an existing one', () => {
    const msg = parseMailboxMessage({ ...validMessage });
    applyAckToMessage(msg, ackBase);
    expect(msg.readBy).toEqual({ worker: '2026-07-12T02:00:00.000Z' });

    // A second read ack from a different reader adds a receipt...
    applyAckToMessage(msg, {
      ...ackBase,
      readerId: 'leader',
      timestamp: '2026-07-12T03:00:00.000Z',
    });
    expect(msg.readBy).toEqual({
      worker: '2026-07-12T02:00:00.000Z',
      leader: '2026-07-12T03:00:00.000Z',
    });

    // ...but re-acking the same reader does not change the timestamp.
    applyAckToMessage(msg, {
      ...ackBase,
      readerId: 'worker',
      timestamp: '2026-07-12T04:00:00.000Z',
    });
    expect(msg.readBy.worker).toBe('2026-07-12T02:00:00.000Z');
  });

  it('does nothing when ack.read is false', () => {
    const msg = parseMailboxMessage({ ...validMessage });
    applyAckToMessage(msg, { ...ackBase, read: false });
    expect(msg.readBy).toEqual({});
  });

  it('marks a message completed with a timestamp and completer', () => {
    const msg = parseMailboxMessage({ ...validMessage });
    applyAckToMessage(msg, { ...ackBase, completed: true, completedBy: 'orchestrator' });
    expect(msg).toMatchObject({
      completed: true,
      completedBy: 'orchestrator',
      completedAt: '2026-07-12T02:00:00.000Z',
    });
  });

  it('falls back to readerId for completedBy when omitted', () => {
    const msg = parseMailboxMessage({ ...validMessage });
    applyAckToMessage(msg, { ...ackBase, completed: true });
    expect(msg.completedBy).toBe('worker');
  });

  it('does not re-complete an already-completed message', () => {
    const msg = parseMailboxMessage({
      ...validMessage,
      completed: true,
      completedAt: '2026-07-01T00:00:00.000Z',
    });
    applyAckToMessage(msg, { ...ackBase, completed: true, completedBy: 'other' });
    expect(msg.completedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(msg.completedBy).toBeUndefined();
  });

  it('sets the outcome only when provided and different', () => {
    const msg = parseMailboxMessage({ ...validMessage });
    applyAckToMessage(msg, { ...ackBase, outcome: 'success' });
    expect(msg.outcome).toBe('success');

    applyAckToMessage(msg, { ...ackBase, outcome: 'success' });
    expect(msg.outcome).toBe('success');
  });

  it('soft-deletes the message when ack.deleted is true', () => {
    const msg = parseMailboxMessage({ ...validMessage });
    applyAckToMessage(msg, { ...ackBase, deleted: true, deletedBy: 'admin' });
    expect(msg).toMatchObject({ deletedAt: '2026-07-12T02:00:00.000Z', deletedBy: 'admin' });
  });

  it('restores a soft-deleted message when ack.deleted is false', () => {
    const msg = parseMailboxMessage({
      ...validMessage,
      deletedAt: '2026-07-01T00:00:00.000Z',
      deletedBy: 'admin',
    });
    applyAckToMessage(msg, { ...ackBase, deleted: false });
    expect(msg.deletedAt).toBeUndefined();
    expect(msg.deletedBy).toBeUndefined();
  });
});

describe('serializeAckRecord', () => {
  it('serializes an ack record to a JSONL line terminated with a newline', () => {
    const line = serializeAckRecord(ackBase);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual(ackBase);
  });
});

describe('serializeMailboxMessage', () => {
  it('round-trips every persisted message field', () => {
    const message = parseMailboxMessage({
      ...validMessage,
      audience: 'leaders',
      completedBy: 'worker',
      outcome: 'handled',
      completedAt: '2026-07-12T02:00:00.000Z',
      deletedAt: '2026-07-12T03:00:00.000Z',
      deletedBy: 'admin',
      replyTo: 'parent',
      senderSessionId: 'session-1',
      expiresAt: '2026-07-13T00:00:00.000Z',
      taskContext: {
        agentRole: 'executor',
        agentName: 'Worker',
        taskId: 'task-1',
        status: 'completed',
      },
    });

    const line = serializeMailboxMessage(message);

    expect(line.endsWith('\n')).toBe(true);
    expect(parseMailboxMessageLine(line)).toEqual(message);
  });

  it('strips projection-only fields from compacted messages', () => {
    const projected = {
      ...parseMailboxMessage(validMessage),
      recipientState: { worker: { actorId: 'worker', readAt: '2026-07-12T02:00:00.000Z' } },
      legacyGlobalCompletion: true,
    };

    const serialized = JSON.parse(serializeMailboxMessage(projected)) as Record<string, unknown>;

    expect(serialized).not.toHaveProperty('recipientState');
    expect(serialized).not.toHaveProperty('legacyGlobalCompletion');
  });

  it('omits the default audience and undefined optional fields', () => {
    const message = { ...parseMailboxMessage(validMessage), audience: 'all' as const };

    expect(JSON.parse(serializeMailboxMessage(message))).toEqual(validMessage);
  });
});

describe('parseMailboxLines', () => {
  it('splits a body into messages and skips blank lines', () => {
    const body = `${messageLine({ id: 'm1' })}\n\n${messageLine({ id: 'm2' })}\n`;
    const messages = parseMailboxLines(body);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('returns an empty array for a blank body', () => {
    expect(parseMailboxLines('\n  \n')).toEqual([]);
  });

  it('drops corrupt lines instead of throwing', () => {
    const body = `${messageLine({ id: 'm1' })}\n{broken\n${messageLine({ id: 'm2' })}\n`;
    const messages = parseMailboxLines(body);
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('folds ack records into their target messages', () => {
    const body =
      messageLine({ id: 'm1' }) +
      '\n' +
      messageLine({ id: 'm2' }) +
      '\n' +
      ackLine({ messageId: 'm2', read: true }) +
      '\n' +
      ackLine({ messageId: 'm2', completed: true, completedBy: 'leader' }) +
      '\n';

    const messages = parseMailboxLines(body);
    expect(messages).toHaveLength(2);
    const [m1, m2] = messages;
    expect(m1.readBy).toEqual({});
    expect(m1.completed).toBe(false);
    expect(m2).toMatchObject({
      readBy: { worker: '2026-07-12T02:00:00.000Z' },
      completed: true,
      completedBy: 'leader',
      completedAt: '2026-07-12T02:00:00.000Z',
    });
  });

  it('ignores acks targeting an absent message', () => {
    const body = messageLine({ id: 'm1' }) + '\n' + ackLine({ messageId: 'gone' }) + '\n';
    const messages = parseMailboxLines(body);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.readBy).toEqual({});
  });

  it('segregates ack records even when they precede the message line', () => {
    const body = ackLine({ messageId: 'm1', read: true }) + '\n' + messageLine({ id: 'm1' }) + '\n';
    const messages = parseMailboxLines(body);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.readBy).toEqual({ worker: '2026-07-12T02:00:00.000Z' });
  });

  it('applies multiple acks to the same message cumulatively', () => {
    const body =
      messageLine({ id: 'm1' }) +
      '\n' +
      ackLine({ readerId: 'a', timestamp: '2026-07-12T01:00:00.000Z', read: true }) +
      '\n' +
      ackLine({ readerId: 'b', timestamp: '2026-07-12T02:00:00.000Z', read: true }) +
      '\n';

    const messages = parseMailboxLines(body);
    expect(messages[0]!.readBy).toEqual({
      a: '2026-07-12T01:00:00.000Z',
      b: '2026-07-12T02:00:00.000Z',
    });
  });
});

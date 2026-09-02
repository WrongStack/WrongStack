/**
 * GM-P0.4 + GM-P0.4A — Tests for v2 receipt records, materialized view,
 * version fence, and migration classification.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';
import type { EventBus } from '../../src/kernel/events.js';
import type {
  MailboxMessage,
  MailboxMessageProjection,
} from '../../src/coordination/mailbox-types.js';
import {
  buildReceiptRecordV2,
  extractV2Receipts,
  materializeMessages,
  serializeReceiptRecordV2,
} from '../../src/coordination/mailbox-receipt-folding.js';
import { parseMailboxFile } from '../../src/coordination/mailbox-parse-state.js';
import { isMailboxReceiptRecordV2 } from '../../src/coordination/mailbox-types.js';

let dir: string;
let mb: SqliteMailbox;
const events = { emitCustom: () => {} };
/** Extra stores a test opened; closed before any directory is removed. */
const extraStores: SqliteMailbox[] = [];
/** Directories a test seeded outside `dir`; removed after their stores close. */
const extraDirs: string[] = [];

const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-v2-'));
  mb = new SqliteMailbox(dir, events as never as EventBus);
});

afterEach(async () => {
  for (const store of extraStores.splice(0)) await store.close().catch(() => undefined);
  await mb.close().catch(() => undefined);
  for (const extra of extraDirs.splice(0)) await fs.rm(extra, RM_OPTIONS);
  await fs.rm(dir, RM_OPTIONS);
});

/** Open a second connection to the store under test. */
function reopen(): SqliteMailbox {
  const store = new SqliteMailbox(dir, events as never as EventBus);
  extraStores.push(store);
  return store;
}

/**
 * Read a message back with its per-actor receipt state.
 *
 * Receipts live in the `message_receipts` table now, not as `__mailboxReceipt`
 * lines in a JSONL file — `includeReceiptState` is how a caller sees them.
 */
async function projectionOf(
  store: SqliteMailbox,
  messageId: string,
): Promise<MailboxMessageProjection | undefined> {
  const all = await store.query({ limit: 1000, includeReceiptState: true });
  return all.find((message) => message.id === messageId) as MailboxMessageProjection | undefined;
}

/**
 * Open a store over a directory seeded with a legacy `_mailbox.jsonl`.
 *
 * The constructor runs the one-shot import, so this is how a test introduces
 * v1 messages, v1 acks and v2 receipt lines with timestamps it controls.
 */
async function openWithLegacyLines(lines: readonly string[]): Promise<SqliteMailbox> {
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-v2-legacy-'));
  await fs.writeFile(path.join(legacyDir, '_mailbox.jsonl'), `${lines.join('\n')}\n`);
  const store = new SqliteMailbox(legacyDir, events as never as EventBus);
  extraStores.push(store);
  extraDirs.push(legacyDir);
  return store;
}

// ── Receipt record discriminator ─────────────────────────────────────

describe('isMailboxReceiptRecordV2', () => {
  it('accepts a valid v2 receipt', () => {
    const record = buildReceiptRecordV2('m1', 'actor-1', '2026-01-01T00:00:00Z', { read: true });
    expect(isMailboxReceiptRecordV2(record)).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isMailboxReceiptRecordV2(null)).toBe(false);
    expect(isMailboxReceiptRecordV2('string')).toBe(false);
    expect(isMailboxReceiptRecordV2(42)).toBe(false);
    expect(isMailboxReceiptRecordV2([])).toBe(false);
  });

  it('rejects wrong discriminator', () => {
    expect(isMailboxReceiptRecordV2({ __mailboxReceipt: 1 })).toBe(false);
    expect(isMailboxReceiptRecordV2({ __ack: true })).toBe(false);
  });

  it('rejects missing required fields', () => {
    expect(isMailboxReceiptRecordV2({ __mailboxReceipt: 2 })).toBe(false);
    expect(isMailboxReceiptRecordV2({ __mailboxReceipt: 2, messageId: 'm1' })).toBe(false);
    expect(isMailboxReceiptRecordV2({ __mailboxReceipt: 2, messageId: 'm1', actorId: 'a' })).toBe(
      false,
    );
  });

  it('rejects empty strings for required fields', () => {
    expect(
      isMailboxReceiptRecordV2({
        __mailboxReceipt: 2,
        messageId: '',
        actorId: 'a',
        timestamp: 't',
      }),
    ).toBe(false);
    expect(
      isMailboxReceiptRecordV2({
        __mailboxReceipt: 2,
        messageId: 'm',
        actorId: '',
        timestamp: 't',
      }),
    ).toBe(false);
  });

  it('rejects wrong-typed optional fields', () => {
    expect(
      isMailboxReceiptRecordV2({
        __mailboxReceipt: 2,
        messageId: 'm',
        actorId: 'a',
        timestamp: 't',
        read: 'yes',
      }),
    ).toBe(false);
    expect(
      isMailboxReceiptRecordV2({
        __mailboxReceipt: 2,
        messageId: 'm',
        actorId: 'a',
        timestamp: 't',
        completed: 'true',
      }),
    ).toBe(false);
  });
});

// ── Receipt record serialization ─────────────────────────────────────

describe('serializeReceiptRecordV2', () => {
  it('produces valid JSON parseable as a v2 receipt', () => {
    const record = buildReceiptRecordV2('m1', 'a1', '2026-01-01T00:00:00Z', {
      read: true,
      completed: false,
    });
    const line = serializeReceiptRecordV2(record);
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trim());
    expect(isMailboxReceiptRecordV2(parsed)).toBe(true);
  });
});

// ── V1 completion classification ─────────────────────────────────────

describe('materializeMessages — v1 completion classification', () => {
  it('classifies completed direct message as actor-scoped (not legacy)', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: 'worker-1@sess-1',
      type: 'note',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: true,
      completedBy: 'worker-1@sess-1',
      completedAt: '2026-01-01T01:00:00Z',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const projections = materializeMessages([msg], []);
    expect(projections[0]!.legacyGlobalCompletion).toBeUndefined();
    expect(projections[0]!.recipientState['worker-1@sess-1']?.completedAt).toBe(
      '2026-01-01T01:00:00Z',
    );
  });

  it('classifies completed process-qualified direct message as actor-scoped', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: 'leader#123',
      type: 'ask',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: true,
      completedBy: 'leader#123',
      completedAt: '2026-01-01T01:00:00Z',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const projections = materializeMessages([msg], []);
    expect(projections[0]!.legacyGlobalCompletion).toBeUndefined();
    expect(projections[0]!.recipientState['leader#123']?.completedAt).toBe('2026-01-01T01:00:00Z');
  });

  it('classifies completed broadcast as legacyGlobalCompletion', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: '*',
      type: 'broadcast',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: { 'worker-1': '2026-01-01T00:30:00Z' },
      completed: true,
      completedBy: 'worker-1',
      completedAt: '2026-01-01T01:00:00Z',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const projections = materializeMessages([msg], []);
    expect(projections[0]!.legacyGlobalCompletion).toBe(true);
    // No actor-scoped completion for the broadcast message.
    expect(projections[0]!.recipientState['worker-1']?.completedAt).toBeUndefined();
    // But read receipt is preserved.
    expect(projections[0]!.recipientState['worker-1']?.readAt).toBe('2026-01-01T00:30:00Z');
  });

  it('keeps completed v1 broadcast globally suppressed after a v2 read-only receipt', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: '*',
      type: 'broadcast',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: true,
      completedBy: 'worker-1',
      completedAt: '2026-01-01T01:00:00Z',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const receipts = [
      buildReceiptRecordV2('m1', 'worker-2', '2026-01-01T02:00:00Z', { read: true }),
    ];

    const projections = materializeMessages([msg], receipts);

    expect(projections[0]!.legacyGlobalCompletion).toBe(true);
    expect(projections[0]!.recipientState['worker-2']?.readAt).toBe('2026-01-01T02:00:00Z');
    expect(projections[0]!.recipientState['worker-2']?.completedAt).toBeUndefined();
  });

  it('classifies completed session broadcast as legacyGlobalCompletion', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: '@session:sess-1',
      type: 'broadcast',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: true,
      completedBy: 'a',
      completedAt: '2026-01-01T01:00:00Z',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const projections = materializeMessages([msg], []);
    expect(projections[0]!.legacyGlobalCompletion).toBe(true);
  });

  it('classifies incomplete messages as neither legacy nor actor-scoped', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: '*',
      type: 'broadcast',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: false,
      timestamp: '2026-01-01T00:00:00Z',
    };
    const projections = materializeMessages([msg], []);
    expect(projections[0]!.legacyGlobalCompletion).toBeUndefined();
  });
});

// ── V2 receipt folding algebra ───────────────────────────────────────

describe('materializeMessages — v2 receipt folding', () => {
  it('folds a read receipt from v2 record', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: 'b',
      type: 'note',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: false,
      timestamp: '2026-01-01T00:00:00Z',
    };
    const receipts = [buildReceiptRecordV2('m1', 'b', '2026-01-01T01:00:00Z', { read: true })];
    const projections = materializeMessages([msg], receipts);
    expect(projections[0]!.recipientState['b']?.readAt).toBe('2026-01-01T01:00:00Z');
  });

  it('folds a completion from v2 record', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: 'b',
      type: 'ask',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: false,
      timestamp: '2026-01-01T00:00:00Z',
    };
    const receipts = [
      buildReceiptRecordV2('m1', 'b', '2026-01-01T02:00:00Z', { completed: true, outcome: 'done' }),
    ];
    const projections = materializeMessages([msg], receipts);
    expect(projections[0]!.recipientState['b']?.completedAt).toBe('2026-01-01T02:00:00Z');
    expect(projections[0]!.recipientState['b']?.outcome).toBe('done');
  });

  it('read timestamp uses first-write-wins', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: '*',
      type: 'broadcast',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: false,
      timestamp: '2026-01-01T00:00:00Z',
    };
    const receipts = [
      buildReceiptRecordV2('m1', 'c', '2026-01-01T03:00:00Z', { read: true }),
      buildReceiptRecordV2('m1', 'c', '2026-01-01T01:00:00Z', { read: true }), // earlier
      buildReceiptRecordV2('m1', 'c', '2026-01-01T02:00:00Z', { read: true }), // middle
    ];
    const projections = materializeMessages([msg], receipts);
    expect(projections[0]!.recipientState['c']?.readAt).toBe('2026-01-01T01:00:00Z');
  });

  it('completion is monotonic upward', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: '*',
      type: 'broadcast',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: false,
      timestamp: '2026-01-01T00:00:00Z',
    };
    const receipts = [
      buildReceiptRecordV2('m1', 'c', '2026-01-01T01:00:00Z', { completed: true }),
      buildReceiptRecordV2('m1', 'c', '2026-01-01T02:00:00Z', { completed: false }), // reopen
      buildReceiptRecordV2('m1', 'c', '2026-01-01T03:00:00Z', { completed: true }),
    ];
    const projections = materializeMessages([msg], receipts);
    expect(projections[0]!.recipientState['c']?.completedAt).toBe('2026-01-01T03:00:00Z');
  });

  it('outcome uses last-write-wins', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: 'b',
      type: 'ask',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: false,
      timestamp: '2026-01-01T00:00:00Z',
    };
    const receipts = [
      buildReceiptRecordV2('m1', 'b', '2026-01-01T01:00:00Z', { outcome: 'first' }),
      buildReceiptRecordV2('m1', 'b', '2026-01-01T02:00:00Z', { outcome: 'second' }),
    ];
    const projections = materializeMessages([msg], receipts);
    expect(projections[0]!.recipientState['b']?.outcome).toBe('second');
  });

  it('uses persisted order to break equal-timestamp completion ties', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: 'b',
      type: 'ask',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: false,
      timestamp: '2026-01-01T00:00:00Z',
    };
    const timestamp = '2026-01-01T01:00:00Z';
    const projections = materializeMessages(
      [msg],
      [
        buildReceiptRecordV2('m1', 'b', timestamp, { completed: true }),
        buildReceiptRecordV2('m1', 'b', timestamp, { completed: false }),
      ],
    );
    expect(projections[0]!.recipientState['b']?.completedAt).toBeUndefined();
  });

  it('duplicate records (same timestamp) are idempotent', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: 'b',
      type: 'note',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: false,
      timestamp: '2026-01-01T00:00:00Z',
    };
    const ts = '2026-01-01T01:00:00Z';
    const receipts = [
      buildReceiptRecordV2('m1', 'b', ts, { read: true }),
      buildReceiptRecordV2('m1', 'b', ts, { read: true }),
    ];
    const projections = materializeMessages([msg], receipts);
    expect(projections[0]!.recipientState['b']?.readAt).toBe(ts);
  });

  it('separate actors get separate state', () => {
    const msg: MailboxMessage = {
      id: 'm1',
      from: 'a',
      to: '*',
      type: 'broadcast',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: false,
      timestamp: '2026-01-01T00:00:00Z',
    };
    const receipts = [
      buildReceiptRecordV2('m1', 'b', '2026-01-01T01:00:00Z', { read: true, completed: true }),
      buildReceiptRecordV2('m1', 'c', '2026-01-01T02:00:00Z', { read: true }),
    ];
    const projections = materializeMessages([msg], receipts);
    expect(projections[0]!.recipientState['b']?.completedAt).toBe('2026-01-01T01:00:00Z');
    expect(projections[0]!.recipientState['c']?.completedAt).toBeUndefined();
    expect(projections[0]!.recipientState['c']?.readAt).toBe('2026-01-01T02:00:00Z');
  });
});

// ── extractV2Receipts ───────────────────────────────────────────────

describe('extractV2Receipts', () => {
  it('extracts only v2 receipts from mixed parsed lines', () => {
    const parsed = [
      { __mailboxReceipt: 2, messageId: 'm1', actorId: 'a', timestamp: 't' },
      { __ack: true, messageId: 'm2', readerId: 'b', timestamp: 't2', read: true },
      {
        id: 'm1',
        from: 'a',
        to: 'b',
        type: 'note',
        subject: 's',
        body: 'b',
        priority: 'normal',
        readBy: {},
        completed: false,
        timestamp: 't',
      },
      { __mailboxReceipt: 2, messageId: 'm2', actorId: 'c', timestamp: 't3' },
    ];
    const receipts = extractV2Receipts(parsed);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]!.messageId).toBe('m1');
    expect(receipts[1]!.messageId).toBe('m2');
  });
});

// ── Canonical mailbox file parsing ──────────────────────────────────

describe('parseMailboxFile', () => {
  it('materializes independent v1 ack and v2 receipt completion state from raw JSONL', () => {
    const raw = [
      {
        id: 'm1',
        from: 'sender@sess-1',
        to: 'legacy@sess-1',
        type: 'ask',
        subject: 's',
        body: 'b',
        priority: 'normal',
        readBy: {},
        completed: false,
        timestamp: '2026-01-01T00:00:00Z',
      },
      {
        __ack: true,
        messageId: 'm1',
        readerId: 'legacy@sess-1',
        timestamp: '2026-01-01T01:00:00Z',
        completed: true,
      },
      {
        __mailboxReceipt: 2,
        messageId: 'm1',
        actorId: 'modern@sess-2',
        timestamp: '2026-01-01T02:00:00Z',
        completed: true,
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n');

    const projections = parseMailboxFile(raw);

    expect(projections).toHaveLength(1);
    expect(projections[0]!.recipientState['legacy@sess-1']?.completedAt).toBe(
      '2026-01-01T01:00:00Z',
    );
    expect(projections[0]!.recipientState['modern@sess-2']?.completedAt).toBe(
      '2026-01-01T02:00:00Z',
    );
  });
});

// ── End-to-end: SqliteMailbox with v2 receipts ───────────────────────

describe('SqliteMailbox v2 receipt integration', () => {
  it('records a per-actor receipt on ack', async () => {
    const msg = await mb.send({
      from: 'a',
      to: 'b',
      type: 'ask',
      subject: 'q',
      body: '?',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'b',
      read: true,
      completed: true,
    });

    const projection = await projectionOf(mb, msg.id);
    expect(projection?.recipientState['b']).toMatchObject({ actorId: 'b' });
    expect(projection?.recipientState['b']?.readAt).toBeDefined();
    expect(projection?.recipientState['b']?.completedAt).toBeDefined();
  });

  it('keeps actor completion and outcome off the message for fan-out messages', async () => {
    const msg = await mb.send({
      from: 'leader',
      to: '*',
      type: 'broadcast',
      subject: 'q',
      body: '?',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'actor-a',
      read: true,
      completed: true,
      outcome: 'handled by actor a',
    });

    const projection = await projectionOf(mb, msg.id);
    // Aggregate view: one actor finishing a fan-out completes nothing globally.
    expect(projection?.readBy['actor-a']).toBeDefined();
    expect(projection?.completed).toBe(false);
    expect(projection?.completedBy).toBeUndefined();
    // Per-actor view: that actor's completion and outcome are recorded.
    expect(projection?.recipientState['actor-a']?.completedAt).toBeDefined();
    expect(projection?.recipientState['actor-a']?.outcome).toBe('handled by actor a');
  });

  it('strips receipt state unless the caller asks for it', async () => {
    const msg = await mb.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' });
    await mb.ack({ messageId: msg.id, readerId: 'b', read: true });

    const [plain] = await mb.query({ limit: 10 });
    expect(plain).not.toHaveProperty('recipientState');
    expect(plain).not.toHaveProperty('legacyGlobalCompletion');
  });

  it('messages and receipts survive close and reopen', async () => {
    const msg = await mb.send({
      from: 'a',
      to: 'b',
      type: 'note',
      subject: 's',
      body: 'b',
    });
    await mb.ack({ messageId: msg.id, readerId: 'b', read: true });
    await mb.close();

    // Reopen and send another message.
    const mb2 = reopen();
    const msg2 = await mb2.send({
      from: 'a',
      to: 'b',
      type: 'note',
      subject: 's2',
      body: 'b2',
    });
    await mb2.ack({ messageId: msg2.id, readerId: 'b', read: true, completed: true });
    await mb2.close();

    // Reopen again and verify both messages and their receipts survive.
    const mb3 = reopen();
    const all = await mb3.query({ limit: 100 });
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.subject)).toContain('s');
    expect(all.map((m) => m.subject)).toContain('s2');
    expect((await projectionOf(mb3, msg.id))?.recipientState['b']?.readAt).toBeDefined();
    expect((await projectionOf(mb3, msg2.id))?.recipientState['b']?.completedAt).toBeDefined();
  });

  it('imports v1 acks and v2 receipt lines from a legacy JSONL mailbox', async () => {
    const store = await openWithLegacyLines([
      JSON.stringify({
        id: 'legacy-1',
        from: 'a',
        to: 'legacy@sess-1',
        type: 'ask',
        subject: 's',
        body: 'b',
        priority: 'normal',
        readBy: {},
        completed: false,
        timestamp: '2026-01-01T00:00:00Z',
      }),
      JSON.stringify({
        __ack: true,
        messageId: 'legacy-1',
        readerId: 'legacy@sess-1',
        timestamp: '2026-01-01T01:00:00Z',
        read: true,
        completed: true,
      }),
      JSON.stringify(
        buildReceiptRecordV2('legacy-1', 'modern@sess-2', '2026-01-01T02:00:00Z', {
          completed: true,
        }),
      ),
    ]);

    const projection = await projectionOf(store, 'legacy-1');
    expect(projection?.recipientState['legacy@sess-1']?.completedAt).toBe('2026-01-01T01:00:00Z');
    expect(projection?.recipientState['modern@sess-2']?.completedAt).toBe('2026-01-01T02:00:00Z');
  });
});

// ── parseMailboxFile unit integration ────────────────────────────────

describe('parseMailboxFile integration', () => {
  it('folds v1 message + v2 receipt into recipientState', () => {
    const msg = JSON.stringify({
      id: 'm1',
      from: 'a',
      to: 'b',
      type: 'note',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: false,
      timestamp: '2026-01-01T00:00:00Z',
    });
    const receipt = JSON.stringify({
      __mailboxReceipt: 2,
      messageId: 'm1',
      actorId: 'b',
      timestamp: '2026-01-01T01:00:00Z',
      read: true,
      completed: true,
    });
    const projections = parseMailboxFile(`${msg}\n${receipt}\n`);
    expect(projections).toHaveLength(1);
    expect(projections[0]!.recipientState['b']?.readAt).toBe('2026-01-01T01:00:00Z');
    expect(projections[0]!.recipientState['b']?.completedAt).toBe('2026-01-01T01:00:00Z');
  });

  it('classifies v1 broadcast completed as legacyGlobalCompletion', () => {
    const msg = JSON.stringify({
      id: 'm1',
      from: 'a',
      to: '*',
      type: 'broadcast',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: true,
      completedBy: 'x',
      completedAt: '2026-01-01T01:00:00Z',
      timestamp: '2026-01-01T00:00:00Z',
    });
    const projections = parseMailboxFile(`${msg}\n`);
    expect(projections[0]!.legacyGlobalCompletion).toBe(true);
  });

  it('preserves readBy seeds for v2 receipt state', () => {
    const msg = JSON.stringify({
      id: 'm1',
      from: 'a',
      to: 'b',
      type: 'note',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: { b: '2026-01-01T00:30:00Z' },
      completed: false,
      timestamp: '2026-01-01T00:00:00Z',
    });
    const projections = parseMailboxFile(`${msg}\n`);
    expect(projections[0]!.recipientState['b']?.readAt).toBe('2026-01-01T00:30:00Z');
  });

  it('skips malformed lines without dropping valid messages', () => {
    const msg = JSON.stringify({
      id: 'm1',
      from: 'a',
      to: 'b',
      type: 'note',
      subject: 's',
      body: 'b',
      priority: 'normal',
      readBy: {},
      completed: false,
      timestamp: '2026-01-01T00:00:00Z',
    });
    const projections = parseMailboxFile(`${msg}\nnot-json\n{}\n`);
    expect(projections).toHaveLength(1);
    expect(projections[0]!.id).toBe('m1');
  });
});

// ── Actor-scoped completion ──────────────────────────────────────────

describe('SqliteMailbox v2 actor-scoped completion', () => {
  it('persists separate completions when two actors complete a broadcast', async () => {
    const msg = await mb.send({
      from: 'leader',
      to: '*',
      type: 'broadcast',
      subject: 'all-hands',
      body: 'meeting',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'actor-a',
      read: true,
      completed: true,
    });

    const forB = await mb.query({
      to: '*',
      unreadBy: 'actor-b',
      readerRole: 'worker',
      incompleteOnly: true,
    });
    expect(forB.map((message) => message.id)).toContain(msg.id);
    expect(forB[0]).not.toHaveProperty('recipientState');
    expect(forB[0]).not.toHaveProperty('legacyGlobalCompletion');

    await mb.ack({
      messageId: msg.id,
      readerId: 'actor-b',
      read: true,
      completed: true,
    });
    await mb.close();

    const reopened = reopen();
    const forBAfterReopen = await reopened.query({
      to: '*',
      unreadBy: 'actor-b',
      readerRole: 'worker',
      incompleteOnly: true,
    });
    expect(forBAfterReopen.map((message) => message.id)).not.toContain(msg.id);
    const forAAfterReopen = await reopened.query({
      to: '*',
      unreadBy: 'actor-a',
      readerRole: 'worker',
      incompleteOnly: true,
    });
    expect(forAAfterReopen.map((message) => message.id)).not.toContain(msg.id);

    const persisted = await projectionOf(reopened, msg.id);
    expect(persisted?.recipientState['actor-a']?.completedAt).toBeDefined();
    expect(persisted?.recipientState['actor-b']?.completedAt).toBeDefined();
  });

  it('direct message completion is actor-scoped', async () => {
    const msg = await mb.send({
      from: 'a',
      to: 'b',
      type: 'ask',
      subject: 'q',
      body: '?',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'b',
      read: true,
      completed: true,
    });
    // B queries incompleteOnly - should NOT see it
    const forB = await mb.query({
      to: 'b',
      unreadBy: 'b',
      readerRole: 'worker',
      incompleteOnly: true,
    });
    expect(forB.map((m) => m.id)).not.toContain(msg.id);
  });

  it('a repeated read ack keeps the original receipt', async () => {
    const msg = await mb.send({ from: 'a', to: 'b', type: 'note', subject: 'q', body: '?' });
    await mb.ack({ messageId: msg.id, readerId: 'b', read: true });
    const firstReadAt = (await projectionOf(mb, msg.id))?.recipientState['b']?.readAt;
    expect(firstReadAt).toBeDefined();

    await mb.ack({ messageId: msg.id, readerId: 'b', read: true });
    const projection = await projectionOf(mb, msg.id);
    expect(Object.keys(projection?.recipientState ?? {})).toEqual(['b']);
    // The receipt keeps its ORIGINAL read timestamp - a re-read is not a new read.
    expect(projection?.recipientState['b']?.readAt).toBe(firstReadAt);
  });

  it('refuses a new actor completion on a legacy globally-completed fan-out', async () => {
    // A historical v1 fan-out completion stays globally suppressed so an
    // upgrade does not re-deliver it; `legacyGlobalCompletion` marks it.
    const store = await openWithLegacyLines([
      JSON.stringify({
        id: 'legacy-fanout',
        from: 'a',
        to: '*',
        type: 'broadcast',
        subject: 'q',
        body: '?',
        priority: 'normal',
        readBy: {},
        completed: true,
        completedBy: 'legacy-worker',
        completedAt: '2026-01-01T01:00:00Z',
        timestamp: '2026-01-01T00:00:00Z',
      }),
    ]);
    const projection = await projectionOf(store, 'legacy-fanout');
    expect(projection?.legacyGlobalCompletion).toBe(true);

    await store.ack({
      messageId: 'legacy-fanout',
      readerId: 'modern-worker',
      read: false,
      completed: true,
    });
    const after = await projectionOf(store, 'legacy-fanout');
    expect(after?.recipientState['modern-worker']?.completedAt).toBeUndefined();
    expect(after?.legacyGlobalCompletion).toBe(true);
  });

  it('reopen via completed:false makes message incomplete for that actor', async () => {
    const msg = await mb.send({
      from: 'a',
      to: 'b',
      type: 'ask',
      subject: 'q',
      body: '?',
    });
    // Complete it
    await mb.ack({
      messageId: msg.id,
      readerId: 'b',
      read: true,
      completed: true,
    });
    // Reopen using the canonical reopen verb: read:false + completed:false
    // (matches actionToAckInput('reopen') in mailbox-actions.ts)
    await mb.ack({
      messageId: msg.id,
      readerId: 'b',
      read: false,
      completed: false,
    });
    // An incomplete-work query is actor-scoped, not an unread query: the
    // reopened message remains read but must re-enter this actor's queue.
    const incomplete = await mb.query({
      to: 'b',
      unreadBy: 'b',
      readerRole: 'worker',
      incompleteOnly: true,
    });
    expect(incomplete.map((message) => message.id)).toContain(msg.id);
    expect(incomplete.find((message) => message.id === msg.id)?.readBy).toHaveProperty('b');

    // The receipt reflects the reopen: completedAt is cleared for that actor.
    const projection = await projectionOf(mb, msg.id);
    expect(projection?.recipientState['b']?.completedAt).toBeUndefined();
    expect(projection?.recipientState['b']?.readAt).toBeDefined();
  });

  it('reopens a direct message whose completion exists only in v1 state', async () => {
    const timestamp = '2026-01-01T01:00:00.000Z';
    const store = await openWithLegacyLines([
      JSON.stringify({
        id: 'legacy-direct',
        from: 'a',
        to: 'b@sess-1',
        type: 'ask',
        subject: 'q',
        body: '?',
        priority: 'normal',
        readBy: {},
        completed: false,
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      JSON.stringify({
        __ack: true,
        messageId: 'legacy-direct',
        readerId: 'b@sess-1',
        timestamp,
        read: true,
        completed: true,
        completedBy: 'b@sess-1',
      }),
    ]);

    await store.ack({
      messageId: 'legacy-direct',
      readerId: 'b@sess-1',
      read: false,
      completed: false,
    });

    const projection = await projectionOf(store, 'legacy-direct');
    expect(projection?.recipientState['b@sess-1']?.completedAt).toBeUndefined();
  });

  it('mark-read after completion does NOT silently reopen', async () => {
    // Regression: a routine mark-read (read:true, completed omitted) on an
    // already-completed message must NOT reopen it. Only the explicit
    // reopen verb (read:false, completed:false) reopens.
    const msg = await mb.send({
      from: 'a',
      to: 'b',
      type: 'ask',
      subject: 'q',
      body: '?',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'b',
      read: true,
      completed: true,
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'b',
      read: true,
    });
    const incomplete = await mb.query({
      to: 'b',
      unreadBy: 'b',
      readerRole: 'worker',
      incompleteOnly: true,
    });
    expect(incomplete.map((m) => m.id)).not.toContain(msg.id);
    expect((await projectionOf(mb, msg.id))?.recipientState['b']?.completedAt).toBeDefined();
  });

  it('outcome-only ack after completion does NOT silently reopen', async () => {
    // Regression: setting an outcome after completion (completed:undefined)
    // must not reopen the message.
    const msg = await mb.send({
      from: 'a',
      to: 'b',
      type: 'ask',
      subject: 'q',
      body: '?',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'b',
      read: true,
      completed: true,
    });
    // Outcome-only ack - completed is undefined, not false
    await mb.ack({
      messageId: msg.id,
      readerId: 'b',
      outcome: 'resolved',
    });
    const projection = await projectionOf(mb, msg.id);
    expect(projection?.recipientState['b']?.completedAt).toBeDefined();
    expect(projection?.recipientState['b']?.outcome).toBe('resolved');
    const incomplete = await mb.query({
      to: 'b',
      unreadBy: 'b',
      readerRole: 'worker',
      incompleteOnly: true,
    });
    expect(incomplete.map((m) => m.id)).not.toContain(msg.id);
  });

  it('returns the freshly folded actor receipt from ackMany', async () => {
    const msg = await mb.send({
      from: 'a',
      to: 'b',
      type: 'ask',
      subject: 'q',
      body: '?',
    });

    const [updated] = await mb.ackMany({
      acks: [
        {
          messageId: msg.id,
          readerId: 'b',
          read: true,
          completed: true,
          outcome: 'resolved',
        },
      ],
    });
    const projection = updated as MailboxMessageProjection;

    expect(projection.recipientState['b']).toMatchObject({
      actorId: 'b',
      outcome: 'resolved',
    });
    expect(projection.recipientState['b']?.readAt).toBeDefined();
    expect(projection.recipientState['b']?.completedAt).toBeDefined();
    expect(updated).toMatchObject({
      completed: true,
      completedBy: 'b',
      outcome: 'resolved',
    });
    expect(updated?.completedAt).toBeDefined();

    const repeated = await mb.ack({
      messageId: msg.id,
      readerId: 'b',
      read: true,
      completed: true,
    });
    expect(repeated).toMatchObject({ completed: true, completedBy: 'b' });
    expect(repeated?.completedAt).toBeDefined();
  });

  it('records the same outcome independently for two actors', async () => {
    const msg = await mb.send({
      from: 'leader',
      to: '*',
      type: 'broadcast',
      subject: 's',
      body: 'b',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'actor-a',
      read: true,
      outcome: 'acknowledged',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'actor-b',
      read: true,
      outcome: 'acknowledged',
    });

    const projection = await projectionOf(mb, msg.id);
    expect(projection?.recipientState['actor-a']?.outcome).toBe('acknowledged');
    expect(projection?.recipientState['actor-b']?.outcome).toBe('acknowledged');
  });

  it('two actors on a broadcast get independent outcomes', async () => {
    // Regression: actor A sets outcome "fixed" and actor B sets outcome
    // "wontfix" on the same broadcast. Each actor's state must be its OWN,
    // not the message-global one and not the other actor's.
    const msg = await mb.send({
      from: 'a',
      to: '*',
      type: 'broadcast',
      subject: 'bug',
      body: 'crash on startup',
    });

    await mb.ack({
      messageId: msg.id,
      readerId: 'worker-a@sess-1',
      read: true,
      completed: true,
      outcome: 'fixed',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'worker-b@sess-2',
      read: true,
      completed: true,
      outcome: 'wontfix',
    });

    const projection = await projectionOf(mb, msg.id);
    expect(projection?.recipientState['worker-a@sess-1']?.outcome).toBe('fixed');
    expect(projection?.recipientState['worker-b@sess-2']?.outcome).toBe('wontfix');

    // Actor A changes its outcome - actor B's is untouched.
    await mb.ack({
      messageId: msg.id,
      readerId: 'worker-a@sess-1',
      outcome: 'needs-review',
    });
    const final = await projectionOf(mb, msg.id);
    expect(final?.recipientState['worker-a@sess-1']?.outcome).toBe('needs-review');
    expect(final?.recipientState['worker-b@sess-2']?.outcome).toBe('wontfix');
  });

  it('unread count respects actor-scoped completion', async () => {
    const msg = await mb.send({
      from: 'a',
      to: '*',
      type: 'broadcast',
      subject: 's',
      body: 'b',
    });
    // Actor A reads but does not complete
    await mb.ack({ messageId: msg.id, readerId: 'a', read: true });
    // Actor A unread count: 0 (already read)
    expect(await mb.unreadCount('a')).toBe(0);
    // Actor B unread count: 1 (unread, incomplete)
    expect(await mb.unreadCount('b')).toBe(1);
  });
});

// ── Compaction v2 preservation ───────────────────────────────────────

describe('SqliteMailbox autoCompact preserves v2 receipts', () => {
  it('retains a v2 broadcast on the incomplete TTL while a recipient is unfinished', async () => {
    await mb.registerAgent({
      agentId: 'actor-a@s',
      sessionId: 's',
      name: 'A',
      role: 'worker',
      pid: 1,
    });
    await mb.registerAgent({
      agentId: 'actor-b@s',
      sessionId: 's',
      name: 'B',
      role: 'worker',
      pid: 2,
    });
    const msg = await mb.send({
      from: 'leader@s',
      to: '*',
      type: 'broadcast',
      subject: 'fan-out',
      body: 'b',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'actor-a@s',
      read: true,
      completed: true,
    });

    const result = await mb.autoCompact({
      defaultTtlMs: 86_400_000,
      completedMaxAgeMs: -1,
      incompleteMaxAgeMs: 86_400_000,
    });

    expect(result.stalePurged).toBe(0);
    expect((await mb.query({ limit: 100 })).map((message) => message.id)).toContain(msg.id);
  });

  it('v2 receipts survive an autoCompact pass', async () => {
    const msg1 = await mb.send({
      from: 'a',
      to: 'b',
      type: 'note',
      subject: 'm1',
      body: 'b',
    });
    const msg2 = await mb.send({
      from: 'a',
      to: 'b',
      type: 'note',
      subject: 'm2',
      body: 'b',
    });
    await mb.ack({ messageId: msg1.id, readerId: 'b', read: true, completed: true });
    await mb.ack({ messageId: msg2.id, readerId: 'b', read: true });

    // Large TTL so nothing is removed by expiry.
    await mb.autoCompact({ defaultTtlMs: 86400_000 });

    expect((await projectionOf(mb, msg1.id))?.recipientState['b']?.completedAt).toBeDefined();
    expect((await projectionOf(mb, msg2.id))?.recipientState['b']?.readAt).toBeDefined();
  });

  it('read-by-all compaction keeps v2 receipts for surviving messages', async () => {
    const oldTime = new Date(Date.now() - 300_000).toISOString();
    const nowTime = new Date().toISOString();

    // Seed one message that survives (recent) and one that is dropped
    // (old and already read by every online agent).
    const store = await openWithLegacyLines([
      JSON.stringify({
        id: 'keep-me',
        from: 'a',
        to: 'ag1',
        type: 'note',
        subject: 'keep',
        body: 'b',
        priority: 'normal',
        readBy: { ag1: oldTime },
        completed: false,
        timestamp: nowTime,
      }),
      JSON.stringify({
        id: 'purge-me',
        from: 'a',
        to: 'ag1',
        type: 'note',
        subject: 'purge',
        body: 'b',
        priority: 'normal',
        readBy: { ag1: oldTime },
        completed: false,
        timestamp: oldTime,
      }),
    ]);
    await store.registerAgent({
      agentId: 'ag1',
      sessionId: 's',
      name: 'A',
      role: 'r',
      pid: 1,
    });
    await store.ack({ messageId: 'keep-me', readerId: 'ag1', read: true, completed: true });

    const result = await store.autoCompact({ readMaxAgeMs: 60_000, defaultTtlMs: 86400_000 });
    expect(result.totalRemoved).toBeGreaterThanOrEqual(1);

    const ids = (await store.query({ limit: 100 })).map((message) => message.id);
    expect(ids).toContain('keep-me');
    expect(ids).not.toContain('purge-me');
    expect(
      (await projectionOf(store, 'keep-me'))?.recipientState['ag1']?.completedAt,
    ).toBeDefined();
  });
});

describe('SqliteMailbox purgeStale preserves v2 receipts', () => {
  it('keeps actor-reopened work on the incomplete retention path', async () => {
    const oldTime = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const store = await openWithLegacyLines([
      JSON.stringify({
        id: 'reopened',
        from: 'a',
        to: 'b',
        type: 'ask',
        subject: 'work',
        body: 'b',
        priority: 'normal',
        readBy: { b: oldTime },
        completed: true,
        completedBy: 'b',
        completedAt: oldTime,
        timestamp: oldTime,
      }),
      JSON.stringify(buildReceiptRecordV2('reopened', 'b', oldTime, { completed: true })),
      JSON.stringify(buildReceiptRecordV2('reopened', 'b', oldTime, { completed: false })),
    ]);

    const result = await store.purgeStale({
      completedMaxAgeMs: 86_400_000,
      incompleteMaxAgeMs: 7 * 86_400_000,
    });
    expect(result.totalPurged).toBe(0);
    expect((await store.query({ limit: 100 })).map((m) => m.id)).toContain('reopened');
  });

  it('retains a v2 broadcast until every intended recipient completes it', async () => {
    await mb.registerAgent({
      agentId: 'actor-a@s',
      sessionId: 's',
      name: 'A',
      role: 'worker',
      pid: 1,
    });
    await mb.registerAgent({
      agentId: 'actor-b@s',
      sessionId: 's',
      name: 'B',
      role: 'worker',
      pid: 2,
    });
    const msg = await mb.send({
      from: 'leader@s',
      to: '*',
      type: 'broadcast',
      subject: 'fan-out',
      body: 'b',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'actor-a@s',
      read: true,
      completed: true,
    });

    const result = await mb.purgeStale({
      completedMaxAgeMs: -1,
      incompleteMaxAgeMs: 86_400_000,
    });

    expect(result.completedPurged).toBe(0);
    expect((await mb.query({ limit: 100 })).map((message) => message.id)).toContain(msg.id);
  });

  it('v2 receipts survive a purge pass', async () => {
    const now = Date.now();
    const oldTime = new Date(now - 10 * 86400_000).toISOString();
    const recentTime = new Date(now).toISOString();

    const store = await openWithLegacyLines([
      JSON.stringify({
        id: 'old-done',
        from: 'a',
        to: 'b',
        type: 'note',
        subject: 'old',
        body: 'b',
        priority: 'normal',
        readBy: {},
        completed: true,
        completedAt: oldTime,
        completedBy: 'b',
        timestamp: oldTime,
      }),
      JSON.stringify({
        id: 'keep-me',
        from: 'a',
        to: 'b',
        type: 'note',
        subject: 'keep',
        body: 'b',
        priority: 'normal',
        readBy: {},
        completed: false,
        timestamp: recentTime,
      }),
    ]);
    await store.ack({ messageId: 'keep-me', readerId: 'b', read: true });

    // old-done was completed >1 day ago and is dropped; keep-me stays.
    await store.purgeStale();

    const ids = (await store.query({ limit: 100 })).map((message) => message.id);
    expect(ids).toContain('keep-me');
    expect(ids).not.toContain('old-done');
    expect((await projectionOf(store, 'keep-me'))?.recipientState['b']?.readAt).toBeDefined();
  });
});

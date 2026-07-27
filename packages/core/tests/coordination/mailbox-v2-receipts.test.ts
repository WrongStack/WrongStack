/**
 * GM-P0.4 + GM-P0.4A — Tests for v2 receipt records, materialized view,
 * version fence, and migration classification.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlobalMailbox } from '../../src/coordination/global-mailbox.js';
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
import {
  MAILBOX_VERSION_CURRENT,
  MAILBOX_VERSION_SENTINEL,
  MailboxVersionFenceError,
  assertMailboxNotFenced,
  checkMailboxVersion,
  checkMailboxVersionFromContent,
  ensureVersionSentinel,
  isMailboxVersionMarker,
  sentinelLine,
} from '../../src/coordination/mailbox-version-fence.js';
import { isMailboxReceiptRecordV2 } from '../../src/coordination/mailbox-types.js';
import { parseMailboxLines } from '../../src/coordination/mailbox-message-codec.js';

let dir: string;
let mb: GlobalMailbox;
const events = { emitCustom: () => {} };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-v2-'));
  mb = new GlobalMailbox(dir, events as never as EventBus);
});

afterEach(async () => {
  await mb.close();
  await fs.rm(dir, { recursive: true, force: true });
});

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
    expect(
      isMailboxReceiptRecordV2({ __mailboxReceipt: 2, messageId: 'm1', actorId: 'a' }),
    ).toBe(false);
  });

  it('rejects empty strings for required fields', () => {
    expect(
      isMailboxReceiptRecordV2({ __mailboxReceipt: 2, messageId: '', actorId: 'a', timestamp: 't' }),
    ).toBe(false);
    expect(
      isMailboxReceiptRecordV2({ __mailboxReceipt: 2, messageId: 'm', actorId: '', timestamp: 't' }),
    ).toBe(false);
  });

  it('rejects wrong-typed optional fields', () => {
    expect(
      isMailboxReceiptRecordV2({
        __mailboxReceipt: 2, messageId: 'm', actorId: 'a', timestamp: 't', read: 'yes',
      }),
    ).toBe(false);
    expect(
      isMailboxReceiptRecordV2({
        __mailboxReceipt: 2, messageId: 'm', actorId: 'a', timestamp: 't', completed: 'true',
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
      id: 'm1', from: 'a', to: 'worker-1@sess-1', type: 'note',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: true, completedBy: 'worker-1@sess-1', completedAt: '2026-01-01T01:00:00Z',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const projections = materializeMessages([msg], []);
    expect(projections[0]!.legacyGlobalCompletion).toBeUndefined();
    expect(projections[0]!.recipientState['worker-1@sess-1']?.completedAt).toBe('2026-01-01T01:00:00Z');
  });

  it('classifies completed process-qualified direct message as actor-scoped', () => {
    const msg: MailboxMessage = {
      id: 'm1', from: 'a', to: 'leader#123', type: 'ask',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: true, completedBy: 'leader#123', completedAt: '2026-01-01T01:00:00Z',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const projections = materializeMessages([msg], []);
    expect(projections[0]!.legacyGlobalCompletion).toBeUndefined();
    expect(projections[0]!.recipientState['leader#123']?.completedAt).toBe(
      '2026-01-01T01:00:00Z',
    );
  });

  it('classifies completed broadcast as legacyGlobalCompletion', () => {
    const msg: MailboxMessage = {
      id: 'm1', from: 'a', to: '*', type: 'broadcast',
      subject: 's', body: 'b', priority: 'normal',
      readBy: { 'worker-1': '2026-01-01T00:30:00Z' },
      completed: true, completedBy: 'worker-1', completedAt: '2026-01-01T01:00:00Z',
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
      id: 'm1', from: 'a', to: '*', type: 'broadcast',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: true, completedBy: 'worker-1', completedAt: '2026-01-01T01:00:00Z',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const receipts = [
      buildReceiptRecordV2('m1', 'worker-2', '2026-01-01T02:00:00Z', { read: true }),
    ];

    const projections = materializeMessages([msg], receipts);

    expect(projections[0]!.legacyGlobalCompletion).toBe(true);
    expect(projections[0]!.recipientState['worker-2']?.readAt).toBe(
      '2026-01-01T02:00:00Z',
    );
    expect(projections[0]!.recipientState['worker-2']?.completedAt).toBeUndefined();
  });

  it('classifies completed session broadcast as legacyGlobalCompletion', () => {
    const msg: MailboxMessage = {
      id: 'm1', from: 'a', to: '@session:sess-1', type: 'broadcast',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: true, completedBy: 'a', completedAt: '2026-01-01T01:00:00Z',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const projections = materializeMessages([msg], []);
    expect(projections[0]!.legacyGlobalCompletion).toBe(true);
  });

  it('classifies incomplete messages as neither legacy nor actor-scoped', () => {
    const msg: MailboxMessage = {
      id: 'm1', from: 'a', to: '*', type: 'broadcast',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: false, timestamp: '2026-01-01T00:00:00Z',
    };
    const projections = materializeMessages([msg], []);
    expect(projections[0]!.legacyGlobalCompletion).toBeUndefined();
  });
});

// ── V2 receipt folding algebra ───────────────────────────────────────

describe('materializeMessages — v2 receipt folding', () => {
  it('folds a read receipt from v2 record', () => {
    const msg: MailboxMessage = {
      id: 'm1', from: 'a', to: 'b', type: 'note',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: false, timestamp: '2026-01-01T00:00:00Z',
    };
    const receipts = [
      buildReceiptRecordV2('m1', 'b', '2026-01-01T01:00:00Z', { read: true }),
    ];
    const projections = materializeMessages([msg], receipts);
    expect(projections[0]!.recipientState['b']?.readAt).toBe('2026-01-01T01:00:00Z');
  });

  it('folds a completion from v2 record', () => {
    const msg: MailboxMessage = {
      id: 'm1', from: 'a', to: 'b', type: 'ask',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: false, timestamp: '2026-01-01T00:00:00Z',
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
      id: 'm1', from: 'a', to: '*', type: 'broadcast',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: false, timestamp: '2026-01-01T00:00:00Z',
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
      id: 'm1', from: 'a', to: '*', type: 'broadcast',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: false, timestamp: '2026-01-01T00:00:00Z',
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
      id: 'm1', from: 'a', to: 'b', type: 'ask',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: false, timestamp: '2026-01-01T00:00:00Z',
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
      id: 'm1', from: 'a', to: 'b', type: 'ask',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: false, timestamp: '2026-01-01T00:00:00Z',
    };
    const timestamp = '2026-01-01T01:00:00Z';
    const projections = materializeMessages([msg], [
      buildReceiptRecordV2('m1', 'b', timestamp, { completed: true }),
      buildReceiptRecordV2('m1', 'b', timestamp, { completed: false }),
    ]);
    expect(projections[0]!.recipientState['b']?.completedAt).toBeUndefined();
  });

  it('duplicate records (same timestamp) are idempotent', () => {
    const msg: MailboxMessage = {
      id: 'm1', from: 'a', to: 'b', type: 'note',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: false, timestamp: '2026-01-01T00:00:00Z',
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
      id: 'm1', from: 'a', to: '*', type: 'broadcast',
      subject: 's', body: 'b', priority: 'normal', readBy: {},
      completed: false, timestamp: '2026-01-01T00:00:00Z',
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
      { id: 'm1', from: 'a', to: 'b', type: 'note', subject: 's', body: 'b', priority: 'normal', readBy: {}, completed: false, timestamp: 't' },
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
    ].map((record) => JSON.stringify(record)).join('\n');

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

// ── Version fence ────────────────────────────────────────────────────

describe('Version fence', () => {
  describe('isMailboxVersionMarker', () => {
    it('accepts a valid marker', () => {
      expect(isMailboxVersionMarker({ __mailboxVersion: 2 })).toBe(true);
    });
    it('rejects non-objects', () => {
      expect(isMailboxVersionMarker(null)).toBe(false);
      expect(isMailboxVersionMarker(42)).toBe(false);
      expect(isMailboxVersionMarker([])).toBe(false);
    });
    it('rejects objects without the key', () => {
      expect(isMailboxVersionMarker({ __ack: true })).toBe(false);
    });
  });

  describe('checkMailboxVersion', () => {
    it('returns null for a nonexistent file', async () => {
      const p = path.join(dir, 'no-such.jsonl');
      expect(await checkMailboxVersion(p)).toBeNull();
    });

    it('returns null for a file without a marker', async () => {
      const p = path.join(dir, 'v1.jsonl');
      await fs.writeFile(p, '{"id":"m1","type":"note"}\n');
      expect(await checkMailboxVersion(p)).toBeNull();
    });

    it('returns the version for a fenced file', async () => {
      const p = path.join(dir, 'fenced.jsonl');
      await fs.writeFile(p, `${MAILBOX_VERSION_SENTINEL}\n{"id":"m1"}\n`);
      expect(await checkMailboxVersion(p)).toBe(2);
    });
  });

  describe('checkMailboxVersionFromContent', () => {
    it('returns null for content without a marker', () => {
      expect(checkMailboxVersionFromContent('{"id":"m1"}\n')).toBeNull();
    });
    it('returns the version for content with a marker', () => {
      expect(checkMailboxVersionFromContent(`${MAILBOX_VERSION_SENTINEL}\n`)).toBe(2);
    });
    it('handles mixed content', () => {
      const content = `{"id":"m1"}\n${MAILBOX_VERSION_SENTINEL}\n{"__ack":true}\n`;
      expect(checkMailboxVersionFromContent(content)).toBe(2);
    });
  });

  describe('ensureVersionSentinel', () => {
    it('writes the sentinel to a new file', async () => {
      const p = path.join(dir, 'new.jsonl');
      await fs.writeFile(p, '{"id":"m1"}\n');
      await ensureVersionSentinel(p);
      const version = await checkMailboxVersion(p);
      expect(version).toBe(2);
    });

    it('is idempotent — does not duplicate the sentinel', async () => {
      const p = path.join(dir, 'idempotent.jsonl');
      await fs.writeFile(p, `${MAILBOX_VERSION_SENTINEL}\n`);
      await ensureVersionSentinel(p);
      const content = await fs.readFile(p, 'utf8');
      const count = (content.match(/__mailboxVersion/g) ?? []).length;
      expect(count).toBe(1);
    });
  });

  describe('assertMailboxNotFenced', () => {
    it('passes for a v1 file', async () => {
      const p = path.join(dir, 'v1.jsonl');
      await fs.writeFile(p, '{"id":"m1"}\n');
      await expect(assertMailboxNotFenced(p)).resolves.toBeUndefined();
    });

    it('passes for a file at our version', async () => {
      const p = path.join(dir, 'same.jsonl');
      await fs.writeFile(p, `${MAILBOX_VERSION_SENTINEL}\n`);
      await expect(assertMailboxNotFenced(p, MAILBOX_VERSION_CURRENT)).resolves.toBeUndefined();
    });

    it('throws for a file with a newer version', async () => {
      const p = path.join(dir, 'newer.jsonl');
      await fs.writeFile(p, '{"__mailboxVersion":3}\n');
      await expect(assertMailboxNotFenced(p, 2)).rejects.toThrow(MailboxVersionFenceError);
    });
  });

  describe('sentinelLine', () => {
    it('returns a valid JSON line ending with newline', () => {
      const line = sentinelLine();
      expect(line.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(line.trim());
      expect(parsed.__mailboxVersion).toBe(2);
    });
  });
});

// ── End-to-end: GlobalMailbox with v2 receipts ───────────────────────

describe('GlobalMailbox v2 receipt integration', () => {
  it('appends v2 receipt records alongside v1 acks (dual-write)', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'ask', subject: 'q', body: '?',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'b',
      read: true,
      completed: true,
    });
    await mb.close();

    // Read the raw file and check for v2 receipt records.
    const raw = await fs.readFile(mb.messagePath, 'utf8');
    const parsed = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));

    const v2Receipts = parsed.filter((p) => p.__mailboxReceipt === 2);
    const v1Acks = parsed.filter((p) => p.__ack === true);

    // Dual-write: both v1 ack and v2 receipt should be present.
    expect(v1Acks.length).toBeGreaterThanOrEqual(1);
    expect(v2Receipts.length).toBeGreaterThanOrEqual(1);

    // v2 receipt should have the right fields.
    const receipt = v2Receipts[0];
    expect(receipt.messageId).toBe(msg.id);
    expect(receipt.actorId).toBe('b');
    expect(receipt.read).toBe(true);
    expect(receipt.completed).toBe(true);
  });

  it('keeps actor completion and outcome out of the legacy ack for fan-out messages', async () => {
    const msg = await mb.send({
      from: 'leader', to: '*', type: 'broadcast', subject: 'q', body: '?',
    });
    await mb.ack({
      messageId: msg.id,
      readerId: 'actor-a',
      read: true,
      completed: true,
      outcome: 'handled by actor a',
    });

    const raw = await fs.readFile(mb.messagePath, 'utf8');
    const legacyMessage = parseMailboxLines(raw).find((message) => message.id === msg.id);
    const modernMessage = parseMailboxFile(raw).find((message) => message.id === msg.id);

    expect(legacyMessage).toBeDefined();
    expect(legacyMessage?.readBy['actor-a']).toBeDefined();
    expect(legacyMessage?.completed).toBe(false);
    expect(legacyMessage?.completedBy).toBeUndefined();
    expect(legacyMessage?.outcome).toBeUndefined();
    expect(modernMessage?.recipientState['actor-a']?.completedAt).toBeDefined();
    expect(modernMessage?.recipientState['actor-a']?.outcome).toBe('handled by actor a');
  });

  it('writes the version sentinel on first v2 receipt', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'note', subject: 's', body: 'b',
    });
    await mb.ack({ messageId: msg.id, readerId: 'b', read: true });
    await mb.close();

    const version = await checkMailboxVersion(mb.messagePath);
    expect(version).toBe(2);
  });

  it('mixed v1/v2 JSONL survives read, append, close, and reopen', async () => {
    // Write a v1 message and v1 ack.
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'note', subject: 's', body: 'b',
    });
    await mb.ack({ messageId: msg.id, readerId: 'b', read: true });
    await mb.close();

    // Reopen and send another message.
    const mb2 = new GlobalMailbox(dir, events as never as EventBus);
    const msg2 = await mb2.send({
      from: 'a', to: 'b', type: 'note', subject: 's2', body: 'b2',
    });
    await mb2.ack({ messageId: msg2.id, readerId: 'b', read: true, completed: true });
    await mb2.close();

    // Reopen again and verify both messages survive.
    const mb3 = new GlobalMailbox(dir, events as never as EventBus);
    const all = await mb3.query({ limit: 100 });
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.subject)).toContain('s');
    expect(all.map((m) => m.subject)).toContain('s2');
    await mb3.close();
  });
});

// ── parseMailboxFile unit integration ────────────────────────────────

describe('parseMailboxFile integration', () => {
  it('folds v1 message + v2 receipt into recipientState', () => {
    const msg = JSON.stringify({
      id: 'm1', from: 'a', to: 'b', type: 'note',
      subject: 's', body: 'b', priority: 'normal',
      readBy: {}, completed: false, timestamp: '2026-01-01T00:00:00Z',
    });
    const receipt = JSON.stringify({
      __mailboxReceipt: 2, messageId: 'm1', actorId: 'b',
      timestamp: '2026-01-01T01:00:00Z', read: true, completed: true,
    });
    const projections = parseMailboxFile(`${msg}\n${receipt}\n`);
    expect(projections).toHaveLength(1);
    expect(projections[0]!.recipientState['b']?.readAt).toBe('2026-01-01T01:00:00Z');
    expect(projections[0]!.recipientState['b']?.completedAt).toBe('2026-01-01T01:00:00Z');
  });

  it('classifies v1 broadcast completed as legacyGlobalCompletion', () => {
    const msg = JSON.stringify({
      id: 'm1', from: 'a', to: '*', type: 'broadcast',
      subject: 's', body: 'b', priority: 'normal',
      readBy: {}, completed: true, completedBy: 'x',
      completedAt: '2026-01-01T01:00:00Z', timestamp: '2026-01-01T00:00:00Z',
    });
    const projections = parseMailboxFile(`${msg}\n`);
    expect(projections[0]!.legacyGlobalCompletion).toBe(true);
  });

  it('preserves readBy seeds for v2 receipt state', () => {
    const msg = JSON.stringify({
      id: 'm1', from: 'a', to: 'b', type: 'note',
      subject: 's', body: 'b', priority: 'normal',
      readBy: { 'b': '2026-01-01T00:30:00Z' },
      completed: false, timestamp: '2026-01-01T00:00:00Z',
    });
    const projections = parseMailboxFile(`${msg}\n`);
    expect(projections[0]!.recipientState['b']?.readAt).toBe('2026-01-01T00:30:00Z');
  });

  it('skips malformed lines without dropping valid messages', () => {
    const msg = JSON.stringify({
      id: 'm1', from: 'a', to: 'b', type: 'note',
      subject: 's', body: 'b', priority: 'normal',
      readBy: {}, completed: false, timestamp: '2026-01-01T00:00:00Z',
    });
    const projections = parseMailboxFile(`${msg}\nnot-json\n{}\n`);
    expect(projections).toHaveLength(1);
    expect(projections[0]!.id).toBe('m1');
  });
});

// ── Actor-scoped completion ──────────────────────────────────────────

describe('GlobalMailbox v2 actor-scoped completion', () => {
  it('persists separate completions when two actors complete a broadcast', async () => {
    const msg = await mb.send({
      from: 'leader', to: '*', type: 'broadcast',
      subject: 'all-hands', body: 'meeting',
    });
    await mb.ack({
      messageId: msg.id, readerId: 'actor-a', read: true, completed: true,
    });

    const forB = await mb.query({
      to: '*', unreadBy: 'actor-b', readerRole: 'worker', incompleteOnly: true,
    });
    expect(forB.map((message) => message.id)).toContain(msg.id);
    expect(forB[0]).not.toHaveProperty('recipientState');
    expect(forB[0]).not.toHaveProperty('legacyGlobalCompletion');

    await mb.ack({
      messageId: msg.id, readerId: 'actor-b', read: true, completed: true,
    });
    await mb.close();

    const reopened = new GlobalMailbox(dir, events as never as EventBus);
    try {
      const forBAfterReopen = await reopened.query({
        to: '*', unreadBy: 'actor-b', readerRole: 'worker', incompleteOnly: true,
      });
      expect(forBAfterReopen.map((message) => message.id)).not.toContain(msg.id);
      const forAAfterReopen = await reopened.query({
        to: '*', unreadBy: 'actor-a', readerRole: 'worker', incompleteOnly: true,
      });
      expect(forAAfterReopen.map((message) => message.id)).not.toContain(msg.id);

      const persisted = parseMailboxFile(await fs.readFile(reopened.messagePath, 'utf8'))
        .find((message) => message.id === msg.id);
      expect(persisted?.recipientState['actor-a']?.completedAt).toBeDefined();
      expect(persisted?.recipientState['actor-b']?.completedAt).toBeDefined();
    } finally {
      await reopened.close();
    }
  });

  it('direct message completion is actor-scoped', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'ask', subject: 'q', body: '?',
    });
    await mb.ack({
      messageId: msg.id, readerId: 'b', read: true, completed: true,
    });
    // B queries incompleteOnly — should NOT see it
    const forB = await mb.query({
      to: 'b', unreadBy: 'b', readerRole: 'worker', incompleteOnly: true,
    });
    expect(forB.map((m) => m.id)).not.toContain(msg.id);
  });

  it('does not append a duplicate read won by another mailbox instance', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'note', subject: 'q', body: '?',
    });
    const competing = new GlobalMailbox(dir, events as never as EventBus);
    try {
      await Promise.all([mb.query({ limit: 100 }), competing.query({ limit: 100 })]);
      const originalRead = Reflect.get(
        mb,
        '_readMessagesCached',
      ) as () => Promise<MailboxMessage[]>;
      let injected = false;
      Reflect.set(mb, '_readMessagesCached', async () => {
        const messages = await originalRead.call(mb);
        if (!injected) {
          injected = true;
          await competing.ack({ messageId: msg.id, readerId: 'b', read: true });
        }
        return messages;
      });

      await mb.ack({ messageId: msg.id, readerId: 'b', read: true });

      const raw = await fs.readFile(mb.messagePath, 'utf8');
      const readReceipts = raw
        .split('\n')
        .filter((line) => line.includes('"__mailboxReceipt":2'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((receipt) => receipt.messageId === msg.id && receipt.actorId === 'b' && receipt.read === true);
      expect(readReceipts).toHaveLength(1);
    } finally {
      await competing.close();
    }
  });

  it('does not append a v2 completion after a legacy fan-out completion wins the race', async () => {
    const msg = await mb.send({
      from: 'a', to: '*', type: 'broadcast', subject: 'q', body: '?',
    });
    const originalRead = Reflect.get(
      mb,
      '_readMessagesCached',
    ) as () => Promise<MailboxMessage[]>;
    let injected = false;
    Reflect.set(mb, '_readMessagesCached', async () => {
      const messages = await originalRead.call(mb);
      if (!injected) {
        injected = true;
        await fs.appendFile(mb.messagePath, `${JSON.stringify({
          __ack: true,
          messageId: msg.id,
          readerId: 'legacy-worker',
          timestamp: new Date().toISOString(),
          read: false,
          completed: true,
          completedBy: 'legacy-worker',
        })}\n`, 'utf8');
      }
      return messages;
    });

    await mb.ack({
      messageId: msg.id, readerId: 'modern-worker', read: false, completed: true,
    });

    const raw = await fs.readFile(mb.messagePath, 'utf8');
    const modernReceipts = raw
      .split('\n')
      .filter((line) => line.includes('"__mailboxReceipt":2'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((receipt) => receipt.messageId === msg.id && receipt.actorId === 'modern-worker');
    expect(modernReceipts).toHaveLength(0);
    expect(parseMailboxFile(raw).find((message) => message.id === msg.id)?.legacyGlobalCompletion)
      .toBe(true);
  });

  it('does not append a duplicate completion won by another mailbox instance', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'ask', subject: 'q', body: '?',
    });
    const competing = new GlobalMailbox(dir, events as never as EventBus);
    try {
      // Populate both optimistic caches before either completion is appended.
      await Promise.all([mb.query({ limit: 100 }), competing.query({ limit: 100 })]);
      const originalRead = Reflect.get(
        mb,
        '_readMessagesCached',
      ) as () => Promise<MailboxMessage[]>;
      let injected = false;
      Reflect.set(mb, '_readMessagesCached', async () => {
        const messages = await originalRead.call(mb);
        if (!injected) {
          injected = true;
          await competing.ack({
            messageId: msg.id, readerId: 'b', read: true, completed: true,
          });
        }
        return messages;
      });

      await mb.ack({ messageId: msg.id, readerId: 'b', read: true, completed: true });

      const raw = await fs.readFile(mb.messagePath, 'utf8');
      const completionReceipts = raw
        .split('\n')
        .filter((line) => line.includes('"__mailboxReceipt":2'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((receipt) => receipt.messageId === msg.id && receipt.actorId === 'b' && receipt.completed === true);
      expect(completionReceipts).toHaveLength(1);
    } finally {
      await competing.close();
    }
  });

  it('preserves a new read receipt when another mailbox wins the completion race', { timeout: 5000 }, async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'ask', subject: 'q', body: '?',
    });
    const competing = new GlobalMailbox(dir, events as never as EventBus);
    try {
      await Promise.all([mb.query({ limit: 100 }), competing.query({ limit: 100 })]);
      const originalRead = Reflect.get(
        mb,
        '_readMessagesCached',
      ) as () => Promise<MailboxMessage[]>;
      let injected = false;
      Reflect.set(mb, '_readMessagesCached', async () => {
        const messages = await originalRead.call(mb);
        if (!injected) {
          injected = true;
          await competing.ack({
            messageId: msg.id, readerId: 'b', read: false, completed: true,
          });
        }
        return messages;
      });

      await mb.ack({
        messageId: msg.id,
        readerId: 'b',
        read: true,
        completed: true,
      });

      const projection = parseMailboxFile(await fs.readFile(mb.messagePath, 'utf8'))
        .find((message) => message.id === msg.id);
      expect(projection?.recipientState['b']?.completedAt).toBeDefined();
      expect(projection?.recipientState['b']?.readAt).toBeDefined();
    } finally {
      await competing.close();
    }
  });

  it('preserves outcome when another mailbox wins the completion race', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'ask', subject: 'q', body: '?',
    });
    const competing = new GlobalMailbox(dir, events as never as EventBus);
    try {
      await Promise.all([mb.query({ limit: 100 }), competing.query({ limit: 100 })]);
      const originalRead = Reflect.get(
        mb,
        '_readMessagesCached',
      ) as () => Promise<MailboxMessage[]>;
      let injected = false;
      Reflect.set(mb, '_readMessagesCached', async () => {
        const messages = await originalRead.call(mb);
        if (!injected) {
          injected = true;
          await competing.ack({
            messageId: msg.id, readerId: 'b', read: true, completed: true,
          });
        }
        return messages;
      });

      await mb.ack({
        messageId: msg.id,
        readerId: 'b',
        read: true,
        completed: true,
        outcome: 'resolved-by-primary',
      });

      const projection = parseMailboxFile(await fs.readFile(mb.messagePath, 'utf8'))
        .find((message) => message.id === msg.id);
      expect(projection?.recipientState['b']?.completedAt).toBeDefined();
      expect(projection?.recipientState['b']?.outcome).toBe('resolved-by-primary');
    } finally {
      await competing.close();
    }
  });

  it('reopen via completed:false makes message incomplete for that actor', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'ask', subject: 'q', body: '?',
    });
    // Complete it
    await mb.ack({
      messageId: msg.id, readerId: 'b', read: true, completed: true,
    });
    // Reopen using the canonical reopen verb: read:false + completed:false
    // (matches actionToAckInput('reopen') in mailbox-actions.ts)
    await mb.ack({
      messageId: msg.id, readerId: 'b',
      read: false,
      completed: false,
    });
    // An incomplete-work query is actor-scoped, not an unread query: the
    // reopened message remains read but must re-enter this actor's queue.
    const incomplete = await mb.query({
      to: 'b', unreadBy: 'b', readerRole: 'worker', incompleteOnly: true,
    });
    expect(incomplete.map((message) => message.id)).toContain(msg.id);
    expect(incomplete.find((message) => message.id === msg.id)?.readBy).toHaveProperty('b');

    // Assert the v2 projection reflects the reopen: completedAt must be cleared.
    const raw = await fs.readFile(mb.messagePath, 'utf8');
    const projections = parseMailboxFile(raw);
    const proj = projections.find((p) => p.id === msg.id);
    expect(proj).toBeDefined();
    expect(proj!.recipientState?.['b']?.completedAt).toBeUndefined();
    // V1 global completed stays true on disk (v2 reopen is actor-scoped)
    expect(raw).toContain('"completed":true');

    // Idempotency: a second reopen (mark-read with completed:false, which
    // is NOT the reopen verb) must not append another v2 receipt.
    const receiptsBefore = (raw.match(/__mailboxReceipt/g) ?? []).length;
    await mb.ack({ messageId: msg.id, readerId: 'b', read: true, completed: false });
    const rawAfterRepeatedReopen = await fs.readFile(mb.messagePath, 'utf8');
    expect((rawAfterRepeatedReopen.match(/__mailboxReceipt/g) ?? []).length).toBe(receiptsBefore);
  });

  it('reopens a direct message whose completion exists only in v1 state', async () => {
    const timestamp = '2026-01-01T01:00:00.000Z';
    await fs.writeFile(mb.messagePath, `${JSON.stringify({
      id: 'legacy-direct', from: 'a', to: 'b@sess-1', type: 'ask',
      subject: 'q', body: '?', priority: 'normal', readBy: {}, completed: false,
      timestamp: '2026-01-01T00:00:00.000Z',
    })}\n${JSON.stringify({
      __ack: true, messageId: 'legacy-direct', readerId: 'b@sess-1', timestamp,
      read: true, completed: true, completedBy: 'b@sess-1',
    })}\n`, 'utf8');
    await mb.close();

    await mb.ack({
      messageId: 'legacy-direct', readerId: 'b@sess-1', read: false, completed: false,
    });

    const projection = parseMailboxFile(await fs.readFile(mb.messagePath, 'utf8'))
      .find((message) => message.id === 'legacy-direct');
    expect(projection?.recipientState['b@sess-1']?.completedAt).toBeUndefined();
  });

  it('mark-read after completion does NOT silently reopen', async () => {
    // Regression: a routine mark-read (read:true, completed omitted) on an
    // already-completed message must NOT reopen it. Only the explicit
    // reopen verb (read:false, completed:false) reopens.
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'ask', subject: 'q', body: '?',
    });
    // Complete it
    await mb.ack({
      messageId: msg.id, readerId: 'b', read: true, completed: true,
    });
    // Now mark-read again (e.g. a second agent or a re-check) — completion
    // remains omitted and must NOT reopen.
    await mb.ack({
      messageId: msg.id, readerId: 'b', read: true,
    });
    // Query incompleteOnly for b — message should NOT appear
    const incomplete = await mb.query({
      to: 'b', unreadBy: 'b', readerRole: 'worker', incompleteOnly: true,
    });
    expect(incomplete.map((m) => m.id)).not.toContain(msg.id);
    // V1 global completed stays true
    const raw = await fs.readFile(mb.messagePath, 'utf8');
    expect(raw).toContain('"completed":true');
  });

  it('outcome-only ack after completion does NOT silently reopen', async () => {
    // Regression: setting an outcome after completion (completed:undefined)
    // must not reopen the message or write a completed:false receipt.
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'ask', subject: 'q', body: '?',
    });
    await mb.ack({
      messageId: msg.id, readerId: 'b', read: true, completed: true,
    });
    // Outcome-only ack — completed is undefined, not false
    await mb.ack({
      messageId: msg.id, readerId: 'b', outcome: 'resolved',
    });
    // V2 receipt for the outcome ack must NOT carry completed:false
    const raw = await fs.readFile(mb.messagePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.includes('__mailboxReceipt'));
    const lastReceipt = lines[lines.length - 1];
    expect(lastReceipt).toBeDefined();
    const parsed = JSON.parse(lastReceipt!);
    expect(parsed.completed).not.toBe(false);
    // Message should still be completed
    const incomplete = await mb.query({
      to: 'b', unreadBy: 'b', readerRole: 'worker', incompleteOnly: true,
    });
    expect(incomplete.map((m) => m.id)).not.toContain(msg.id);
  });

  it('returns the freshly folded actor receipt from ackMany', async () => {
    const msg = await mb.send({
      from: 'a', to: 'b', type: 'ask', subject: 'q', body: '?',
    });

    const [updated] = await mb.ackMany({
      acks: [{
        messageId: msg.id,
        readerId: 'b',
        read: true,
        completed: true,
        outcome: 'resolved',
      }],
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
      from: 'leader', to: '*', type: 'broadcast', subject: 's', body: 'b',
    });
    await mb.ack({
      messageId: msg.id, readerId: 'actor-a', read: true, outcome: 'acknowledged',
    });
    await mb.ack({
      messageId: msg.id, readerId: 'actor-b', read: true, outcome: 'acknowledged',
    });

    const projection = parseMailboxFile(await fs.readFile(mb.messagePath, 'utf8'))
      .find((message) => message.id === msg.id);
    expect(projection?.recipientState['actor-a']?.outcome).toBe('acknowledged');
    expect(projection?.recipientState['actor-b']?.outcome).toBe('acknowledged');
  });

  it('unread count respects actor-scoped completion', async () => {
    const msg = await mb.send({
      from: 'a', to: '*', type: 'broadcast', subject: 's', body: 'b',
    });
    // Actor A reads but does not complete
    await mb.ack({ messageId: msg.id, readerId: 'a', read: true });
    // Actor A unread count: 0 (already read)
    expect(await mb.unreadCount('a')).toBe(0);
    // Actor B unread count: 1 (unread, incomplete)
    expect(await mb.unreadCount('b')).toBe(1);
  });
});

// ── Version fence on mutations ───────────────────────────────────────

describe('GlobalMailbox version fence enforcement', () => {
  it('send is refused when mailbox has a newer version sentinel', async () => {
    // Write a version 3 sentinel to the mailbox file
    await fs.writeFile(mb.messagePath, '{"__mailboxVersion":3}\n');
    // Clear the cache so the next read sees the sentinel
    await mb.close();

    await expect(
      mb.send({ from: 'a', to: 'b', type: 'note', subject: 's', body: 'b' }),
    ).rejects.toThrow(MailboxVersionFenceError);
  });

  it('ack is refused when mailbox has a newer version sentinel', async () => {
    // Write a valid message line together with a version 3 sentinel
    const msgLine = JSON.stringify({
      id: 'test-msg', from: 'a', to: 'b', type: 'note',
      subject: 's', body: 'b', priority: 'normal' as const,
      readBy: {}, completed: false, timestamp: new Date().toISOString(),
    });
    await fs.writeFile(mb.messagePath, `${msgLine}\n{"__mailboxVersion":3}\n`);
    await mb.close();

    // ack should read the file, find the message, enter the lock, and
    // hit the version-fence check.
    const mb2 = new GlobalMailbox(dir, events as never as EventBus);
    await expect(
      mb2.ack({ messageId: 'test-msg', readerId: 'b', read: true }),
    ).rejects.toThrow(MailboxVersionFenceError);
    await mb2.close();
  });

  it('send succeeds when mailbox is at current version', async () => {
    // Write current-version sentinel
    await fs.writeFile(mb.messagePath, `${MAILBOX_VERSION_SENTINEL}\n`);
    await mb.close();
    // Current version = 2, sentinel is version 2 → allowed
    const mb2 = new GlobalMailbox(dir, events as never as EventBus);
    const msg = await mb2.send({
      from: 'a', to: 'b', type: 'note', subject: 's', body: 'b',
    });
    expect(msg.id).toBeDefined();
    await mb2.close();
  });
});

// ── Compaction v2 preservation ───────────────────────────────────────

describe('GlobalMailbox autoCompact preserves v2 receipts', () => {
  it('retains a v2 broadcast on the incomplete TTL while a recipient is unfinished', async () => {
    await mb.registerAgent({
      agentId: 'actor-a@s', sessionId: 's', name: 'A', role: 'worker', pid: 1,
    });
    await mb.registerAgent({
      agentId: 'actor-b@s', sessionId: 's', name: 'B', role: 'worker', pid: 2,
    });
    const msg = await mb.send({
      from: 'leader@s', to: '*', type: 'broadcast', subject: 'fan-out', body: 'b',
    });
    await mb.ack({
      messageId: msg.id, readerId: 'actor-a@s', read: true, completed: true,
    });

    const result = await mb.autoCompact({
      defaultTtlMs: 86_400_000,
      completedMaxAgeMs: -1,
      incompleteMaxAgeMs: 86_400_000,
    });

    expect(result.stalePurged).toBe(0);
    expect((await mb.query({ limit: 100 })).map((message) => message.id)).toContain(msg.id);
  });

  it('v2 receipts survive after autoCompact rewrite', async () => {
    const msg1 = await mb.send({
      from: 'a', to: 'b', type: 'note', subject: 'm1', body: 'b',
    });
    const msg2 = await mb.send({
      from: 'a', to: 'b', type: 'note', subject: 'm2', body: 'b',
    });
    // Ack both — creates v2 receipts
    await mb.ack({ messageId: msg1.id, readerId: 'b', read: true, completed: true });
    await mb.ack({ messageId: msg2.id, readerId: 'b', read: true });

    // Run compaction with a large TTL so messages are not removed by expiry
    await mb.autoCompact({ defaultTtlMs: 86400_000 });

    // Read raw file — should contain v2 receipt lines
    const raw = await fs.readFile(mb.messagePath, 'utf8');
    const hasV2Receipts = raw.includes('__mailboxReceipt');
    expect(hasV2Receipts).toBe(true);

    // The sentinel should also be present
    expect(raw).toContain('__mailboxVersion');
  });

  it('read-by-all compaction keeps v2 receipts for surviving messages', async () => {
    await mb.registerAgent({
      agentId: 'ag1', sessionId: 's', name: 'A', role: 'r', pid: 1,
    });
    const oldTime = new Date(Date.now() - 300_000).toISOString();
    const nowTime = new Date().toISOString();

    // Seed a message that will be kept (recent) and one that will be removed (old, read-by-all)
    await fs.writeFile(mb.messagePath, [
      JSON.stringify({
        id: 'keep-me', from: 'a', to: 'ag1', type: 'note',
        subject: 'keep', body: 'b', priority: 'normal' as const,
        readBy: { ag1: oldTime }, completed: false, timestamp: nowTime,
      }),
      JSON.stringify({
        id: 'purge-me', from: 'a', to: 'ag1', type: 'note',
        subject: 'purge', body: 'b', priority: 'normal' as const,
        readBy: { ag1: oldTime }, completed: false, timestamp: oldTime,
      }),
    ].join('\n') + '\n');
    await mb.close();

    // Re-open, then ack 'keep-me' (creates v2 receipt for kept message)
    const mb2 = new GlobalMailbox(dir, events as never as EventBus);
    const msgs = await mb2.query({ limit: 100 });
    const keepMsg = msgs.find((m) => m.subject === 'keep')!;
    await mb2.ack({ messageId: keepMsg.id, readerId: 'ag1', read: true, completed: true });

    // Compact with very short read-max-age to trigger removal of 'purge-me'
    const result = await mb2.autoCompact({ readMaxAgeMs: 60_000, defaultTtlMs: 86400_000 });
    expect(result.totalRemoved).toBeGreaterThanOrEqual(1);
    await mb2.close();

    // Verify v2 receipt for 'keep-me' survived
    const rawFinal = await fs.readFile(mb.messagePath, 'utf8');
    const lines = rawFinal.split('\n').filter((l) => l.includes('__mailboxReceipt'));
    // At least one v2 receipt should remain (for keep-me)
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GlobalMailbox purgeStale preserves v2 receipts', () => {
  it('keeps actor-reopened work on the incomplete retention path', async () => {
    const oldTime = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await fs.writeFile(mb.messagePath, [
      JSON.stringify({
        id: 'reopened', from: 'a', to: 'b', type: 'ask',
        subject: 'work', body: 'b', priority: 'normal',
        readBy: { b: oldTime }, completed: true, completedBy: 'b',
        completedAt: oldTime, timestamp: oldTime,
      }),
      JSON.stringify(buildReceiptRecordV2('reopened', 'b', oldTime, { completed: true })),
      JSON.stringify(buildReceiptRecordV2('reopened', 'b', oldTime, { completed: false })),
      MAILBOX_VERSION_SENTINEL,
    ].join('\n') + '\n');
    await mb.close();

    const result = await mb.purgeStale({
      completedMaxAgeMs: 86_400_000,
      incompleteMaxAgeMs: 7 * 86_400_000,
    });
    expect(result.totalPurged).toBe(0);
    expect(await fs.readFile(mb.messagePath, 'utf8')).toContain('reopened');
  });

  it('retains a v2 broadcast until every intended recipient completes it', async () => {
    await mb.registerAgent({
      agentId: 'actor-a@s', sessionId: 's', name: 'A', role: 'worker', pid: 1,
    });
    await mb.registerAgent({
      agentId: 'actor-b@s', sessionId: 's', name: 'B', role: 'worker', pid: 2,
    });
    const msg = await mb.send({
      from: 'leader@s', to: '*', type: 'broadcast', subject: 'fan-out', body: 'b',
    });
    await mb.ack({
      messageId: msg.id, readerId: 'actor-a@s', read: true, completed: true,
    });

    const result = await mb.purgeStale({
      completedMaxAgeMs: -1,
      incompleteMaxAgeMs: 86_400_000,
    });

    expect(result.completedPurged).toBe(0);
    expect((await mb.query({ limit: 100 })).map((message) => message.id)).toContain(msg.id);
  });

  it('v2 receipts survive after purge rewrite', async () => {
    const now = Date.now();
    const oldTime = new Date(now - 10 * 86400_000).toISOString();
    const recentTime = new Date(now).toISOString();

    await fs.writeFile(mb.messagePath, [
      JSON.stringify({
        id: 'old-done', from: 'a', to: 'b', type: 'note',
        subject: 'old', body: 'b', priority: 'normal' as const,
        readBy: {}, completed: true, completedAt: oldTime,
        completedBy: 'b', timestamp: oldTime,
      }),
      JSON.stringify({
        id: 'keep-me', from: 'a', to: 'b', type: 'note',
        subject: 'keep', body: 'b', priority: 'normal' as const,
        readBy: {}, completed: false, timestamp: recentTime,
      }),
    ].join('\n') + '\n');
    await mb.close();

    // Re-open, ack keep-me to create v2 receipt
    const mb2 = new GlobalMailbox(dir, events as never as EventBus);
    const msgs = await mb2.query({ limit: 100 });
    const keepMsg = msgs.find((m) => m.subject === 'keep')!;
    await mb2.ack({ messageId: keepMsg.id, readerId: 'b', read: true });

    // Purge: old-done is completed >1 day ago, gets removed; keep-me stays
    await mb2.purgeStale();
    await mb2.close();

    const raw = await fs.readFile(mb.messagePath, 'utf8');
    const hasV2Receipt = raw.includes('__mailboxReceipt');
    expect(hasV2Receipt).toBe(true);
    expect(raw).toContain('keep-me');
    expect(raw).not.toContain('old-done');
  });

  it('two actors on a broadcast get independent outcomes and no-op detection', async () => {
    // Regression: actor A sets outcome "fixed" and actor B sets outcome
    // "wontfix" on the same broadcast. Each actor's no-op detection must
    // compare against its OWN recipientState outcome, not the message-global
    // or the other actor's outcome.
    const msg = await mb.send({
      from: 'a', to: '*', type: 'broadcast', subject: 'bug', body: 'crash on startup',
    });

    // Actor A completes with outcome "fixed"
    await mb.ack({
      messageId: msg.id, readerId: 'worker-a@sess-1', read: true, completed: true, outcome: 'fixed',
    });

    // Actor B completes with outcome "wontfix"
    await mb.ack({
      messageId: msg.id, readerId: 'worker-b@sess-2', read: true, completed: true, outcome: 'wontfix',
    });

    // Assert each actor has independent state in the projection
    const raw = await fs.readFile(mb.messagePath, 'utf8');
    const projections = parseMailboxFile(raw);
    const proj = projections.find((p) => p.id === msg.id);
    expect(proj).toBeDefined();
    expect(proj!.recipientState?.['worker-a@sess-1']?.outcome).toBe('fixed');
    expect(proj!.recipientState?.['worker-b@sess-2']?.outcome).toBe('wontfix');

    // Actor A re-acks the same outcome "fixed" — must be a no-op (no new receipt)
    const receiptsBefore = (raw.match(/__mailboxReceipt/g) ?? []).length;
    await mb.ack({
      messageId: msg.id, readerId: 'worker-a@sess-1', outcome: 'fixed',
    });
    const rawAfter = await fs.readFile(mb.messagePath, 'utf8');
    const receiptsAfter = (rawAfter.match(/__mailboxReceipt/g) ?? []).length;
    expect(receiptsAfter).toBe(receiptsBefore);

    // Actor A changes outcome to "needs-review" — must NOT be a no-op
    await mb.ack({
      messageId: msg.id, readerId: 'worker-a@sess-1', outcome: 'needs-review',
    });
    const rawFinal = await fs.readFile(mb.messagePath, 'utf8');
    const projectionsFinal = parseMailboxFile(rawFinal);
    const projFinal = projectionsFinal.find((p) => p.id === msg.id);
    expect(projFinal!.recipientState?.['worker-a@sess-1']?.outcome).toBe('needs-review');
    // Actor B's outcome is unchanged
    expect(projFinal!.recipientState?.['worker-b@sess-2']?.outcome).toBe('wontfix');
  });
});

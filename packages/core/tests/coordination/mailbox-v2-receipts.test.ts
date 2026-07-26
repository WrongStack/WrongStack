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
import type { MailboxMessage } from '../../src/coordination/mailbox-types.js';
import {
  buildReceiptRecordV2,
  extractV2Receipts,
  materializeMessages,
  serializeReceiptRecordV2,
} from '../../src/coordination/mailbox-receipt-folding.js';
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
import { parseMailboxLine } from '../../src/coordination/mailbox-message-codec.js';

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

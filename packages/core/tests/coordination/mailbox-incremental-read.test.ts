/**
 * MailboxMessageCache incremental tail read.
 *
 * The contract under test is equivalence: folding an appended chunk onto the
 * cached state must produce exactly what re-parsing the whole file would.
 * Every case also asserts WHICH path ran, via array identity — the incremental
 * path mutates the cached projections array in place, a full re-read replaces
 * it. Without that check a silently-disabled fast path would still pass.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MailboxMessageCache } from '../../src/coordination/mailbox-message-cache.js';
import { parseMailboxFile } from '../../src/coordination/mailbox-parse-state.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-mailbox-inc-'));
  file = path.join(dir, '_mailbox.jsonl');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function messageLine(id: string, to = 'agent@sess-1', extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    id,
    from: 'sender@sess-9',
    to,
    type: 'note',
    subject: `subject-${id}`,
    body: `body-${id}`,
    priority: 'normal',
    readBy: {},
    completed: false,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...extra,
  })}\n`;
}

function receiptLine(messageId: string, actorId: string, extra: Record<string, unknown>): string {
  return `${JSON.stringify({
    __mailboxReceipt: 2,
    messageId,
    actorId,
    timestamp: '2026-01-02T00:00:00.000Z',
    ...extra,
  })}\n`;
}

function ackLine(messageId: string, readerId: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    __ack: true,
    messageId,
    readerId,
    timestamp: '2026-01-02T00:00:00.000Z',
    ...extra,
  })}\n`;
}

/** Assert the cache agrees with a cold whole-file parse. */
async function expectMatchesFullParse(actual: unknown): Promise<void> {
  expect(actual).toEqual(parseMailboxFile(await fs.readFile(file, 'utf8')));
}

describe('MailboxMessageCache incremental tail read', () => {
  it('serves an unchanged file from memory', async () => {
    await fs.writeFile(file, messageLine('m1') + messageLine('m2'));
    const cache = new MailboxMessageCache();
    const first = await cache.readCached(file);
    const second = await cache.readCached(file);

    expect(second).toBe(first);
    expect(first).toHaveLength(2);
    await expectMatchesFullParse(first);
  });

  it('folds appended messages without re-parsing the prefix', async () => {
    await fs.writeFile(file, messageLine('m1'));
    const cache = new MailboxMessageCache();
    const first = await cache.readCached(file);
    const firstProjection = first[0];

    await fs.appendFile(file, messageLine('m2') + messageLine('m3'));
    const second = await cache.readCached(file);

    // Same array instance + same untouched element instance == the prefix was
    // never re-parsed. A full re-read would replace both.
    expect(second).toBe(first);
    expect(second[0]).toBe(firstProjection);
    expect(second.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    await expectMatchesFullParse(second);
  });

  it('re-folds an earlier message when a receipt for it is appended', async () => {
    await fs.writeFile(file, messageLine('m1') + messageLine('m2'));
    const cache = new MailboxMessageCache();
    const first = await cache.readCached(file);
    expect(first[0]?.recipientState['agent@sess-1']).toBeUndefined();

    await fs.appendFile(file, receiptLine('m1', 'agent@sess-1', { read: true, completed: true }));
    const second = await cache.readCached(file);

    expect(second).toBe(first);
    expect(second[0]?.recipientState['agent@sess-1']?.completedAt).toBe('2026-01-02T00:00:00.000Z');
    // The untouched sibling must not be disturbed by a neighbour's re-fold.
    expect(second[1]?.recipientState).toEqual({});
    await expectMatchesFullParse(second);
  });

  it('applies an appended v1 ack to the message already in cache', async () => {
    await fs.writeFile(file, messageLine('m1', 'agent@sess-1'));
    const cache = new MailboxMessageCache();
    const first = await cache.readCached(file);

    await fs.appendFile(file, ackLine('m1', 'agent@sess-1', { completed: true }));
    const second = await cache.readCached(file);

    expect(second).toBe(first);
    expect(second[0]?.completed).toBe(true);
    await expectMatchesFullParse(second);
  });

  it('resolves an ack against a message appended in the same chunk', async () => {
    await fs.writeFile(file, messageLine('m1'));
    const cache = new MailboxMessageCache();
    await cache.readCached(file);

    await fs.appendFile(
      file,
      messageLine('m2', 'agent@sess-1') + ackLine('m2', 'agent@sess-1', { completed: true }),
    );
    const second = await cache.readCached(file);

    expect(second[1]?.id).toBe('m2');
    expect(second[1]?.completed).toBe(true);
    await expectMatchesFullParse(second);
  });

  it('defers a partially written trailing line until it is complete', async () => {
    await fs.writeFile(file, messageLine('m1'));
    const cache = new MailboxMessageCache();
    const first = await cache.readCached(file);

    // A concurrent writer mid-append: bytes present, no terminating newline.
    const partial = messageLine('m2');
    await fs.appendFile(file, partial.slice(0, partial.length - 5));
    const midWrite = await cache.readCached(file);
    expect(midWrite.map((m) => m.id)).toEqual(['m1']);

    // Writer finishes the record; the deferred bytes are picked up from the
    // right offset rather than dropped or double-counted.
    await fs.appendFile(file, partial.slice(partial.length - 5));
    const complete = await cache.readCached(file);

    expect(complete).toBe(first);
    expect(complete.map((m) => m.id)).toEqual(['m1', 'm2']);
    await expectMatchesFullParse(complete);
  });

  it('falls back to a full read when the file is rewritten to a larger size', async () => {
    await fs.writeFile(file, messageLine('m1') + messageLine('m2'));
    const cache = new MailboxMessageCache();
    const first = await cache.readCached(file);

    // Compaction: same path, different bytes, and deliberately LARGER so the
    // size check alone would wave it through as an append.
    await fs.writeFile(
      file,
      messageLine('kept-1', 'agent@sess-1', { body: 'x'.repeat(400) }) + messageLine('kept-2'),
    );
    const second = await cache.readCached(file);

    expect(second).not.toBe(first);
    expect(second.map((m) => m.id)).toEqual(['kept-1', 'kept-2']);
    await expectMatchesFullParse(second);
  });

  it('falls back to a full read when the file shrinks', async () => {
    await fs.writeFile(file, messageLine('m1') + messageLine('m2') + messageLine('m3'));
    const cache = new MailboxMessageCache();
    const first = await cache.readCached(file);

    await fs.writeFile(file, messageLine('m1'));
    const second = await cache.readCached(file);

    expect(second).not.toBe(first);
    expect(second.map((m) => m.id)).toEqual(['m1']);
    await expectMatchesFullParse(second);
  });

  it('skips malformed appended lines with the same tolerance as a full parse', async () => {
    await fs.writeFile(file, messageLine('m1'));
    const cache = new MailboxMessageCache();
    await cache.readCached(file);

    await fs.appendFile(file, 'not-json\n{}\n' + messageLine('m2'));
    const second = await cache.readCached(file);

    await expectMatchesFullParse(second);
    expect(second.map((m) => m.id)).toContain('m2');
  });

  it('treats a missing file as empty and recovers once it appears', async () => {
    const cache = new MailboxMessageCache();
    expect(await cache.readCached(file)).toEqual([]);

    await fs.writeFile(file, messageLine('m1'));
    const second = await cache.readCached(file);
    expect(second.map((m) => m.id)).toEqual(['m1']);
    await expectMatchesFullParse(second);
  });

  it('keeps concurrent reads from double-folding the same appended bytes', async () => {
    await fs.writeFile(file, messageLine('m1'));
    const cache = new MailboxMessageCache();
    await cache.readCached(file);

    await fs.appendFile(file, messageLine('m2'));
    const [a, b, c] = await Promise.all([
      cache.readCached(file),
      cache.readCached(file),
      cache.readCached(file),
    ]);

    expect(a.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    await expectMatchesFullParse(a);
  });
});

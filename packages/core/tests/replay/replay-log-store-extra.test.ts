import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayLogStore } from '../../src/index.js';

// Covers list() (flat + sharded scan, skips, readdir errors), the readAll
// envelope form, and the record/lookup/load error emit paths that the main
// replay.test.ts does not reach.

let dir: string;
let store: ReplayLogStore;

const ENTRY = (hash: string) =>
  JSON.stringify({
    hash,
    ts: '2026-01-01T00:00:00.000Z',
    request: { model: 'm', messages: [], maxTokens: 1 },
    response: { content: [], stopReason: 'end_turn', usage: { input: 0, output: 0 }, model: 'm' },
  }) + '\n';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-log-extra-'));
  store = new ReplayLogStore({ dir });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ReplayLogStore.list', () => {
  it('lists flat and date-sharded sessions, sorted, with entry counts', async () => {
    await fs.writeFile(
      path.join(dir, 'flat.replay.jsonl'),
      ENTRY('sha256:a1') + ENTRY('sha256:a2'),
      'utf8',
    );
    await fs.mkdir(path.join(dir, '2026-06-11'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '2026-06-11', 'base.replay.jsonl'),
      ENTRY('sha256:b1'),
      'utf8',
    );
    await fs.writeFile(path.join(dir, '.hidden.replay.jsonl'), ENTRY('sha256:c1'), 'utf8');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'ignore me', 'utf8');

    const listed = await store.list();
    expect(listed.map((e) => e.sessionId)).toEqual(['2026-06-11/base', 'flat']);
    const flat = listed.find((e) => e.sessionId === 'flat');
    expect(flat?.entryCount).toBe(2);
    expect(flat?.path.endsWith('flat.replay.jsonl')).toBe(true);
  });

  it('counts non-empty JSONL rows without parsing replay payloads', async () => {
    await fs.writeFile(
      path.join(dir, 'big.replay.jsonl'),
      `${ENTRY('sha256:a1')}\n   \n${ENTRY('sha256:a2').trimEnd()}`,
      'utf8',
    );
    const parseSpy = vi.spyOn(JSON, 'parse');

    const listed = await store.list();

    expect(listed).toEqual([
      { sessionId: 'big', entryCount: 2, path: path.join(dir, 'big.replay.jsonl') },
    ]);
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('returns [] when the store directory does not exist (ENOENT)', async () => {
    const missing = new ReplayLogStore({ dir: path.join(dir, 'nope') });
    expect(await missing.list()).toEqual([]);
  });

  it('warns and returns [] when the store dir is unreadable (non-ENOENT)', async () => {
    const filePath = path.join(dir, 'a-file');
    await fs.writeFile(filePath, 'not a dir', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = new ReplayLogStore({ dir: filePath });
    expect(await bad.list()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('ReplayLogStore — readAll envelope + error emits', () => {
  it('reads the forward-compat {version, entry} envelope form', async () => {
    const envelope =
      JSON.stringify({
        version: 1,
        entry: {
          hash: 'sha256:env',
          ts: '2026-01-01T00:00:00.000Z',
          request: { model: 'm', messages: [], maxTokens: 1 },
          response: {
            content: [],
            stopReason: 'end_turn',
            usage: { input: 0, output: 0 },
            model: 'm',
          },
        },
      }) + '\n';
    await fs.writeFile(path.join(dir, 'env.replay.jsonl'), envelope, 'utf8');
    const entries = await store.load('env');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hash).toBe('sha256:env');
  });

  it('emits storage.error and rethrows when load hits a non-ENOENT I/O error', async () => {
    const events = { emit: vi.fn() };
    const s = new ReplayLogStore({ dir, events: events as never, traceId: 'tr-1' });
    await fs.mkdir(path.join(dir, 'bad.replay.jsonl'), { recursive: true });
    await expect(s.load('bad')).rejects.toBeDefined();
    const err = events.emit.mock.calls.find(
      (c) => c[0] === 'storage.read' && (c[1] as { outcome?: string }).outcome === 'failure',
    );
    expect(err).toBeDefined();
    expect((err![1] as { traceId?: string }).traceId).toBe('tr-1');
  });

  it('emits storage.error and rethrows when lookup hits a non-ENOENT I/O error', async () => {
    const events = { emit: vi.fn() };
    const s = new ReplayLogStore({ dir, events: events as never });
    await fs.mkdir(path.join(dir, 'bad2.replay.jsonl'), { recursive: true });
    await expect(s.lookup('bad2', 'sha256:x')).rejects.toBeDefined();
    expect(events.emit.mock.calls.some((c) => c[0] === 'storage.read')).toBe(true);
  });

  it('emits storage.error and rethrows when record hits a non-ENOENT I/O error', async () => {
    const events = { emit: vi.fn() };
    const s = new ReplayLogStore({ dir, events: events as never });
    await fs.mkdir(path.join(dir, 'bad3.replay.jsonl'), { recursive: true });
    await expect(
      s.record({
        sessionId: 'bad3',
        request: { model: 'm', messages: [], maxTokens: 1 } as never,
        response: {
          content: [],
          stopReason: 'end_turn',
          usage: { input: 0, output: 0 },
          model: 'm',
        } as never,
      }),
    ).rejects.toBeDefined();
    expect(events.emit.mock.calls.some((c) => c[0] === 'storage.error')).toBe(true);
  });

  it('self-heals a stale byte offset after the file is compacted by another writer', async () => {
    const mk = (text: string) => ({
      sessionId: 'stale',
      request: {
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        maxTokens: 1,
      } as never,
      response: {
        content: [{ type: 'text', text: `r-${text}` }],
        stopReason: 'end_turn',
        usage: { input: 0, output: 0 },
        model: 'm',
      } as never,
    });
    const s1 = new ReplayLogStore({ dir });
    const hashA = await s1.record(mk('AAA'));
    const hashB = await s1.record(mk('BBB'));

    // A second reader caches offsets for A and B, then hydrates only A —
    // leaving B's offset cached but its entry not yet loaded.
    const s2 = new ReplayLogStore({ dir });
    expect((await s2.lookup('stale', hashA))?.hash).toBe(hashA);

    // Another writer compacts the file, dropping A, so B moves to offset 0
    // while s2 still holds B's old (post-A) offset.
    const listed = await s2.list();
    const fp = listed.find((r) => r.sessionId === 'stale')?.path ?? '';
    const lines = (await fs.readFile(fp, 'utf8')).split('\n').filter((l) => l.trim());
    await fs.writeFile(fp, `${lines.slice(1).join('\n')}\n`, 'utf8');

    // With the stale offset a naive read returns wrong bytes (or a different
    // valid line); self-heal must rebuild the cache and return the real B.
    const got = await s2.lookup('stale', hashB);
    expect(got?.hash).toBe(hashB);
  });

  it('evicts the oldest entries once maxEntries is exceeded (compact path)', async () => {
    const s = new ReplayLogStore({ dir, maxEntries: 2 });
    for (let i = 0; i < 4; i++) {
      await s.record({
        sessionId: 'cap',
        request: {
          model: 'm',
          messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }],
          maxTokens: 1,
        } as never,
        response: {
          content: [],
          stopReason: 'end_turn',
          usage: { input: 0, output: 0 },
          model: 'm',
        } as never,
      });
    }
    const entries = await s.load('cap');
    expect(entries).toHaveLength(2);
  });
});

describe('ReplayLogStore — chunked scan across a 64KiB UTF-8 boundary', () => {
  // ensureCache reads the JSONL in 64KiB chunks; decoding each chunk in
  // isolation turned a multi-byte character split at the boundary into
  // U+FFFD, inflating that line's cached byte length and drifting every
  // later line's cached offset — lookup() then threw "unreadable" on an
  // intact file for the straddling entry and everything after it.
  const CHUNK = 64 * 1024;
  const DASH_START = CHUNK - 2; // 3-byte em-dash spans the boundary

  const line = (hash: string, text: string) =>
    JSON.stringify({
      hash,
      ts: '2026-01-01T00:00:00.000Z',
      request: { model: 'm', messages: [{ role: 'user', content: `req ${text}` }], maxTokens: 1 },
      response: {
        content: [{ type: 'text', text: `res ${text}` }],
        stopReason: 'end_turn',
        usage: { input: 0, output: 0 },
        model: 'm',
      },
    }) + '\n';

  function straddlingLine(hash: string, lineStartByte: number): string {
    let pad = CHUNK;
    for (let i = 0; i < 8; i++) {
      const text = 'x'.repeat(pad) + '—straddle';
      const candidate = line(hash, text);
      const dashGlobal = lineStartByte + Buffer.byteLength(candidate.split('—')[0] ?? '', 'utf8');
      const diff = DASH_START - dashGlobal;
      if (diff === 0) return candidate;
      pad += diff; // 'x' is one byte, so the byte gap maps 1:1 onto the pad
    }
    throw new Error('could not align the em-dash on the chunk boundary');
  }

  it('keeps entries lookable when a multi-byte character straddles the chunk boundary', async () => {
    const control = line('sha256:c0', 'plain ascii control');
    const straddle = straddlingLine('sha256:c1', Buffer.byteLength(control, 'utf8'));
    const afterAscii = line('sha256:c2', 'plain ascii after the boundary');
    const afterUtf8 = line('sha256:c3', 'boundary-far em-dash — and CJK 文字');
    const body = control + straddle + afterAscii + afterUtf8;
    const fp = path.join(dir, 'straddle.replay.jsonl');
    await fs.writeFile(fp, body, 'utf8');

    // Fixture sanity: the em-dash's first byte sits at the global file offset
    // that the store's 64KiB chunking splits mid-character.
    expect(Buffer.byteLength(body.split('—')[0] ?? '', 'utf8')).toBe(DASH_START);

    const before = JSON.stringify(await store.lookup('straddle', 'sha256:c0'));
    expect(before).toContain('plain ascii control');
    expect(before).not.toContain('\uFFFD');

    const straddleText = JSON.stringify(await store.lookup('straddle', 'sha256:c1'));
    expect(straddleText).toContain('—straddle');
    expect(straddleText).not.toContain('\uFFFD');

    const afterText = JSON.stringify(await store.lookup('straddle', 'sha256:c2'));
    expect(afterText).toContain('after the boundary');
    expect(afterText).not.toContain('\uFFFD');

    const utf8Text = JSON.stringify(await store.lookup('straddle', 'sha256:c3'));
    expect(utf8Text).toContain('文字');
    expect(utf8Text).toContain('—');
    expect(utf8Text).not.toContain('\uFFFD');

    expect(await store.lookup('straddle', 'sha256:missing')).toBeNull();
  });

  it('recovers from an unterminated trailing line when appending and supports Request objects in lookup (F967)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-replay-f967-'));
    try {
      const store1 = new ReplayLogStore({ dir });
      const req1 = { model: 'm1', messages: [{ role: 'user', content: 'hi' }] } as never;
      const req2 = { model: 'm2', messages: [{ role: 'user', content: 'bye' }] } as never;
      const resp1 = { content: 'first' } as never;
      const resp2 = { content: 'second' } as never;
      await store1.record({ sessionId: 'sess1', request: req1, response: resp1 });

      const files = await fs.readdir(dir, { recursive: true });
      const relReplay = files.find((f) => String(f).endsWith('.replay.jsonl'));
      const replayFile = path.join(dir, String(relReplay));
      const rawContent = await fs.readFile(replayFile, 'utf8');
      await fs.writeFile(replayFile, rawContent.trimEnd(), 'utf8');

      const store2 = new ReplayLogStore({ dir });
      await store2.record({ sessionId: 'sess1', request: req2, response: resp2 });

      const entries = await new ReplayLogStore({ dir }).load('sess1');
      expect(entries).toHaveLength(2);
      const lookedUp = await store1.lookup('sess1', req2);
      expect(lookedUp).not.toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

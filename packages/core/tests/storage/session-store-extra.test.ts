import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultSecretScrubber, DefaultSessionStore } from '../../src/index.js';
import type { SessionEvent } from '../../src/types/session.js';

let tmp: string;
let store: DefaultSessionStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sess-extra-'));
  store = new DefaultSessionStore({ dir: tmp });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

const now = () => new Date().toISOString();

describe('FileSessionWriter — transcriptPath / file snapshots / checkpoints', () => {
  it('exposes the transcript path', async () => {
    const w = await store.create({ id: 'tp', model: 'm', provider: 'p' });
    expect(w.transcriptPath).toBe(path.join(tmp, 'tp.jsonl'));
    await w.close();
  });

  it('records pending file changes and flushes them on writeCheckpoint', async () => {
    const w = await store.create({ id: 'fc', model: 'm', provider: 'p' });
    w.recordFileChange({ path: 'a.ts', action: 'modified', before: 'x', after: 'y' });
    w.recordFileChange({ path: 'b.ts', action: 'created', before: null, after: 'new' });
    await w.writeCheckpoint(0, 'preview text');
    await w.close();
    const raw = await fs.readFile(path.join(tmp, 'fc.jsonl'), 'utf8');
    const types = raw.trim().split('\n').map((l) => JSON.parse(l).type);
    expect(types).toContain('file_snapshot');
    expect(types).toContain('checkpoint');
  });

  it('writeFileSnapshot appends a file_snapshot event directly', async () => {
    const w = await store.create({ id: 'fs', model: 'm', provider: 'p' });
    await w.writeFileSnapshot(1, [{ path: 'z.ts', action: 'deleted', before: 'old', after: null }]);
    await w.close();
    const data = await store.load('fs');
    expect(data.events.some((e) => e.type === 'file_snapshot')).toBe(true);
  });
});

describe('FileSessionWriter — appendBatch', () => {
  it('is a no-op for an empty batch', async () => {
    const w = await store.create({ id: 'ab0', model: 'm', provider: 'p' });
    await w.appendBatch([]);
    await w.close();
    const data = await store.load('ab0');
    // Only the session_start (+ session_end on close) — no batch events.
    expect(data.events.filter((e) => e.type === 'user_input')).toHaveLength(0);
  });

  it('buffers a small batch and flushes immediately past FLUSH_SIZE', async () => {
    const w = await store.create({ id: 'ab1', model: 'm', provider: 'p' });
    const many: SessionEvent[] = Array.from({ length: 55 }, (_, i) => ({
      type: 'user_input',
      ts: now(),
      content: `msg-${i}`,
    }));
    await w.appendBatch(many);
    await w.close();
    const data = await store.load('ab1');
    expect(data.events.filter((e) => e.type === 'user_input')).toHaveLength(55);
  });

  it('ignores appendBatch after close()', async () => {
    const w = await store.create({ id: 'ab2', model: 'm', provider: 'p' });
    await w.close();
    await w.appendBatch([{ type: 'user_input', ts: now(), content: 'late' }]);
    const data = await store.load('ab2');
    expect(data.events.some((e) => e.type === 'user_input')).toBe(false);
  });
});

describe('FileSessionWriter — truncateToCheckpoint / clearSession / in-flight', () => {
  it('truncates events after a checkpoint and records a rewound marker', async () => {
    const w = await store.create({ id: 'tc', model: 'm', provider: 'p' });
    await w.writeCheckpoint(0, 'first');
    await w.append({ type: 'user_input', ts: now(), content: 'kept', promptIndex: 0 } as SessionEvent);
    await w.writeCheckpoint(1, 'second');
    await w.append({ type: 'user_input', ts: now(), content: 'dropped', promptIndex: 1 } as SessionEvent);
    const removed = await w.truncateToCheckpoint(0);
    expect(removed).toBeGreaterThan(0);
    await w.close();
    const data = await store.load('tc');
    expect(data.events.some((e) => e.type === 'rewound')).toBe(true);
  });

  it('clearSession rewrites the file to a single session_start', async () => {
    const w = await store.create({ id: 'cl', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'before clear' });
    await w.clearSession();
    await w.close();
    const data = await store.load('cl');
    expect(data.events.some((e) => e.type === 'user_input')).toBe(false);
  });

  it('rejects an out-of-range in-flight context', async () => {
    const w = await store.create({ id: 'if', model: 'm', provider: 'p' });
    await expect(w.writeInFlightMarker('')).rejects.toThrow(/1\.\.500/);
    await expect(w.writeInFlightMarker('x'.repeat(501))).rejects.toThrow(/1\.\.500/);
    await w.writeInFlightMarker('valid context');
    await w.clearInFlightMarker('clean');
    await w.close();
  });

  it('derives the summary title from array text content', async () => {
    const w = await store.create({ id: 'title', model: 'm', provider: 'p' });
    await w.append({
      type: 'user_input',
      ts: now(),
      content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }],
    } as SessionEvent);
    await w.close();
    const summaries = await store.list();
    const entry = summaries.find((s) => s.id === 'title');
    expect(entry?.title).toContain('hello');
  });
});

describe('DefaultSessionStore — best-effort cleanup paths', () => {
  it('clearHistory swallows a missing summary sidecar', async () => {
    // Raw session with no .summary.json → clearHistory's unlink hits ENOENT.
    await writeRawSession(tmp, 'noidx', [{ type: 'session_start', ts: now(), id: 'noidx', model: 'm', provider: 'p' }]);
    await expect(store.clearHistory('noidx')).resolves.toBeUndefined();
    const raw = await fs.readFile(path.join(tmp, 'noidx.jsonl'), 'utf8');
    expect(raw).toContain('session_start');
  });

  it('prune removes an aged session and cleans up its empty date shard', async () => {
    const shard = path.join(tmp, '2020-01-01');
    await fs.mkdir(shard, { recursive: true });
    await writeRawSession(shard, '00-00-00Z_old', [
      { type: 'session_start', ts: '2020-01-01T00:00:00.000Z', id: '2020-01-01/00-00-00Z_old', model: 'm', provider: 'p' },
    ]);
    // Backdate the mtime well past the prune cutoff.
    const old = new Date('2020-01-01T00:00:00.000Z');
    await fs.utimes(path.join(shard, '00-00-00Z_old.jsonl'), old, old);
    const deleted = await store.prune(30);
    expect(deleted).toBeGreaterThanOrEqual(1);
    // The now-empty date shard directory is removed.
    await expect(fs.stat(shard)).rejects.toBeDefined();
  });
});

describe('DefaultSessionStore — error paths', () => {
  it('surfaces a create failure when the file handle cannot be opened', async () => {
    // A 300-char basename exceeds NAME_MAX (255) on Linux and the path limit on
    // Windows → fsp.open() throws, exercising the emitError + rethrow path.
    const longId = 'x'.repeat(300);
    await expect(store.create({ id: longId, model: 'm', provider: 'p' })).rejects.toThrow(/Failed to open session file/);
  });

  it('load() rejects for a missing session', async () => {
    await expect(store.load('does-not-exist')).rejects.toBeDefined();
  });

  it('resume() rejects for a missing session', async () => {
    await expect(store.resume('also-missing')).rejects.toBeDefined();
  });
});

describe('DefaultSessionStore — rebuildIndex / summary fallback / shard scan', () => {
  it('rebuilds the index from sessions on disk', async () => {
    for (const id of ['r1', 'r2']) {
      const w = await store.create({ id, model: 'm', provider: 'p' });
      await w.append({ type: 'user_input', ts: now(), content: id });
      await w.close();
    }
    const count = await store.rebuildIndex();
    expect(count).toBeGreaterThanOrEqual(2);
    const idx = await fs.readFile(path.join(tmp, '_index.jsonl'), 'utf8');
    expect(idx).toContain('r1');
    expect(idx).toContain('r2');
  });

  it('caches parsed index entries until the index file changes', async () => {
    for (const id of ['cache-a', 'cache-b']) {
      const w = await store.create({ id, model: 'm', provider: 'p' });
      await w.append({ type: 'user_input', ts: now(), content: id });
      await w.close();
    }

    const first = await store.list();
    const cacheAfterFirst = (store as { _indexCache: { summaries: unknown[] } | null })._indexCache;
    expect(cacheAfterFirst?.summaries.length).toBeGreaterThanOrEqual(2);

    const second = await store.list();
    const cacheAfterSecond = (store as { _indexCache: { summaries: unknown[] } | null })._indexCache;
    expect(cacheAfterSecond).toBe(cacheAfterFirst);
    expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));

    await fs.appendFile(
      path.join(tmp, '_index.jsonl'),
      `${JSON.stringify({ id: 'cache-c', title: 'cache-c', startedAt: new Date(Date.now() + 1_000).toISOString(), model: 'm', provider: 'p', tokenTotal: 0 })}\n`,
      'utf8',
    );

    const third = await store.list();
    const cacheAfterThird = (store as { _indexCache: { summaries: unknown[] } | null })._indexCache;
    expect(cacheAfterThird).not.toBe(cacheAfterFirst);
    expect(third.some((s) => s.id === 'cache-c')).toBe(true);
  });

  it('rebuilds a missing summary sidecar during list()', async () => {
    const w = await store.create({ id: 'nosum', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'sidecar gone' });
    await w.close();
    // Remove the summary sidecar AND the index so list() must rebuild via summaryFor().
    await fs.rm(path.join(tmp, 'nosum.summary.json'), { force: true });
    await fs.rm(path.join(tmp, '_index.jsonl'), { force: true });
    const summaries = await store.list();
    expect(summaries.some((s) => s.id === 'nosum')).toBe(true);
    // The fallback wrote the manifest back.
    const rebuilt = await fs.readFile(path.join(tmp, 'nosum.summary.json'), 'utf8');
    expect(rebuilt).toContain('nosum');
  });

  it('collects date-sharded ids and skips non-session directories', async () => {
    const w = await store.create({ id: '2026-01-02/aa-bb-ccZ_x1', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'sharded' });
    await w.close();
    // Directories that must be skipped during the scan.
    await fs.mkdir(path.join(tmp, 'subagents'), { recursive: true });
    await fs.mkdir(path.join(tmp, '.hidden'), { recursive: true });
    const count = await store.rebuildIndex();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('sorts indexed sessions and falls back to a directory scan', async () => {
    // Two indexed sessions with distinct start times → exercise the index sort.
    for (const id of ['s-old', 's-new']) {
      const w = await store.create({ id, model: 'm', provider: 'p' });
      await w.append({ type: 'user_input', ts: now(), content: id });
      await w.close();
    }
    const indexed = await store.list();
    expect(indexed.length).toBeGreaterThanOrEqual(2);
    // Drop the index → list() must scan the directory and sort the summaries.
    await fs.rm(path.join(tmp, '_index.jsonl'), { force: true });
    const scanned = await store.list();
    expect(scanned.length).toBeGreaterThanOrEqual(2);
  });

  it('sorts index entries by startedAt with an id tiebreak', async () => {
    // Hand-author the index with controlled timestamps: two share a startedAt
    // (→ id localeCompare tiebreak), one is newer (→ both < and > comparisons).
    // Scrambled order with two equal timestamps so the comparator hits all three
    // returns: a<b (→1), a>b (→-1), and the id-localeCompare tiebreak.
    const entries = [
      { id: 'cm', title: 't', startedAt: '2026-02-02T00:00:00.000Z', model: 'm', provider: 'p', tokenTotal: 0 },
      { id: 'ao', title: 't', startedAt: '2026-01-01T00:00:00.000Z', model: 'm', provider: 'p', tokenTotal: 0 },
      { id: 'dn', title: 't', startedAt: '2026-03-03T00:00:00.000Z', model: 'm', provider: 'p', tokenTotal: 0 },
      { id: 'bo', title: 't', startedAt: '2026-01-01T00:00:00.000Z', model: 'm', provider: 'p', tokenTotal: 0 },
    ];
    await fs.writeFile(path.join(tmp, '_index.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const out = await store.list();
    expect(out.map((s) => s.id)).toEqual(['dn', 'cm', 'ao', 'bo']); // newest first, id tiebreak on the Jan pair
  });

  it('sorts directory-scanned summaries when start times tie', async () => {
    // Two raw sessions sharing a session_start ts → fallback-scan localeCompare tie.
    const ts = '2026-03-03T00:00:00.000Z';
    for (const id of ['z-sess', 'y-sess']) {
      await writeRawSession(tmp, id, [
        { type: 'session_start', ts, id, model: 'm', provider: 'p' },
        { type: 'user_input', ts, content: id },
      ]);
    }
    const out = await store.list();
    const ids = out.filter((s) => s.id.endsWith('-sess')).map((s) => s.id);
    expect(ids).toEqual(['y-sess', 'z-sess']); // id tiebreak on equal startedAt
  });
});

/** Write a raw JSONL session file directly so we control the exact event stream. */
async function writeRawSession(dir: string, id: string, events: object[]): Promise<void> {
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(path.join(dir, `${id}.jsonl`), lines, 'utf8');
}

describe('DefaultSessionStore — summarize / replay over raw event streams', () => {
  it('counts iterations/tools/files and marks an unfinished session aborted', async () => {
    await writeRawSession(tmp, 'sm-abort', [
      { type: 'session_start', ts: now(), id: 'sm-abort', model: 'm', provider: 'p' },
      { type: 'user_input', ts: now(), content: 'go' },
      { type: 'tool_call_start', ts: now(), name: 'bash', id: 't1' },
      { type: 'tool_result', ts: now(), id: 't1', content: 'oops', isError: true },
      { type: 'file_snapshot', ts: now(), promptIndex: 0, files: [{ path: 'a', action: 'modified', before: '1', after: '2' }] },
      { type: 'in_flight_start', ts: now(), context: 'mid-op' }, // last event → aborted
    ]);
    const summaries = await store.list();
    const s = summaries.find((x) => x.id === 'sm-abort');
    expect(s?.outcome).toBe('aborted');
    expect(s?.toolErrorCount).toBe(1);
    expect(s?.fileChangeCount).toBe(1);
  });

  it('marks a session that emitted an error event as error', async () => {
    await writeRawSession(tmp, 'sm-err', [
      { type: 'session_start', ts: now(), id: 'sm-err', model: 'm', provider: 'p' },
      { type: 'user_input', ts: now(), content: 'go' },
      { type: 'error', ts: now(), message: 'boom' },
      { type: 'llm_response', ts: now(), content: [{ type: 'text', text: 'end' }], usage: { input: 1, output: 1 }, stopReason: 'end_turn' },
    ]);
    const summaries = await store.list();
    expect(summaries.find((x) => x.id === 'sm-err')?.outcome).toBe('error');
  });

  it('groups consecutive tool_result events into one user message on replay', async () => {
    await writeRawSession(tmp, 'rp', [
      { type: 'session_start', ts: now(), id: 'rp', model: 'm', provider: 'p' },
      { type: 'user_input', ts: now(), content: 'do two things' },
      {
        type: 'llm_response',
        ts: now(),
        content: [
          { type: 'tool_use', id: 'u1', name: 'bash', input: {} },
          { type: 'tool_use', id: 'u2', name: 'bash', input: {} },
        ],
        usage: { input: 5, output: 5 },
        stopReason: 'tool_use',
      },
      { type: 'tool_result', ts: now(), id: 'u1', content: 'r1', isError: false },
      { type: 'tool_result', ts: now(), id: 'u2', content: 'r2', isError: false },
    ]);
    const data = await store.load('rp');
    // The two tool_results collapse into a single trailing user message.
    const last = data.messages[data.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(Array.isArray(last?.content) ? last.content.length : 0).toBe(2);
  });
});

describe('FileSessionWriter — observeForSummary event types + scheduled flush', () => {
  it('tracks tool_call_start, legacy tool_use, compaction and provider_error events', async () => {
    const w = await store.create({ id: 'obs', model: 'm', provider: 'p' });
    await w.append({ type: 'tool_call_start', ts: now(), name: 'bash', id: 'c1' } as SessionEvent);
    await w.append({ type: 'tool_use', ts: now(), id: 'u9', name: 'bash', input: {} } as SessionEvent);
    await w.append({ type: 'compaction', ts: now() } as SessionEvent);
    await w.append({ type: 'provider_error', ts: now(), message: 'rate limited' } as SessionEvent);
    await w.close();
    const summaries = await store.list();
    const s = summaries.find((x) => x.id === 'obs');
    expect(s?.outcome).toBe('error');
    expect(s?.toolCallCount).toBe(1);
  });

  it('scrubs llm_response secrets but passes non-conversation events through untouched', async () => {
    const scrubStore = new DefaultSessionStore({ dir: tmp, secretScrubber: new DefaultSecretScrubber() });
    const w = await scrubStore.create({ id: 'scrub', model: 'm', provider: 'p' });
    await w.append({
      type: 'llm_response',
      ts: now(),
      content: [{ type: 'text', text: 'token sk-ant-SECRETSECRETSECRETSECRET here' }],
      usage: { input: 1, output: 1 },
      stopReason: 'end_turn',
    } as SessionEvent);
    // A non-user/non-llm event takes the scrubEvent pass-through branch.
    await w.append({ type: 'tool_call_start', ts: now(), name: 'bash', id: 'p1' } as SessionEvent);
    await w.close();
    const raw = await fs.readFile(path.join(tmp, 'scrub.jsonl'), 'utf8');
    expect(raw).not.toContain('SECRETSECRETSECRETSECRET');
    expect(raw).toContain('tool_call_start');
  });

  it('flushes buffered events via the deferred timer', async () => {
    const w = await store.create({ id: 'timer', model: 'm', provider: 'p' });
    // A single append schedules the 500ms flush timer instead of flushing now.
    await w.append({ type: 'user_input', ts: now(), content: 'deferred' });
    // Wait for the timer to fire and land the event on disk (no explicit flush).
    await vi.waitFor(
      async () => {
        const raw = await fs.readFile(path.join(tmp, 'timer.jsonl'), 'utf8');
        expect(raw).toContain('deferred');
      },
      { timeout: 3000, interval: 50 },
    );
    await w.close();
  });

  it('clears a pending flush timer when a later batch exceeds the flush size', async () => {
    const w = await store.create({ id: 'ab3', model: 'm', provider: 'p' });
    await w.appendBatch([{ type: 'user_input', ts: now(), content: 'small' }]); // schedules timer
    const big: SessionEvent[] = Array.from({ length: 60 }, (_, i) => ({ type: 'user_input', ts: now(), content: `b${i}` }));
    await w.appendBatch(big); // timer pending → cleared, immediate flush
    await w.close();
    const data = await store.load('ab3');
    expect(data.events.filter((e) => e.type === 'user_input').length).toBeGreaterThanOrEqual(61);
  });
});

describe('DefaultSessionStore.loadEventsOnly — fast-path loader', () => {
  it('returns events and metadata but skips message reconstruction', async () => {
    const w = await store.create({ id: 'eo1', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'hello' });
    await w.append({
      type: 'llm_response',
      ts: now(),
      content: [
        { type: 'text', text: 'world' },
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
      ],
      usage: { input: 7, output: 11 },
      stopReason: 'tool_use',
    });
    await w.append({ type: 'tool_result', ts: now(), id: 't1', content: 'r', isError: false });
    await w.close();

    const data = await store.loadEventsOnly('eo1');
    // Events are preserved verbatim.
    expect(data.events.length).toBeGreaterThan(0);
    expect(data.events.some((e) => e.type === 'user_input')).toBe(true);
    expect(data.events.some((e) => e.type === 'llm_response')).toBe(true);
    // Messages array is empty — this is the whole point of the fast path.
    expect(data.messages).toEqual([]);
    // Metadata is still extracted.
    expect(data.metadata.id).toBe('eo1');
    expect(data.metadata.model).toBe('m');
    expect(data.metadata.provider).toBe('p');
    // Usage is still summed across llm_response events.
    expect(data.usage.input).toBe(7);
    expect(data.usage.output).toBe(11);
  });

  it('reuses the full-load cache when called after load()', async () => {
    const w = await store.create({ id: 'eo2', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'x' });
    await w.close();

    // First call — populates the cache.
    const full = await store.load('eo2');
    expect(full.messages.length).toBeGreaterThan(0);
    // Second call (events-only) — should hit the cache and project to messages=[].
    const eventsOnly = await store.loadEventsOnly('eo2');
    expect(eventsOnly.messages).toEqual([]);
    // Events list is shared with the cached full load.
    expect(eventsOnly.events.length).toBe(full.events.length);
    expect(eventsOnly.metadata.id).toBe('eo2');
  });

  it('reads through the file when cache is cold (no prior full load)', async () => {
    const w = await store.create({ id: 'eo3', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'cold' });
    await w.close();

    // First call is events-only — cache is cold, so it reads through.
    const eventsOnly = await store.loadEventsOnly('eo3');
    expect(eventsOnly.messages).toEqual([]);
    expect(eventsOnly.events.some((e) => e.type === 'user_input')).toBe(true);
    // A subsequent full load sees the same events (no corruption from the cold path).
    const full = await store.load('eo3');
    expect(full.events.length).toBe(eventsOnly.events.length);
  });
});

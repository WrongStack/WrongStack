import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileRange } from '../../src/storage/session-store/index-reader.js';
import {
  compactIndexInner,
  readIndexFile,
} from '../../src/storage/session-store/session-store-index.js';
import type { IndexCacheEntry } from '../../src/storage/session-store/types.js';

// Wrap the real index-reader helpers so that readFileRange can be
// overridden per-test (e.g. to simulate a concurrent file change that
// makes the range read return null inside readIndexFile).
vi.mock('../../src/storage/session-store/index-reader.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/storage/session-store/index-reader.js')>();
  return {
    applySessionIndexLines: vi.fn(actual.applySessionIndexLines),
    readFileRange: vi.fn(actual.readFileRange),
  };
});

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-idx-cov-'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const makeSummary = (id: string) =>
  ({ id, title: `T${id}`, startedAt: '2026-01-01T00:00:00Z', model: 'm', provider: 'p', tokenTotal: 0 });

describe('compactIndexInner', () => {
  it('returns early when there are no parts to write', async () => {
    const indexFile = path.join(tmp, '_index.jsonl');
    await expect(compactIndexInner(indexFile, [])).resolves.toBeUndefined();
  });

  it('writes entries without tombstones when deletedIds is omitted', async () => {
    const indexFile = path.join(tmp, '_index.jsonl');
    const entries = [makeSummary('a')];
    await compactIndexInner(indexFile, entries);
    const content = await fsp.readFile(indexFile, 'utf8');
    expect(content).not.toContain('action');
    expect(content).toContain('"id":"a"');
  });

  it('writes tombstone rows when deletedIds is provided', async () => {
    const indexFile = path.join(tmp, '_index.jsonl');
    const entries = [makeSummary('a')];
    const deletedIds = new Set(['old-session']);
    await compactIndexInner(indexFile, entries, deletedIds);
    const content = await fsp.readFile(indexFile, 'utf8');
    expect(content).toContain('"action":"delete"');
    expect(content).toContain('"id":"old-session"');
  });
});

describe('readIndexFile', () => {
  it('returns an empty, non-cached result when stat fails', async () => {
    const indexFile = path.join(tmp, 'nonexistent.jsonl');
    const result = await readIndexFile(indexFile, null);
    expect(result.summaries).toEqual([]);
    expect(result.cache).toBeNull();
  });

  it('returns an empty, non-cached result when readFile fails after stat succeeds', async () => {
    const indexFile = path.join(tmp, '_index.jsonl');
    await fsp.mkdir(indexFile);
    const result = await readIndexFile(indexFile, null);
    expect(result.summaries).toEqual([]);
    expect(result.cache).toBeNull();
  });

  it('reads only appended bytes when the cache matches but the file grew', async () => {
    const indexFile = path.join(tmp, '_index.jsonl');
    const s1 = makeSummary('a');
    const s2 = makeSummary('b');

    await fsp.appendFile(indexFile, JSON.stringify(s1) + '\n', 'utf8');
    const st1 = await fsp.stat(indexFile);

    const byId = new Map([['a', s1]]);
    const cache: IndexCacheEntry = {
      mtimeMs: st1.mtimeMs,
      size: st1.size,
      ino: st1.ino,
      birthtimeMs: st1.birthtimeMs,
      summaries: [s1],
      byId,
      deleted: new Set<string>(),
    };

    await fsp.appendFile(indexFile, JSON.stringify(s2) + '\n', 'utf8');

    const result = await readIndexFile(indexFile, cache);
    expect(result.summaries).toHaveLength(2);
    expect(result.cache).not.toBeNull();
  });

  it('returns cached summaries when the stat matches the cache exactly', async () => {
    const indexFile = path.join(tmp, '_index.jsonl');
    const s1 = makeSummary('a');
    const s2 = makeSummary('b');
    await fsp.appendFile(indexFile, JSON.stringify(s1) + '\n' + JSON.stringify(s2) + '\n', 'utf8');

    const st = await fsp.stat(indexFile);
    const cache: IndexCacheEntry = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      ino: st.ino,
      birthtimeMs: st.birthtimeMs,
      summaries: [s1, s2],
      byId: new Map([['a', s1], ['b', s2]]),
      deleted: new Set<string>(),
    };

    const result = await readIndexFile(indexFile, cache);
    expect(result.summaries).toHaveLength(2);
    expect(result.cache).toBe(cache);
  });

  it('falls through to a full read when the cache does not match the current stat', async () => {
    const indexFile = path.join(tmp, '_index.jsonl');
    const summary = makeSummary('a');
    await fsp.appendFile(indexFile, JSON.stringify(summary) + '\n', 'utf8');

    const st = await fsp.stat(indexFile);
    const staleCache: IndexCacheEntry = {
      mtimeMs: 0,
      size: 0,
      ino: st.ino,
      birthtimeMs: 0,
      summaries: [],
      byId: new Map<string, unknown>(),
      deleted: new Set<string>(),
    };

    const result = await readIndexFile(indexFile, staleCache);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]!.id).toBe('a');
  });

  it('falls through to a full read when readFileRange returns null', async () => {
    const indexFile = path.join(tmp, '_index.jsonl');
    const s1 = makeSummary('a');
    const s2 = makeSummary('b');
    await fsp.appendFile(indexFile, JSON.stringify(s1) + '\n', 'utf8');
    const st1 = await fsp.stat(indexFile);

    const cache: IndexCacheEntry = {
      mtimeMs: st1.mtimeMs,
      size: st1.size,
      ino: st1.ino,
      birthtimeMs: st1.birthtimeMs,
      summaries: [s1],
      byId: new Map([['a', s1]]),
      deleted: new Set<string>(),
    };

    // Append a second entry so stat.size > cached.size → readFileRange is called.
    await fsp.appendFile(indexFile, JSON.stringify(s2) + '\n', 'utf8');

    // Simulate a concurrent file change that makes the range read return null.
    vi.mocked(readFileRange).mockResolvedValueOnce(null);

    const result = await readIndexFile(indexFile, cache);
    expect(result.summaries).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import { GenerationLruCache } from '../src/codebase-index/project-server-cache.js';
import {
  indexRefreshInProgressError,
  type RefreshState,
  ServerQueryCaches,
  staleAwareRead,
} from '../src/codebase-index/project-server-query-cache.js';

/** Activity snapshot with the defaults the server boots with. */
function refreshState(overrides: Partial<RefreshState> = {}): RefreshState {
  return { generation: 0, indexing: false, currentFile: 0, totalFiles: 0, ...overrides };
}

describe('GenerationLruCache.peek', () => {
  it('returns values from any generation without affecting get()', () => {
    const cache = new GenerationLruCache<string>(4);
    cache.set('k', 3, 'v3');
    // peek ignores the generation entirely
    expect(cache.peek('k')).toBe('v3');
    // ...and does not refresh the entry into the current generation
    expect(cache.get('k', 4)).toBeUndefined();
    expect(cache.get('k', 3)).toBe('v3');
  });

  it('returns undefined for absent keys without throwing', () => {
    const cache = new GenerationLruCache<string>(1);
    expect(cache.peek('missing')).toBeUndefined();
  });
});

describe('staleAwareRead', () => {
  it('loads and caches on an idle miss', () => {
    const cache = new GenerationLruCache<number>(4);
    let loads = 0;
    const read = () => {
      loads++;
      return 42;
    };
    expect(staleAwareRead(cache, 'k', refreshState({ generation: 7 }), read)).toEqual({
      value: 42,
      stale: false,
    });
    expect(staleAwareRead(cache, 'k', refreshState({ generation: 7 }), read)).toEqual({
      value: 42,
      stale: false,
    });
    expect(loads).toBe(1);
  });

  it('serves a previous-generation hit as stale while indexing, without loading', () => {
    const cache = new GenerationLruCache<number>(4);
    cache.set('k', 3, 42);
    let loads = 0;
    const result = staleAwareRead(
      cache,
      'k',
      refreshState({ generation: 4, indexing: true, currentFile: 5, totalFiles: 10 }),
      () => {
        loads++;
        return -1;
      },
    );
    expect(result).toEqual({ value: 42, stale: true });
    expect(loads).toBe(0);
  });

  it('serves a current-generation hit as stale too while indexing (peek is generation-blind)', () => {
    const cache = new GenerationLruCache<number>(4);
    cache.set('k', 4, 42);
    const result = staleAwareRead(
      cache,
      'k',
      refreshState({ generation: 4, indexing: true }),
      () => -1,
    );
    expect(result).toEqual({ value: 42, stale: true });
  });

  it('bounds how far a preserved entry may lag the publishing generation', () => {
    // Lag is bounded (MAX_STALE_GENERATION_LAG = 2): an entry that survived
    // several targeted completions without recomputation gets progressively
    // older; beyond the bound it is treated like a miss and the read falls
    // back to the refresh refusal.
    const cache = new GenerationLruCache<number>(4);
    cache.set('k', 2, 42);

    // Lag 2 (generations 2 → 4): still served.
    expect(
      staleAwareRead(cache, 'k', refreshState({ generation: 4, indexing: true }), () => -1),
    ).toEqual({ value: 42, stale: true });

    // Lag 3 (generations 2 → 5): too old — refused like a miss.
    expect(() =>
      staleAwareRead(
        cache,
        'k',
        refreshState({ generation: 5, indexing: true, currentFile: 1, totalFiles: 2 }),
        () => -1,
      ),
    ).toThrowError(expect.objectContaining({ name: 'IndexRefreshInProgressError' }) as Error);
  });

  it('peekEntry exposes the stored generation for the lag bound', () => {
    const cache = new GenerationLruCache<number>(4);
    cache.set('k', 3, 42);
    expect(cache.peekEntry('k')).toEqual({ generation: 3, value: 42 });
    expect(cache.peekEntry('missing')).toBeUndefined();
  });

  it('refuses an indexing miss with IndexRefreshInProgressError', () => {
    const cache = new GenerationLruCache<number>(4);
    expect(() =>
      staleAwareRead(
        cache,
        'k',
        refreshState({ generation: 4, indexing: true, currentFile: 2, totalFiles: 9 }),
        () => -1,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: 'IndexRefreshInProgressError',
        message: expect.stringContaining('(2/9 files)'),
      }) as Error,
    );
  });

  it('a preserved entry is invisible to idle reads after the generation bump, but peek still finds it', () => {
    // This is the mechanism behind "preservation is correctness-safe": after
    // an incremental completion bumps the generation, a normal read of the
    // same key recomputes instead of serving the old answer unflagged.
    const cache = new GenerationLruCache<number>(4);
    cache.set('k', 3, 42);
    let loads = 0;
    const fresh = staleAwareRead(cache, 'k', refreshState({ generation: 4 }), () => {
      loads++;
      return 43;
    });
    expect(fresh).toEqual({ value: 43, stale: false });
    expect(loads).toBe(1);
    expect(cache.peek('k')).toBe(43);
  });
});

describe('indexRefreshInProgressError', () => {
  it('carries the canonical error name and file counts', () => {
    const error = indexRefreshInProgressError(1, 4);
    expect(error.name).toBe('IndexRefreshInProgressError');
    expect(error.message).toContain('(1/4 files)');
  });
});

describe('ServerQueryCaches', () => {
  it('clear() empties every cache and sizes() reports the keys the health snapshot expects', () => {
    const caches = new ServerQueryCaches();
    caches.searchCache.set('q', 1, { results: [], total: 0 });
    caches.statsCache.set('stats', 1, {} as never);
    caches.packageGraphCache.set('package', 1, { nodes: [], edges: [] });
    caches.fileGraphCache.set('f', 1, { nodes: [], edges: [] });
    caches.symbolGraphCache.set('s', 1, { nodes: [], edges: [] });
    caches.incomingCallsCache.set('i', 1, {} as never);
    caches.outgoingCallsCache.set('o', 1, {} as never);

    const sizes = caches.sizes();
    expect(sizes).toMatchObject({
      searchCache: 1,
      statsCache: 1,
      packageGraphCache: 1,
      fileGraphCache: 1,
      symbolGraphCache: 1,
      incomingCallsCache: 1,
      outgoingCallsCache: 1,
    });

    caches.clear();
    expect(Object.values(caches.sizes()).every((n) => n === 0)).toBe(true);
  });

  it('keeps entries across an incremental-style generation bump (no clear)', () => {
    const caches = new ServerQueryCaches();
    caches.searchCache.set('q', 1, { results: [], total: 5 });
    // Incremental completion: generation bumps, caches NOT cleared. The entry
    // must remain peekable for the next refresh's stale-serve window...
    expect(caches.searchCache.peek('q')).toEqual({ results: [], total: 5 });
    // ...while idle reads at the new generation recompute.
    expect(caches.searchCache.get('q', 2)).toBeUndefined();
  });
});

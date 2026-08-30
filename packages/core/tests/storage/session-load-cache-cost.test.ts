import { describe, expect, it } from 'vitest';
import { SessionLoadCache } from '../../src/storage/session-store/load-cache.js';
import type { LoadCacheEntry } from '../../src/storage/session-store/types.js';
import type { SessionData } from '../../src/types/session.js';

/**
 * What the load cache charges itself for an entry.
 *
 * A session journal is mostly superseded context snapshots and events the
 * loader evicts under its own retention budget, so the FILE is an order of
 * magnitude larger than the `SessionData` that survives a load. Charging the
 * budget the file size made the cache refuse the very entries whose rebuild
 * cost seconds: a real 126 MB journal exceeded the whole-cache cap on its own,
 * so `set()` dropped it and every resume and tab redisplay re-parsed the file
 * from byte zero (measured: 2.7 s cold, 2.7 s again, and again).
 */

function data(overrides: Partial<SessionData> = {}): SessionData {
  return {
    metadata: { id: 's', startedAt: 't', model: 'm', provider: 'p' },
    messages: [],
    events: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as SessionData;
}

describe('SessionLoadCache sizing', () => {
  it('refuses an entry whose retained data alone exceeds the whole-cache budget', () => {
    const cache = new SessionLoadCache(new Map());
    const stat = { mtimeMs: 1, size: 1 };

    // 64 Mi chars count as 128 MB of UTF-16 heap — over LOAD_CACHE_MAX_BYTES
    // on content alone, no matter how small the source file claims to be.
    cache.set(
      'huge',
      stat,
      data({ messages: [{ role: 'user', content: 'x'.repeat(64 * 1024 * 1024) }] } as never),
    );

    expect(cache.getFresh('huge', stat, true)).toBeNull();
  });

  it('terminates on a cyclic value instead of walking forever', () => {
    const cache = new SessionLoadCache(new Map());
    const stat = { mtimeMs: 1, size: 1 };
    const cyclic: Record<string, unknown> = { role: 'user', content: 'loop' };
    cyclic['self'] = cyclic;

    cache.set('cyclic', stat, data({ messages: [cyclic] } as never));

    expect(cache.getFresh('cyclic', stat, true)?.messages).toHaveLength(1);
  });
});

describe('SessionLoadCache budgeting', () => {
  it('caches a small transcript that came out of a huge journal', () => {
    const entries = new Map<string, LoadCacheEntry>();
    const cache = new SessionLoadCache(entries);
    // 126 MB on disk, a few hundred kB retained — the exact shape that used to
    // be refused outright.
    const stat = { mtimeMs: 1, size: 126 * 1024 * 1024 };

    cache.set('big', stat, data({ messages: [{ role: 'user', content: 'hello' }] } as never));

    expect(entries.has('big')).toBe(true);
    expect(cache.getFresh('big', stat, true)?.messages).toHaveLength(1);
  });

  it('still misses once the source file changes underneath it', () => {
    const cache = new SessionLoadCache(new Map());
    cache.set('s', { mtimeMs: 1, size: 10 }, data());

    expect(cache.getFresh('s', { mtimeMs: 1, size: 10 }, true)).not.toBeNull();
    expect(cache.getFresh('s', { mtimeMs: 2, size: 10 }, true)).toBeNull();
    expect(cache.getFresh('s', { mtimeMs: 1, size: 11 }, true)).toBeNull();
  });

  it('refunds what it charged, so the running total cannot drift', () => {
    const entries = new Map<string, LoadCacheEntry>();
    const cache = new SessionLoadCache(entries);
    const heavy = data({
      messages: Array.from({ length: 50 }, () => ({
        role: 'user' as const,
        content: 'y'.repeat(1000),
      })),
    } as never);

    // Overwrite the same id repeatedly: each `set` deletes the previous entry
    // first, so a refund keyed on the wrong field would leak budget until the
    // cache stopped accepting anything at all.
    for (let i = 0; i < 200; i += 1) cache.set('same', { mtimeMs: i, size: 5_000_000 }, heavy);

    expect(entries.size).toBe(1);
    expect(cache.getFresh('same', { mtimeMs: 199, size: 5_000_000 }, true)).not.toBeNull();
  });
});

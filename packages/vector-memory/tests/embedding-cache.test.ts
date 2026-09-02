/**
 * Tests for the provider-level embedding cache and idempotent writes.
 *
 * Pin:
 *  - repeated `embed()` calls for the same text skip the provider
 *  - the cache survives entry deletes (independent table)
 *  - `remember()` is idempotent on content_hash
 *  - the UNIQUE index on `entries.content_hash` is a real constraint
 *  - LRU eviction respects `last_used_at`
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VectorMemoryStore } from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function makeStore(
  provider: FakeEmbeddingProvider,
  suffix = '',
): { store: VectorMemoryStore; provider: FakeEmbeddingProvider } {
  const projectRoot = path.join(
    os.tmpdir(),
    `wrongstack-vm-cache-${testRunId}-${Math.random().toString(36).slice(2, 8)}${suffix}`,
  );
  const store = new VectorMemoryStore({
    provider,
    projectRoot,
  });
  return { store, provider };
}

describe('embedding_cache', () => {
  let store: VectorMemoryStore;
  let provider: FakeEmbeddingProvider;

  beforeEach(() => {
    provider = new FakeEmbeddingProvider({ dimensions: 32 });
    ({ store } = makeStore(provider));
  });

  afterEach(() => {
    store.close();
  });

  it('caches the embedding on first remember and reuses on second', async () => {
    const embedSpy = vi.spyOn(provider, 'embed');
    await store.remember({ text: 'cache me' });
    const firstCallCount = embedSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Same text, same provider → cache hit, embed() not called again.
    await store.remember({ text: 'cache me' });
    expect(embedSpy.mock.calls.length).toBe(firstCallCount);
  });

  it('caches query embeddings on search and reuses on repeated query', async () => {
    await store.remember({ text: 'first entry' });
    await store.remember({ text: 'second entry' });
    // Use a query text that was NOT previously cached (different from
    // the stored entries' text) so the first search actually calls
    // provider.embed().
    const query = 'a search query that was not pre-cached';
    const embedSpy = vi.spyOn(provider, 'embed');

    await store.search(query, { limit: 5 });
    const firstCallCount = embedSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Same query → cache hit, no provider call.
    await store.search(query, { limit: 5 });
    expect(embedSpy.mock.calls.length).toBe(firstCallCount);
  });

  it('tracks cache statistics', async () => {
    await store.remember({ text: 'a' });
    await store.remember({ text: 'b' });
    await store.remember({ text: 'a' }); // dedup hit, but cache lookup bumps use_count
    const stats = store.cacheStats();
    expect(stats.entries).toBe(2);
    expect(stats.providers).toBe(1);
    expect(stats.totalUseCount).toBeGreaterThanOrEqual(2);
    expect(stats.oldestLastUsedAt).not.toBeNull();
  });

  it('survives entry deletes (cache is independent of entries)', async () => {
    const a = await store.remember({ text: 'persists-after-delete' });
    const initial = store.cacheStats().entries;
    expect(initial).toBeGreaterThan(0);

    await store.forget(a.id);
    expect(store.get(a.id)).toBeUndefined();
    // Cache entry stays — content_hash lookup still works for new remember().
    const after = store.cacheStats().entries;
    expect(after).toBe(initial);
  });

  it('evicts LRU entries when keepMostRecent is reached', async () => {
    for (let i = 0; i < 5; i++) {
      await store.remember({ text: `text-${i}` });
    }
    const before = store.cacheStats().entries;
    expect(before).toBe(5);

    const result = await store.evictCache(2);
    expect(result.removed).toBe(3);
    expect(store.cacheStats().entries).toBe(2);
  });
});

describe('idempotent remember', () => {
  let store: VectorMemoryStore;
  beforeEach(() => {
    store = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot: path.join(
        os.tmpdir(),
        `wrongstack-vm-idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ),
    });
  });
  afterEach(() => {
    store.close();
  });

  it('returns the same id when called twice with identical text', async () => {
    const a = await store.remember({ text: 'same text' });
    const b = await store.remember({ text: 'same text' });
    expect(b.id).toBe(a.id);
    expect(b.contentHash).toBe(a.contentHash);
  });

  it('treats whitespace + NFKC-normalized text as the same content', async () => {
    const a = await store.remember({ text: 'hello world' });
    const b = await store.remember({ text: '  hello\u00A0world  ' });
    expect(b.id).toBe(a.id);
  });

  it('the UNIQUE index on content_hash is enforced by SQLite', async () => {
    await store.remember({ text: 'unique-test' });
    // Bypass the dedup check by writing a row with a different id but
    // same content_hash — the UNIQUE index must reject it.
    const db = (
      store as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
      }
    ).db;
    expect(() => {
      db.prepare(
        'INSERT INTO entries (id, text, metadata, tags, scope, kind, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'forced-new-id',
        'unique-test',
        '{}',
        '[]',
        'project',
        'note',
        VectorMemoryStore.contentHash('unique-test'),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    }).toThrow();
  });
});

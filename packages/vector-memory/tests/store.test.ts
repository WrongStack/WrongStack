/**
 * VectorMemoryStore tests — no network, no model download.
 *
 * Uses FakeEmbeddingProvider for deterministic, reproducible vectors.
 * The temp directory is reused via WRONGSTACK_HOME; we just point the
 * store at a unique subdirectory per test.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VectorMemoryStore, encodeVector, type SageSyncSource } from '../src/index.js';
import type { VectorMemoryStoreOptions } from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function makeStore(opts: Partial<VectorMemoryStoreOptions> = {}): VectorMemoryStore {
  const projectRoot = path.join(
    os.tmpdir(),
    `wrongstack-vm-${testRunId}-${Math.random().toString(36).slice(2, 8)}`,
  );
  return new VectorMemoryStore({
    provider: new FakeEmbeddingProvider({ dimensions: 64 }),
    projectRoot,
    ...opts,
  });
}

describe('VectorMemoryStore', () => {
  let store: VectorMemoryStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.close();
  });

  it('remembers an entry and returns a stored vector', async () => {
    const entry = await store.remember({ text: 'hello world', tags: ['greeting'] });
    expect(entry.id).toBeTypeOf('string');
    expect(entry.text).toBe('hello world');
    expect(entry.tags).toEqual(['greeting']);
    expect(entry.vector).toBeDefined();
    expect(entry.vector?.length).toBe(64);
    expect(entry.providerId).toMatch(/^fake-v1-/);
  });

  it('retrieves an entry by id with its vector', async () => {
    const created = await store.remember({ text: 'foo bar' });
    const fetched = store.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.text).toBe('foo bar');
    expect(fetched?.vector).toBeDefined();
    expect(fetched?.vector?.length).toBe(64);
  });

  it('removes an entry on forget', async () => {
    const created = await store.remember({ text: 'delete me' });
    expect(await store.forget(created.id)).toBe(true);
    expect(store.get(created.id)).toBeUndefined();
  });

  it('returns false on forget for unknown id', async () => {
    expect(await store.forget('nonexistent-id')).toBe(false);
  });

  it('ranks search results by cosine similarity', async () => {
    await store.remember({ text: 'apple banana cherry' });
    await store.remember({ text: 'apple banana mango' });
    await store.remember({ text: 'completely unrelated text' });
    const hits = await store.search('apple banana', { limit: 5 });
    expect(hits.length).toBe(3);
    // Results should be sorted by score descending.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
    // Top hit should share the "apple banana" prefix.
    expect(hits[0]!.entry.text).toContain('apple');
  });

  it('filters by threshold', async () => {
    await store.remember({ text: 'apple banana cherry' });
    await store.remember({ text: 'completely unrelated text' });
    const hits = await store.search('apple banana', { threshold: 0.95 });
    // Threshold is strict — may drop all hits, that's fine.
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('returns empty array for empty query', async () => {
    expect(await store.search('')).toEqual([]);
    expect(await store.search('   ')).toEqual([]);
  });

  it('lists entries sorted by updated_at descending', async () => {
    const a = await store.remember({ text: 'first' });
    // Ensure deterministic ordering — the second insert has a later timestamp.
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.remember({ text: 'second' });
    const list = store.list({ limit: 10 });
    expect(list.map((e) => e.id)).toEqual([b.id, a.id]);
  });

  it('reports stats with correct counts', async () => {
    await store.remember({ text: 'one' });
    await store.remember({ text: 'two' });
    await store.remember({ text: 'three' });
    const stats = store.stats();
    expect(stats.entries).toBe(3);
    expect(stats.vectors).toBe(3);
    expect(stats.providers).toContain(stats.modelId);
  });

  it('syncs active SAGE memories without duplicating', async () => {
    const sage: SageSyncSource = {
      listActiveMemories: async () => [
        { id: 'sage-1', text: 'shared fact', tags: ['sage'] },
        { id: 'sage-2', text: 'another fact' },
      ],
    };
    const report1 = await store.syncFromSage(sage);
    expect(report1.scanned).toBe(2);
    expect(report1.indexed).toBe(2);
    expect(report1.skipped).toBe(0);

    const report2 = await store.syncFromSage(sage);
    expect(report2.scanned).toBe(2);
    expect(report2.indexed).toBe(0);
    expect(report2.skipped).toBe(2);
  });

  it('records the active provider id in schema_meta', () => {
    expect(store.activeProviderId).toMatch(/^fake-v1-/);
  });

  it('skips corrupted vectors that produce NaN cosine similarity in search', async () => {
    const valid = await store.remember({ text: 'valid entry to find' });
    const corrupted = await store.remember({ text: 'corrupted entry' });

    // Corrupt the vector blob for the second entry with NaNs
    const nanVector = new Float32Array(64).fill(Number.NaN);
    const db = (store as unknown as { db: any }).db;
    db.prepare('UPDATE vectors SET vector = ? WHERE entry_id = ?').run(
      encodeVector(nanVector),
      corrupted.id
    );

    const hits = await store.search('valid entry', { limit: 10, threshold: 0.1 });
    expect(hits.map((h) => h.entry.id)).toContain(valid.id);
    expect(hits.map((h) => h.entry.id)).not.toContain(corrupted.id);
    expect(hits.every((h) => Number.isFinite(h.score))).toBe(true);
  });
});


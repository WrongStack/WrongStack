/**
 * Integration test — exercises the real `@huggingface/transformers`
 * feature-extraction pipeline end-to-end.
 *
 * Gated behind the `WRONGSTACK_VECTOR_INTEGRATION` env var so the
 * default `pnpm test` run stays hermetic and PRs are not blocked on
 * a 25 MB model download. CI periodically enables this gate
 * (`WRONGSTACK_VECTOR_INTEGRATION=1 pnpm --filter @wrongstack/vector-memory test:integration`)
 * to validate the model loading path on the supported platforms.
 *
 * What it checks:
 *  - The optional `@huggingface/transformers` dependency is installed.
 *  - `TransformersEmbeddingProvider.isAvailable()` returns true.
 *  - `embed()` returns a Float32Array of the expected dimensions
 *    (384 for `Xenova/all-MiniLM-L6-v2`).
 *  - The embedding of two similar texts has a higher cosine
 *    similarity than the embedding of two dissimilar texts.
 *
 * The model is cached under `process.env.WRONGSTACK_VECTOR_MODEL_CACHE`
 * (default: a per-run temp dir) so repeated runs reuse the cache.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VECTOR_DIMENSIONS,
  TransformersEmbeddingProvider,
  VectorMemoryStore,
} from '../src/index.js';
import { cosineSimilarity } from '@wrongstack/sage';

const ENABLED = process.env['WRONGSTACK_VECTOR_INTEGRATION'] === '1';
const describeIf = ENABLED ? describe : describe.skip;

const modelCacheDir =
  process.env['WRONGSTACK_VECTOR_MODEL_CACHE'] ??
  path.join(os.tmpdir(), `wrongstack-vm-models-${Date.now()}`);

describeIf('TransformersEmbeddingProvider — real pipeline', () => {
  it('is available when @huggingface/transformers is installed', async () => {
    const provider = new TransformersEmbeddingProvider({
      cacheDir: modelCacheDir,
      allowRemoteModels: process.env['WRONGSTACK_VECTOR_OFFLINE'] !== '1',
    });
    expect(await provider.isAvailable()).toBe(true);
    expect(provider.dimensions).toBe(DEFAULT_VECTOR_DIMENSIONS);
  }, 180_000);

  it('produces dimension-correct Float32Array vectors', async () => {
    const provider = new TransformersEmbeddingProvider({
      cacheDir: modelCacheDir,
    });
    const vectors = await provider.embed(['hello world', 'goodbye world']);
    expect(vectors).toHaveLength(2);
    for (const v of vectors) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(DEFAULT_VECTOR_DIMENSIONS);
      // L2-normalized → norm ≈ 1.
      let norm = 0;
      for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
      expect(Math.abs(Math.sqrt(norm) - 1)).toBeLessThan(0.01);
    }
  }, 180_000);

  it('ranks semantically similar pairs above dissimilar ones', async () => {
    const provider = new TransformersEmbeddingProvider({
      cacheDir: modelCacheDir,
    });
    const [apple, fruit, vehicle] = await provider.embed([
      'apple',
      'orange is a citrus fruit',
      'a sports car accelerates quickly',
    ]);
    const simFruit = cosineSimilarity(apple!, fruit!);
    const simVehicle = cosineSimilarity(apple!, vehicle!);
    // MiniLM embeddings cluster apples closer to oranges than to cars.
    expect(simFruit).toBeGreaterThan(simVehicle);
  }, 180_000);

  it('VectorMemoryStore round-trips real embeddings', async () => {
    const provider = new TransformersEmbeddingProvider({
      cacheDir: modelCacheDir,
    });
    const store = new VectorMemoryStore({
      provider,
      projectRoot: path.join(
        os.tmpdir(),
        `wrongstack-vm-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ),
    });
    try {
      await store.remember({ text: 'apple banana cherry' });
      await store.remember({ text: 'apple mango pineapple' });
      await store.remember({ text: 'sports car engine' });
      const hits = await store.search('apple banana', { limit: 5 });
      expect(hits.length).toBe(3);
      // The two fruit entries should rank above the car entry.
      const topTexts = hits.slice(0, 2).map((h) => h.entry.text);
      expect(topTexts.every((t) => t.includes('apple'))).toBe(true);
    } finally {
      store.close();
    }
  }, 180_000);
});

// Always log the gate state so CI can confirm it was honored.
console.log(
  `[vector-memory integration] WRONGSTACK_VECTOR_INTEGRATION=${ENABLED ? '1' : '0'} — ` +
    `tests ${ENABLED ? 'will run' : 'skipped'}`,
);

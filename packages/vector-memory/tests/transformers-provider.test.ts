/**
 * TransformersEmbeddingProvider tests — no network, no model download.
 *
 * These tests verify the provider's graceful-failure behavior and its
 * configuration surface. Real embedding quality is not tested here —
 * that requires the actual model, which is an integration concern.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VECTOR_DIMENSIONS,
  DEFAULT_VECTOR_DTYPE,
  DEFAULT_VECTOR_MODEL_ID,
  TransformersEmbeddingProvider,
} from '../src/index.js';

describe('TransformersEmbeddingProvider', () => {
  it('exposes the expected defaults', () => {
    const provider = new TransformersEmbeddingProvider();
    expect(provider.id).toBe(`transformers-js:${DEFAULT_VECTOR_MODEL_ID}:${DEFAULT_VECTOR_DTYPE}`);
    expect(provider.dimensions).toBe(DEFAULT_VECTOR_DIMENSIONS);
  });

  it('reflects the configured modelId and dtype in its id', () => {
    const provider = new TransformersEmbeddingProvider({
      modelId: 'Xenova/all-mpnet-base-v2',
      dtype: 'fp32',
    });
    expect(provider.id).toBe('transformers-js:Xenova/all-mpnet-base-v2:fp32');
  });

  it('reports availability based on whether the optional dep is installed', async () => {
    const provider = new TransformersEmbeddingProvider({
      cacheDir: path.join(os.tmpdir(), `vt-${Date.now()}`),
    });
    const available = await provider.isAvailable();
    // The transformers backend is opt-in, so availability depends on the
    // environment running the test.
    expect(typeof available).toBe('boolean');
  });
});

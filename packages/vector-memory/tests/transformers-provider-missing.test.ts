import { describe, expect, it, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => {
  throw new Error('Module not found');
});

import {
  TransformersEmbeddingProvider,
  VectorMemoryProviderUnavailableError,
} from '../src/index.js';

describe('TransformersEmbeddingProvider when dependency is missing', () => {
  it('isAvailable returns false and embed throws VectorMemoryProviderUnavailableError', async () => {
    const provider = new TransformersEmbeddingProvider();
    expect(await provider.isAvailable()).toBe(false);
    await expect(provider.embed(['test'])).rejects.toThrow(VectorMemoryProviderUnavailableError);
  });
});

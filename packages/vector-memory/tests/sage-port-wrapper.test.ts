/**
 * Tests for `wrapMemoryPortWithVectorRecall` — the SAGE-port wrapper that
 * routes `searchSage` calls through a vector-recall channel.
 *
 * Pin:
 *  - capabilities other than retrieval/surface pass through unchanged
 *  - the retrieval capability's searchSage is wrapped to inject the provider
 *  - the surface capability's searchSage is wrapped to inject the provider
 *  - an explicit `vectorRecall` on the call site wins over the wrapper
 *  - a missing underlying capability returns undefined (no crash)
 *  - the vectorRecall option is set with weight/threshold defaults
 */
import { describe, expect, it, vi } from 'vitest';
import type { MemoryPort } from '@wrongstack/core/types';
import {
  SAGE_RETRIEVAL_CAPABILITY,
  SAGE_SURFACE_CAPABILITY,
  type SageRetrievalCapability,
  type SageSurface,
} from '@wrongstack/sage';

import {
  VectorMemoryStore,
  wrapMemoryPortWithVectorRecall,
  type VectorMemoryStoreOptions,
} from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

function makeFakePort(opts: {
  retrieval?: SageRetrievalCapability;
  surface?: SageSurface;
} = {}): MemoryPort {
  const port = {
    async initialize() {},
    async dispose() {},
    async health() {
      return { ok: true };
    },
    withTraceId() {
      return port;
    },
    getCapability<T>(cap: { id: string }): T | undefined {
      if (cap.id === SAGE_RETRIEVAL_CAPABILITY.id) return opts.retrieval as unknown as T;
      if (cap.id === SAGE_SURFACE_CAPABILITY.id) return opts.surface as unknown as T;
      return undefined;
    },
    async read() {
      return [];
    },
    async remember() {
      return 1;
    },
    async forget() {
      return 0;
    },
    async consolidate() {},
    async clear() {
      return 0;
    },
    async list() {
      return [];
    },
    async search() {
      return [];
    },
  };
  return port as unknown as MemoryPort;
}

describe('wrapMemoryPortWithVectorRecall', () => {
  it('passes through capabilities that are not retrieval/surface', () => {
    const port = makeFakePort();
    const customCap = { id: 'custom-cap' };
    (port.getCapability as unknown as (cap: { id: string }) => unknown) = vi.fn(() => ({
      customField: 'kept',
    }));
    const wrapped = wrapMemoryPortWithVectorRecall(port, {
      store: undefined as unknown as VectorMemoryStore,
    });
    const result = wrapped.getCapability(customCap);
    expect(result).toEqual({ customField: 'kept' });
  });

  it('wraps the retrieval searchSage to inject the vector recall', async () => {
    const searchSage = vi.fn(async () => []);
    const port = makeFakePort({
      retrieval: { searchSage, retrieveForPath: async () => [] } as unknown as SageRetrievalCapability,
    });
    const store = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot: 'D:/tmp/wrap-test',
    } as VectorMemoryStoreOptions);
    try {
      const wrapped = wrapMemoryPortWithVectorRecall(port, { store });
      const cap = wrapped.getCapability<SageRetrievalCapability>(SAGE_RETRIEVAL_CAPABILITY)!;
      await cap.searchSage('apple', { limit: 5 });
      expect(searchSage).toHaveBeenCalledTimes(1);
      const [query, opts] = searchSage.mock.calls[0]!;
      expect(query).toBe('apple');
      expect((opts as Record<string, unknown>)['vectorRecall']).toBeDefined();
      expect((opts as Record<string, unknown>)['vectorRecallWeight']).toBeUndefined(); // default
    } finally {
      store.close();
    }
  });

  it('wraps the surface searchSage to inject the vector recall', async () => {
    const searchSage = vi.fn(async () => []);
    const port = makeFakePort({
      surface: { searchSage } as unknown as SageSurface,
    });
    const store = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot: 'D:/tmp/wrap-test-2',
    } as VectorMemoryStoreOptions);
    try {
      const wrapped = wrapMemoryPortWithVectorRecall(port, { store, weight: 0.5 });
      const cap = wrapped.getCapability<SageSurface>(SAGE_SURFACE_CAPABILITY)!;
      await cap.searchSage('apple');
      const [, opts] = searchSage.mock.calls[0]!;
      expect((opts as Record<string, unknown>)['vectorRecall']).toBeDefined();
      expect((opts as Record<string, unknown>)['vectorRecallWeight']).toBe(0.5);
    } finally {
      store.close();
    }
  });

  it("honors a caller's explicit `vectorRecall` over the wrapper", async () => {
    const searchSage = vi.fn(async () => []);
    const port = makeFakePort({
      retrieval: { searchSage } as unknown as SageRetrievalCapability,
    });
    const store = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot: 'D:/tmp/wrap-test-3',
    } as VectorMemoryStoreOptions);
    try {
      const wrapped = wrapMemoryPortWithVectorRecall(port, { store });
      const cap = wrapped.getCapability<SageRetrievalCapability>(SAGE_RETRIEVAL_CAPABILITY)!;
      const explicitRecall = { search: async () => [] };
      await cap.searchSage('apple', { vectorRecall: explicitRecall });
      const [, opts] = searchSage.mock.calls[0]!;
      expect((opts as Record<string, unknown>)['vectorRecall']).toBe(explicitRecall);
    } finally {
      store.close();
    }
  });

  it('returns undefined when the underlying capability is absent', () => {
    const port = makeFakePort();
    const store = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot: 'D:/tmp/wrap-test-4',
    } as VectorMemoryStoreOptions);
    try {
      const wrapped = wrapMemoryPortWithVectorRecall(port, { store });
      expect(wrapped.getCapability(SAGE_RETRIEVAL_CAPABILITY)).toBeUndefined();
      expect(wrapped.getCapability(SAGE_SURFACE_CAPABILITY)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

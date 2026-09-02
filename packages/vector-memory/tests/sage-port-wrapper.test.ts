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
  type Sage,
  type SageRetrievalCapability,
  type SageSurface,
} from '@wrongstack/sage';

import {
  VectorMemoryStore,
  wrapMemoryPortWithVectorRecall,
  type VectorMemoryStoreOptions,
} from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

function makeFakePort(
  opts: { retrieval?: SageRetrievalCapability; surface?: SageSurface } = {},
): MemoryPort {
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
    const searchSage = vi.fn(
      async (_query: string, _opts?: Record<string, unknown>) => [] as Sage[],
    );
    const port = makeFakePort({
      retrieval: {
        searchSage,
        retrieveForPath: async () => [],
      } as unknown as SageRetrievalCapability,
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
    const searchSage = vi.fn(
      async (_query: string, _opts?: Record<string, unknown>) => [] as Sage[],
    );
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
    const searchSage = vi.fn(
      async (_query: string, _opts?: Record<string, unknown>) => [] as Sage[],
    );
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

  // E2E regression (run 31933976336): the wrapper was built via a plain
  // spread, which copies only own enumerable properties. Real ports are
  // class instances whose methods live on the prototype — the spread
  // silently dropped them and boot crashed on the first direct call
  // (`memoryStore.withTraceId is not a function`). Object-literal fakes
  // cannot catch this; only a class-instance port can.
  it('preserves prototype methods of a class-instance port (E2E boot crash)', async () => {
    class ClassInstancePort {
      readonly calls: string[] = [];
      async initialize() {}
      async dispose() {}
      async health() {
        return { ok: true };
      }
      withTraceId(traceId: string) {
        this.calls.push(traceId);
        return this;
      }
      getCapability<T>(_cap: { id: string }): T | undefined {
        return undefined;
      }
      async read() {
        return [];
      }
      async remember() {
        return 1;
      }
      async forget() {
        return 0;
      }
      async consolidate() {}
      async clear() {
        return 0;
      }
      async list() {
        return [];
      }
      async search() {
        return [];
      }
    }
    const port = new ClassInstancePort();
    const store = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot: 'D:/tmp/wrap-test-5',
    } as VectorMemoryStoreOptions);
    try {
      const wrapped = wrapMemoryPortWithVectorRecall(port as unknown as MemoryPort, { store });
      // The exact call that crashed the E2E WebUI boot.
      const returned = (wrapped as unknown as ClassInstancePort).withTraceId('trace-e2e');
      // Prototype method ran: state mutated on the shared `calls` array.
      expect(port.calls).toEqual(['trace-e2e']);
      // `return this` binds to the receiver (the wrapper), which is itself
      // a valid MemoryPort — chaining stays inside the wrapped surface.
      expect(returned).toBe(wrapped);
      await expect(wrapped.health()).resolves.toEqual({ ok: true });
    } finally {
      store.close();
    }
  });
});

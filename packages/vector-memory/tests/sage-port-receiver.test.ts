import type { MemoryPort } from '@wrongstack/contracts/types';
import { SAGE_RETRIEVAL_CAPABILITY, SAGE_SURFACE_CAPABILITY } from '@wrongstack/sage';
import { describe, expect, it } from 'vitest';
import { wrapMemoryPortWithVectorRecall } from '../src/sage-port-wrapper.js';
import type { VectorMemoryStore } from '../src/store.js';

class PrivateCapability {
  #marker = 42;
  ownMarker = () => this.#marker;
  async searchSage() {
    return [];
  }
  marker() {
    return this.#marker;
  }
}
class PrivatePort {
  #ready = false;
  capability = new PrivateCapability();
  async initialize() {
    this.#ready = true;
  }
  get ready() {
    return this.#ready;
  }
  withTraceId(_id: string) {
    return this;
  }
  getCapability() {
    return this.capability;
  }
}
const options = {
  store: undefined as unknown as VectorMemoryStore,
  vectorRecall: { search: async () => [] },
};
describe('vector port receiver identity', () => {
  it('preserves native private fields, fluent calls, prototype and own function identities', async () => {
    const port = new PrivatePort();
    const wrapped = wrapMemoryPortWithVectorRecall(port as unknown as MemoryPort, options);
    expect(Object.getPrototypeOf(wrapped)).toBe(PrivatePort.prototype);
    expect(wrapped.initialize).toBe(wrapped.initialize);
    await wrapped.initialize();
    expect(port.ready).toBe(true);
    expect((wrapped as unknown as PrivatePort).ready).toBe(true);
    expect(wrapped.withTraceId('trace')).toBe(wrapped);
    const cap = wrapped.getCapability(SAGE_SURFACE_CAPABILITY) as unknown as PrivateCapability;
    expect(cap.marker()).toBe(42);
    expect(cap.marker).toBe(cap.marker);
    expect(cap.ownMarker).toBe(port.capability.ownMarker);
    expect(await cap.searchSage()).toEqual([]);
    expect(wrapped.getCapability({ id: 'other' })).toBe(port.capability);
  });
  it('makes initialization visible to capabilities that close over mutable original state', async () => {
    class MutablePort {
      initialized = false;
      async initialize() {
        this.initialized = true;
      }
      getCapability() {
        return { searchSage: async () => [], ready: () => this.initialized };
      }
    }
    const port = new MutablePort();
    const wrapped = wrapMemoryPortWithVectorRecall(port as unknown as MemoryPort, options);
    await wrapped.initialize();
    const cap = wrapped.getCapability(SAGE_SURFACE_CAPABILITY) as unknown as { ready(): boolean };
    expect(port.initialized).toBe(true);
    expect(cap.ready()).toBe(true);
  });

  // Regression for the fluent-override loss: `delegateWithOverrides` runs
  // inherited methods with `this = original` and normalizes a `return this`
  // back to the wrapper. If that normalization is dropped, `withTraceId()`
  // hands back the RAW port and every capability read through the derived
  // reference silently loses the vector-recall override (searches stop
  // fusing). Mirrors the real ports: withTraceId is a PROTOTYPE method that
  // returns `this` (SqliteMemoryPort, ProjectSageMemoryPort).
  it('keeps the vector-recall getCapability override alive on a withTraceId-derived port', async () => {
    class RetrievalCapability {
      async searchSage(query: string) {
        return [{ id: 'raw-1', text: `lexical ${query}` }];
      }
    }
    class DerivedPort {
      traceId?: string;
      readonly retrieval = new RetrievalCapability();
      withTraceId(id: string) {
        this.traceId = id;
        return this;
      }
      getCapability(cap: { id: string }) {
        if (cap.id === SAGE_RETRIEVAL_CAPABILITY.id) return this.retrieval;
        if (cap.id === SAGE_SURFACE_CAPABILITY.id) {
          return {
            getSage: async (id: string) =>
              id === 'vec-1'
                ? ({
                    id: 'vec-1',
                    text: 'vector only',
                    kind: 'fact',
                    scope: 'project',
                    status: 'active',
                    importance: 0.8,
                    confidence: 0.8,
                    freshness: 1,
                    tags: [],
                    anchors: [],
                    sources: [],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                  } as never)
                : undefined,
          };
        }
        return undefined;
      }
    }
    const port = new DerivedPort();
    const wrapped = wrapMemoryPortWithVectorRecall(port as unknown as MemoryPort, {
      store: undefined as unknown as VectorMemoryStore,
      vectorRecall: {
        search: async () => [
          { id: 'v1', score: 0.9, text: 'vector only', tags: [], metadata: { sageId: 'vec-1' } },
        ],
      },
    });

    // Derive FIRST — the reported escape is the fluent return leaving the
    // wrapper before any capability is read through it.
    const derived = (wrapped as unknown as DerivedPort).withTraceId('trace-1');
    expect(derived).toBe(wrapped);
    expect(port.traceId).toBe('trace-1');

    // Through the DERIVED reference the getCapability override must still be
    // alive: the search fuses (semantic-only hit materialized + admitted),
    // instead of the lexical passthrough the bare port would return.
    const cap = derived.getCapability(SAGE_RETRIEVAL_CAPABILITY) as unknown as {
      searchSage: (query: string) => Promise<Array<{ id: string }>>;
    };
    expect(cap.searchSage).not.toBe(port.retrieval.searchSage);
    const ids = (await cap.searchSage('anything')).map((memory) => memory.id);
    expect(ids).toContain('raw-1');
    expect(ids).toContain('vec-1');
  });
});

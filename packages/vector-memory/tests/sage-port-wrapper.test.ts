/**
 * Tests for `wrapMemoryPortWithVectorRecall` — the SAGE-port wrapper that
 * routes `searchSage` calls through a vector-recall channel.
 *
 * Pin:
 *  - capabilities other than retrieval/surface pass through unchanged
 *  - the retrieval capability's searchSage fuses host-side
 *  - the surface capability's searchSage fuses host-side
 *  - an explicit `vectorRecall` on the call site wins over the wrapper
 *  - a missing underlying capability returns undefined (no crash)
 *
 * The wrapper must NOT push the recall provider into the search options: the
 * production port speaks JSON over the SAGE daemon socket, where a function
 * silently becomes `{}` and the whole semantic channel dies fail-open. The
 * two tests below pin that the forwarded options stay serializable.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryPort } from '@wrongstack/contracts/types';
import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import {
  createSageToolCallMiddleware,
  SAGE_RETRIEVAL_CAPABILITY,
  SAGE_SERVICE_CAPABILITY,
  SAGE_SURFACE_CAPABILITY,
  type Sage,
  type SageRetrievalCapability,
  type SageSurface,
} from '@wrongstack/sage';
import { describe, expect, it, vi } from 'vitest';

import {
  VectorMemoryStore,
  type VectorMemoryStoreOptions,
  wrapMemoryPortWithVectorRecall,
} from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

function makeFakePort(
  opts: {
    retrieval?: SageRetrievalCapability;
    surface?: SageSurface;
    service?: Record<string, unknown>;
  } = {},
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
      if (cap.id === SAGE_SERVICE_CAPABILITY.id) return opts.service as unknown as T;
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

function makeSage(id: string, text: string, overrides: Partial<Sage> = {}): Sage {
  return {
    id,
    text,
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
    ...overrides,
  } as unknown as Sage;
}

describe('wrapMemoryPortWithVectorRecall', () => {
  it.each([
    { label: 'strong semantic recall', score: 0.99, patch: {}, admitted: true, maxHints: 8 },
    { label: 'weak relation', score: 0.7, patch: {}, admitted: false, maxHints: 8 },
    { label: 'stale', score: 0.99, patch: { status: 'stale' }, admitted: false, maxHints: 8 },
    {
      label: 'context ban',
      score: 0.99,
      patch: { contextPolicy: 'never' },
      admitted: false,
      maxHints: 8,
    },
    {
      label: 'audience isolation',
      score: 0.99,
      patch: { audience: { roles: ['reviewer'] } },
      admitted: false,
      maxHints: 8,
    },
    {
      label: 'session isolation',
      score: 0.99,
      patch: { scope: 'session', ownerSessionId: 'other' },
      admitted: false,
      maxHints: 8,
    },
    {
      label: 'anchor wins the one-hint budget',
      score: 0.99,
      patch: {},
      admitted: false,
      maxHints: 1,
    },
  ])(
    'retains full lexical search and injection gates: $label',
    async ({ score, patch, admitted, maxHints }) => {
      const lexical = Array.from({ length: 64 }, (_, i) =>
        makeSage(`noise-${i}`, `unrelated orchard ${i}`),
      );
      const semantic = makeSage(
        'semantic',
        'Retry budgets drain in the waiting room before the wire gate opens.',
        patch as Partial<Sage>,
      );
      const anchor = makeSage(
        'anchor',
        'Preserve quarantine admission invariants before changing this file.',
        {
          anchors: [{ type: 'file', path: 'src/quarantine.ts' }],
        },
      );
      const port = makeFakePort({
        retrieval: {
          searchSage: async () => lexical,
          searchSageWithBreakdown: async () =>
            lexical.map((memory) => ({
              memory,
              source: 'lexical',
              vectorScore: null,
              lexicalScore: 1,
              finalScore: 1,
            })),
          retrieveForPath: async () => [anchor],
          recordInjection: async () => {},
        } as unknown as SageRetrievalCapability,
        surface: { getSage: async () => semantic } as unknown as SageSurface,
      });
      const wrapped = wrapMemoryPortWithVectorRecall(port, {
        store: undefined as unknown as VectorMemoryStore,
        vectorRecall: {
          search: async () => [
            { id: 'v', score, text: semantic.text, tags: [], metadata: { sageId: semantic.id } },
          ],
        },
      });
      const memory = wrapped.getCapability<SageRetrievalCapability>(SAGE_RETRIEVAL_CAPABILITY)!;
      // Ordinary operator searches keep their original limit/order.
      expect(await memory.searchSage('quarantine', { limit: 64 })).toEqual(lexical);
      const middleware = createSageToolCallMiddleware({
        memory,
        taskAware: false,
        minScore: 0.65,
        relationFloor: 0.9,
        maxHintsPerTool: maxHints,
        maxCharsPerTool: 2800,
        getSessionId: () => 'own',
      });
      const payload = {
        toolUse: { type: 'tool_use', id: 't', name: 'read', input: { path: 'src/quarantine.ts' } },
        result: {
          type: 'tool_result',
          tool_use_id: 't',
          name: 'read',
          content: 'export const quarantine = true;',
        },
        ctx: {
          projectRoot: process.cwd(),
          cwd: process.cwd(),
          session: { id: 'own' },
          signal: new AbortController().signal,
        },
      } as unknown as ToolCallPipelinePayload;
      const result = await middleware.handler(payload, async (value) => value);
      const evidence =
        (result.ctx as unknown as { memoryEvidence?: Array<{ text: string }> }).memoryEvidence
          ?.map((entry) => entry.text)
          .join('\n') ?? '';
      expect(evidence).toContain(anchor.text);
      expect(evidence.includes(semantic.text)).toBe(admitted);
      expect(evidence).not.toContain('unrelated orchard');
      expect(evidence.length).toBeLessThanOrEqual(2800);
    },
  );

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
      projectRoot: path.join(os.tmpdir(), 'wrap-test'),
    } as VectorMemoryStoreOptions);
    try {
      const wrapped = wrapMemoryPortWithVectorRecall(port, { store });
      const cap = wrapped.getCapability<SageRetrievalCapability>(SAGE_RETRIEVAL_CAPABILITY)!;
      await cap.searchSage('apple', { limit: 5 });
      expect(searchSage).toHaveBeenCalledTimes(1);
      const [query, opts] = searchSage.mock.calls[0]!;
      expect(query).toBe('apple');
      // The provider stays host-side. Anything the wrapper forwards has to
      // survive `JSON.stringify` — a function does not.
      expect((opts as Record<string, unknown>)['vectorRecall']).toBeUndefined();
      expect(JSON.parse(JSON.stringify(opts))).toEqual({ limit: 5 });
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
      projectRoot: path.join(os.tmpdir(), 'wrap-test-2'),
    } as VectorMemoryStoreOptions);
    try {
      const wrapped = wrapMemoryPortWithVectorRecall(port, { store, weight: 0.5 });
      const cap = wrapped.getCapability<SageSurface>(SAGE_SURFACE_CAPABILITY)!;
      await cap.searchSage('apple');
      expect(searchSage).toHaveBeenCalledTimes(1);
      const [, opts] = searchSage.mock.calls[0]!;
      expect((opts as Record<string, unknown>)?.['vectorRecall']).toBeUndefined();
    } finally {
      store.close();
    }
  });

  // The agent's `memory_search` / `memory_search_explain` tools are built from
  // the SERVICE capability. Left unwrapped, the model's own searches never
  // reached the semantic channel even on hosts where injection did.
  it('fuses the service capability used by the agent memory tools', async () => {
    const lexicalHit = makeSage('lex-1', 'lexical only');
    const semanticHit = makeSage('vec-1', 'semantic only');
    const serviceSearch = vi.fn(async () => [lexicalHit]);
    const remember = vi.fn();
    const port = makeFakePort({
      service: { searchSage: serviceSearch, rememberSage: remember },
      surface: {
        getSage: async (id: string) => (id === 'vec-1' ? semanticHit : undefined),
      } as unknown as SageSurface,
    });
    const vectorRecall = {
      search: async () => [
        { id: 'v1', score: 0.9, text: 'semantic only', tags: [], metadata: { sageId: 'vec-1' } },
      ],
    };
    const wrapped = wrapMemoryPortWithVectorRecall(port, {
      store: undefined as unknown as VectorMemoryStore,
      vectorRecall,
    });
    const service = wrapped.getCapability(SAGE_SERVICE_CAPABILITY)!;

    const ids = (await service.searchSage('anything', { includeStatuses: ['active'] })).map(
      (memory) => memory.id,
    );

    expect(ids).toEqual(expect.arrayContaining(['lex-1', 'vec-1']));
    expect(serviceSearch).toHaveBeenCalledTimes(1);
    // Write-side members pass through untouched.
    expect(service.rememberSage).toBe(remember);
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
      projectRoot: path.join(os.tmpdir(), 'wrap-test-3'),
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

  // The whole point of the host-side fusion: a memory the lexical channel
  // never returned must still reach the caller when the semantic channel
  // finds it — and must be resolved through the port, not conjured from the
  // vector row (which holds no Sage shape).
  it('materializes a semantic-only hit through the port and respects visibility', async () => {
    const lexicalHit = makeSage('lex-1', 'lexical only');
    const semanticHit = makeSage('vec-1', 'semantic only');
    const hiddenHit = makeSage('vec-2', 'another session', {
      scope: 'session',
      ownerSessionId: 'other-session',
    });
    const searchSage = vi.fn(async () => [lexicalHit]);
    const getSage = vi.fn(async (id: string) =>
      id === 'vec-1' ? semanticHit : id === 'vec-2' ? hiddenHit : undefined,
    );
    const port = makeFakePort({
      retrieval: { searchSage } as unknown as SageRetrievalCapability,
      surface: { getSage } as unknown as SageSurface,
    });
    const vectorRecall = {
      search: async () => [
        { id: 'v1', score: 0.9, text: 'semantic only', tags: [], metadata: { sageId: 'vec-1' } },
        { id: 'v2', score: 0.9, text: 'another session', tags: [], metadata: { sageId: 'vec-2' } },
      ],
    };
    const wrapped = wrapMemoryPortWithVectorRecall(port, {
      store: undefined as unknown as VectorMemoryStore,
      vectorRecall,
    });
    const cap = wrapped.getCapability<SageRetrievalCapability>(SAGE_RETRIEVAL_CAPABILITY)!;
    const results = await cap.searchSage('anything', { sessionId: 'mine' });
    const ids = results.map((memory) => memory.id);
    expect(ids).toContain('lex-1');
    expect(ids).toContain('vec-1');
    // `vec-2` is session-scoped to a different session: `getSage` happily
    // returns it, so only the JS visibility re-check keeps it out.
    expect(ids).not.toContain('vec-2');
  });

  it('bounds by-id materialization so a remote port is not flooded', async () => {
    const getSage = vi.fn(async (id: string) => makeSage(id, `memory ${id}`));
    const port = makeFakePort({
      retrieval: {
        searchSage: async () => [] as Sage[],
      } as unknown as SageRetrievalCapability,
      surface: { getSage } as unknown as SageSurface,
    });
    const vectorRecall = {
      search: async () =>
        Array.from({ length: 40 }, (_unused, index) => ({
          id: `v${index}`,
          score: 0.95,
          text: `semantic ${index}`,
          tags: [] as string[],
          metadata: { sageId: `m${index}` },
        })),
    };
    const wrapped = wrapMemoryPortWithVectorRecall(port, {
      store: undefined as unknown as VectorMemoryStore,
      vectorRecall,
      maxMaterializations: 5,
    });
    const cap = wrapped.getCapability<SageRetrievalCapability>(SAGE_RETRIEVAL_CAPABILITY)!;
    await cap.searchSage('anything');
    expect(getSage).toHaveBeenCalledTimes(5);
  });

  it('returns undefined when the underlying capability is absent', () => {
    const port = makeFakePort();
    const store = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot: path.join(os.tmpdir(), 'wrap-test-4'),
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
      projectRoot: path.join(os.tmpdir(), 'wrap-test-5'),
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

  it('honors per-query vector recall overrides (weight, minScore, threshold)', async () => {
    const searchSage = vi.fn(async () => [makeSage('m1', 'lexical')]);
    const port = makeFakePort({
      retrieval: { searchSage } as unknown as SageRetrievalCapability,
    });
    const capturedOpts: Array<Record<string, unknown>> = [];
    const vectorRecall = {
      search: vi.fn(async (_query: string, opts: Record<string, unknown>) => {
        capturedOpts.push(opts);
        return [{ id: 'v1', score: 0.9, text: 'lexical', tags: [], metadata: { sageId: 'm1' } }];
      }),
    };
    const wrapped = wrapMemoryPortWithVectorRecall(port, {
      store: undefined as unknown as VectorMemoryStore,
      vectorRecall,
      weight: 0.2,
      threshold: 0.1,
      vectorOnlyThreshold: 0.5,
    });
    const cap = wrapped.getCapability<SageRetrievalCapability>(SAGE_RETRIEVAL_CAPABILITY)!;

    // Per-query overrides
    await cap.searchSage('test query', {
      vectorRecallWeight: 0.7,
      vectorRecallMinScore: 0.85,
      vectorRecallThreshold: 0.95,
    });

    expect(vectorRecall.search).toHaveBeenCalledTimes(1);
    expect(capturedOpts[0]!['threshold']).toBe(0.85);

    // Omitted per-query options fall back to wrapper defaults
    await cap.searchSage('test query 2');
    expect(capturedOpts[1]!['threshold']).toBe(0.1);
  });
});

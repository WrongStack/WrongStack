/**
 * Regression guard for the defect that made vector memory a no-op in every
 * production surface for months without a single error surfacing.
 *
 * Production hosts do not talk to `SqliteSageStore` directly. They hold a
 * `ProjectSageMemoryPort`, which serializes every call to the per-project SAGE
 * daemon with `JSON.stringify` (`encodeSageProjectServerMessage`). The original
 * wrapper put the recall provider — an object with an async `search` method —
 * into the *search options*, and expected the store to fuse:
 *
 *   JSON.stringify({ vectorRecall: { search: fn } })  →  {"vectorRecall":{}}
 *
 * The daemon received a truthy-but-empty object, passed the
 * `if (!opts?.vectorRecall) return lexical` guard, called `.search(...)`, threw
 * `search is not a function` inside the fusion's fail-open `try`, and returned
 * the lexical list. Nothing logged. `searchSageWithBreakdown` reported every
 * hit as `source: 'lexical'`, which is exactly what a correctly-working
 * lexical-only store reports — so no diagnostic could tell the two apart.
 *
 * The tests below put a real JSON round-trip between the wrapper and the
 * "store", which is the only shape that can catch this class of bug. A unit
 * test against an in-process fake passes either way.
 */
import { describe, expect, it } from 'vitest';
import type { MemoryPort } from '@wrongstack/core/types';
import {
  SAGE_RETRIEVAL_CAPABILITY,
  SAGE_SURFACE_CAPABILITY,
  type Sage,
  type SageRetrievalCapability,
  type SageSurface,
} from '@wrongstack/sage';

import { wrapMemoryPortWithVectorRecall, type VectorMemoryStore } from '../src/index.js';

function sage(id: string, text: string, overrides: Partial<Sage> = {}): Sage {
  return {
    id,
    text,
    kind: 'fact',
    scope: 'project',
    status: 'active',
    importance: 0.9,
    confidence: 0.9,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as Sage;
}

const CORPUS: Record<string, Sage> = {
  'lex-1': sage('lex-1', 'The waiting room quarantines a failing provider.'),
  'sem-1': sage('sem-1', 'Retry budgets drain before the wire gate opens.'),
};

/**
 * A port that mimics the daemon boundary: every argument crosses a
 * `JSON.stringify`/`JSON.parse` pair before the "store" sees it, exactly as
 * `encodeSageProjectServerMessage` does on the wire.
 */
function makeIpcPort(): MemoryPort & { lastOptions: unknown } {
  const state = { lastOptions: undefined as unknown };
  const overWire = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;

  const retrieval: Partial<SageRetrievalCapability> = {
    searchSage: async (query: string, options?: unknown) => {
      state.lastOptions = overWire(options);
      // Whatever the wrapper thought it was passing, this is what the daemon
      // actually has to work with.
      const received = state.lastOptions as { vectorRecall?: { search?: unknown } } | null;
      if (received?.vectorRecall && typeof received.vectorRecall.search !== 'function') {
        throw new Error(
          'the daemon received a vectorRecall provider whose search() did not survive JSON',
        );
      }
      return query.includes('quarantine') ? [CORPUS['lex-1']!] : [];
    },
    retrieveForPath: async () => [],
  };
  const surface: Partial<SageSurface> = {
    getSage: async (id: string) => overWire(CORPUS[id] ?? null),
  };

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
      if (cap.id === SAGE_RETRIEVAL_CAPABILITY.id) return retrieval as unknown as T;
      if (cap.id === SAGE_SURFACE_CAPABILITY.id) return surface as unknown as T;
      return undefined;
    },
    get lastOptions() {
      return state.lastOptions;
    },
  };
  return port as unknown as MemoryPort & { lastOptions: unknown };
}

const vectorRecall = {
  search: async () => [
    {
      id: 'v-sem-1',
      score: 0.91,
      text: 'Retry budgets drain before the wire gate opens.',
      tags: [] as string[],
      metadata: { sageId: 'sem-1' },
    },
  ],
};

describe('vector recall across the SAGE daemon IPC boundary', () => {
  it('never sends a function-bearing option over the wire', async () => {
    const port = makeIpcPort();
    const wrapped = wrapMemoryPortWithVectorRecall(port, {
      store: undefined as unknown as VectorMemoryStore,
      vectorRecall,
    });
    const cap = wrapped.getCapability<SageRetrievalCapability>(SAGE_RETRIEVAL_CAPABILITY)!;
    // The port throws if a stripped provider reaches it, so this call
    // completing at all is half the assertion.
    await cap.searchSage('quarantine', { limit: 5 });
    expect((port.lastOptions as Record<string, unknown> | null)?.['vectorRecall']).toBeUndefined();
  });

  it('still returns the semantic-only memory the lexical channel missed', async () => {
    const port = makeIpcPort();
    const wrapped = wrapMemoryPortWithVectorRecall(port, {
      store: undefined as unknown as VectorMemoryStore,
      vectorRecall,
    });
    const cap = wrapped.getCapability<SageRetrievalCapability>(SAGE_RETRIEVAL_CAPABILITY)!;
    const ids = (await cap.searchSage('quarantine', { limit: 5 })).map((memory) => memory.id);
    expect(ids).toContain('lex-1');
    // The whole point: `sem-1` shares no query token and is reachable only
    // through the vector channel plus a by-id resolution over the same wire.
    expect(ids).toContain('sem-1');
  });

  it('reports the semantic channel in the breakdown instead of claiming lexical', async () => {
    const port = makeIpcPort();
    const retrieval = port.getCapability<SageRetrievalCapability>(SAGE_RETRIEVAL_CAPABILITY)!;
    // Give the port the rich variant the daemon implements, so the wrapper
    // takes the breakdown path rather than the flat one.
    (retrieval as { searchSageWithBreakdown?: unknown }).searchSageWithBreakdown = async (
      query: string,
    ) =>
      (await retrieval.searchSage(query)).map((memory, index, all) => ({
        memory,
        vectorScore: null,
        lexicalScore: all.length <= 1 ? 1 : 1 - index / (all.length - 1),
        finalScore: all.length <= 1 ? 1 : 1 - index / (all.length - 1),
        source: 'lexical' as const,
      }));

    const wrapped = wrapMemoryPortWithVectorRecall(port, {
      store: undefined as unknown as VectorMemoryStore,
      vectorRecall,
    });
    const cap = wrapped.getCapability<SageRetrievalCapability>(SAGE_RETRIEVAL_CAPABILITY)!;
    const hits = await cap.searchSageWithBreakdown!('quarantine', { limit: 5 });
    const semantic = hits.find((hit) => hit.memory.id === 'sem-1');
    expect(semantic?.source).toBe('vector');
    expect(semantic?.vectorScore).toBeCloseTo(0.91, 5);
    // A dead semantic channel is indistinguishable from a healthy lexical-only
    // one unless SOMETHING reports a non-lexical source. This assertion is the
    // diagnostic that was missing.
    expect(hits.some((hit) => hit.source !== 'lexical')).toBe(true);
  });
});

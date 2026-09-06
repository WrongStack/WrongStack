/**
 * Tests for the SAGE ⇄ Vector Memory fusion.
 *
 * Pin:
 *  - empty lexical + empty vector → empty result
 *  - lexical-only and vector-only inputs fall through to the surviving channel
 *  - RRF combines both channels without depending on score scale
 *  - vector-only hits are dropped below the `vectorOnlyThreshold`
 *  - standalone vector entries (no `metadata.sageId`) are not promoted
 *  - the function is fail-open: a throwing vector backend returns the lexical list
 *  - `asVectorRecallProvider` adapts a store to the SAGE `VectorRecallProvider`
 *    interface.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  asVectorRecallProvider,
  fuseWithVectorMemory,
  type VectorSearchHit,
  VectorMemoryStore,
} from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function makeStore(): { store: VectorMemoryStore; close: () => void } {
  const projectRoot = path.join(
    os.tmpdir(),
    `wrongstack-vm-fusion-${testRunId}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const store = new VectorMemoryStore({
    provider: new FakeEmbeddingProvider({ dimensions: 32 }),
    projectRoot,
  });
  return { store, close: () => store.close() };
}

function fakeSage(id: string, text: string): import('@wrongstack/sage').Sage {
  return {
    id,
    text,
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    importance: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    anchors: [],
    tags: [],
  } as unknown as import('@wrongstack/sage').Sage;
}

describe('fuseWithVectorMemory', () => {
  it('returns empty when both channels are empty', async () => {
    const result = await fuseWithVectorMemory('anything', []);
    expect(result).toEqual([]);
  });

  it('passes through lexical when no vector channel is provided', async () => {
    const lexical = [fakeSage('a', 'apple'), fakeSage('b', 'banana')];
    const result = await fuseWithVectorMemory('apple', lexical, { vectorWeight: 0.5 });
    expect(result.map((r) => r.memory.id)).toEqual(['a', 'b']);
    expect(result.every((r) => r.source === 'lexical')).toBe(true);
  });

  it('boosts a vector hit that maps to a SAGE memory present in lexical', async () => {
    const { store, close } = makeStore();
    try {
      // Insert a vector entry mirroring a SAGE memory via sageId metadata.
      await store.remember({
        text: 'semantic match for unusual phrasing',
        metadata: { sageId: 'm1' },
      });
      const lexical = [fakeSage('m1', 'semantic match for unusual phrasing')];
      const result = await fuseWithVectorMemory('paraphrase', lexical, {
        store,
        vectorWeight: 0.7,
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.memory.id).toBe('m1');
      expect(result[0]!.source).toBe('both');
      expect(result[0]!.vectorScore).not.toBeNull();
    } finally {
      close();
    }
  });

  it('drops vector-only hits (no corresponding SAGE memory in lexical)', async () => {
    const { store, close } = makeStore();
    try {
      // Vector entry with a sageId, but the lexical list is empty →
      // we have no Sage object to materialize, so the hit is dropped.
      await store.remember({ text: 'high overlap text', metadata: { sageId: 'a' } });
      const result = await fuseWithVectorMemory('high overlap text', [], {
        store,
        vectorOnlyThreshold: 0,
      });
      expect(result).toEqual([]);
    } finally {
      close();
    }
  });

  it('ignores vector entries without metadata.sageId (standalone)', async () => {
    const { store, close } = makeStore();
    try {
      await store.remember({ text: 'standalone entry, no SAGE id' });
      // Lexical list is non-empty but unrelated. The vector hit has no
      // sageId so it cannot be fused into a SAGE object → result is the
      // lexical list unchanged.
      const lexical = [fakeSage('a', 'apple'), fakeSage('b', 'banana')];
      const result = await fuseWithVectorMemory('apple', lexical, { store });
      expect(result.map((r) => r.memory.id)).toEqual(['a', 'b']);
      expect(result.every((r) => r.source === 'lexical')).toBe(true);
    } finally {
      close();
    }
  });

  it('is fail-open when the vector backend throws', async () => {
    const lexical = [fakeSage('a', 'apple')];
    // SageFusionOptions has no `vectorRecall` channel — the throwing backend
    // must ride the `store` option so the failure actually exercises the
    // fail-open catch instead of being silently ignored.
    const brokenStore = {
      search: async () => {
        throw new Error('vector backend down');
      },
    } as unknown as VectorMemoryStore;
    const result = await fuseWithVectorMemory('apple', lexical, {
      store: brokenStore,
    });
    expect(result.map((r) => r.memory.id)).toEqual(['a']);
  });

  it('combines both channels via RRF — neither channel needs scale agreement', async () => {
    const { store, close } = makeStore();
    try {
      // Three SAGE memories; vector store mirrors the first two with sageId.
      await store.remember({ text: 'apple banana cherry', metadata: { sageId: 'a' } });
      await store.remember({ text: 'apple banana mango', metadata: { sageId: 'b' } });
      // 'c' is in lexical only.
      const lexical = [
        fakeSage('a', 'apple banana cherry'),
        fakeSage('b', 'apple banana mango'),
        fakeSage('c', 'apple banana papaya'),
      ];
      const result = await fuseWithVectorMemory('apple banana', lexical, {
        store,
        vectorWeight: 0.3,
      });
      // 'a' and 'b' should both be `both` source; 'c' stays lexical.
      const sources = Object.fromEntries(result.map((r) => [r.memory.id, r.source]));
      expect(sources['a']).toBe('both');
      expect(sources['b']).toBe('both');
      expect(sources['c']).toBe('lexical');
    } finally {
      close();
    }
  });

  it('deduplicates multiple vector hits for the same sageId, keeping the highest score and single RRF rank', async () => {
    const lexical = [
      fakeSage('m1', 'alpha beta'),
      fakeSage('m2', 'gamma delta'),
    ];
    const vectorHits = [
      {
        entry: { id: 'v1', text: 'm1 chunk 1', metadata: { sageId: 'm1' } },
        score: 0.95,
      },
      {
        entry: { id: 'v2', text: 'm1 chunk 2', metadata: { sageId: 'm1' } },
        score: 0.20,
      },
      {
        entry: { id: 'v3', text: 'm2 chunk 1', metadata: { sageId: 'm2' } },
        score: 0.85,
      },
    ] as unknown as VectorSearchHit[];

    const result = await fuseWithVectorMemory('query', lexical, {
      vectorHits,
      vectorWeight: 0.5,
      rrfK: 60,
    });

    const m1 = result.find((r) => r.memory.id === 'm1')!;
    const m2 = result.find((r) => r.memory.id === 'm2')!;

    expect(m1.vectorScore).toBe(0.95);
    // Single RRF contribution for m1 (rank 0 lexical + rank 0 vector)
    const expectedM1Score = 0.5 * (1 / 61) + 0.5 * (1 / 61);
    expect(m1.finalScore).toBeCloseTo(expectedM1Score, 5);

    // m2 vector rank is 1, not 2
    expect(m2.vectorScore).toBe(0.85);
    const expectedM2Score = 0.5 * (1 / 62) + 0.5 * (1 / 62);
    expect(m2.finalScore).toBeCloseTo(expectedM2Score, 5);
  });
});

describe('asVectorRecallProvider', () => {
  let store: VectorMemoryStore;
  let close: () => void;
  beforeEach(() => {
    ({ store, close } = makeStore());
  });
  afterEach(() => {
    close();
  });

  it('adapts the store to the VectorRecallProvider contract', async () => {
    await store.remember({
      text: 'adapter target',
      summary: 'sum',
      tags: ['t1'],
      metadata: { sageId: 'm1' },
    });
    const provider = asVectorRecallProvider(store);
    const hits = await provider.search('adapter', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    const first = hits[0]!;
    expect(first.id).toBeTypeOf('string');
    expect(first.score).toBeGreaterThan(0);
    expect(first.text).toBe('adapter target');
    expect(first.summary).toBe('sum');
    expect(first.tags).toEqual(['t1']);
    expect(first.metadata?.['sageId']).toBe('m1');
  });

  it('forwards the threshold option', async () => {
    await store.remember({ text: 'noisy' });
    const provider = asVectorRecallProvider(store);
    const hits = await provider.search('noisy', { limit: 5, threshold: 0.99 });
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0.99);
    }
  });
});

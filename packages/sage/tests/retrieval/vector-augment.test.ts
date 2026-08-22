/**
 * Tests for `augmentLexicalWithVectorRecall` — the SAGE-side bridge that
 * fuses a lexical candidate set with a parallel semantic recall.
 *
 * Pin:
 *  - empty lexical + empty vector → empty result
 *  - lexical-only fall-through when no vectorRecall is wired
 *  - vector-only hits are dropped below the threshold
 *  - fail-open: any thrown error from the vector backend is swallowed
 *  - both-source hits get summed RRF scores
 *  - hits with no `metadata.sageId` are not promoted into SAGE objects
 */
import { describe, expect, it } from 'vitest';

import {
  augmentLexicalWithVectorRecall,
  type VectorRecallProvider,
} from '../../src/retrieval/vector-augment.js';
import type { Sage } from '../../src/types.js';

function fakeSage(id: string, text: string): Sage {
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
  } as unknown as Sage;
}

function fakeProvider(hits: Array<{ id: string; score: number; text: string; sageId?: string }>): VectorRecallProvider {
  return {
    async search(query, opts) {
      return hits
        .filter((h) => h.text.includes(query) || true)
        .slice(0, opts.limit)
        .map((h) => ({
          id: h.id,
          score: h.score,
          text: h.text,
          tags: [],
          metadata: h.sageId ? { sageId: h.sageId } : {},
        }));
    },
  };
}

describe('augmentLexicalWithVectorRecall', () => {
  it('returns empty when both channels are empty', async () => {
    const result = await augmentLexicalWithVectorRecall('query', []);
    expect(result).toEqual([]);
  });

  it('lexical-only: no vectorRecall → original list passes through', async () => {
    const lexical = [fakeSage('a', 'apple'), fakeSage('b', 'banana')];
    const result = await augmentLexicalWithVectorRecall('apple', lexical);
    expect(result.map((r) => r.memory.id)).toEqual(['a', 'b']);
    expect(result.every((r) => r.source === 'lexical')).toBe(true);
  });

  it('marks `both` when a vector hit maps to a SAGE memory in lexical', async () => {
    const lexical = [fakeSage('a', 'apple'), fakeSage('b', 'banana')];
    const provider = fakeProvider([{ id: 'a', score: 0.9, text: 'apple', sageId: 'a' }]);
    const result = await augmentLexicalWithVectorRecall('apple', lexical, {
      vectorRecall: provider,
    });
    const aHit = result.find((r) => r.memory.id === 'a')!;
    expect(aHit.source).toBe('both');
    expect(aHit.vectorScore).toBe(0.9);
  });

  it('drops vector-only hits when the corresponding SAGE memory is not in lexical', async () => {
    // Without the lexical object, we cannot materialize a Sage — the hit
    // is dropped regardless of score. The vector channel only boosts and
    // re-orders; it does not inject foreign memories.
    const provider = fakeProvider([{ id: 'a', score: 0.95, text: 'apple', sageId: 'a' }]);
    const result = await augmentLexicalWithVectorRecall('apple', [], {
      vectorRecall: provider,
      vectorOnlyThreshold: 0,
    });
    expect(result).toEqual([]);
  });

  it('does not promote hits without metadata.sageId', async () => {
    const lexical = [fakeSage('a', 'apple')];
    const provider = fakeProvider([{ id: 'standalone', score: 0.95, text: 'no sage id' }]);
    const result = await augmentLexicalWithVectorRecall('apple', lexical, {
      vectorRecall: provider,
    });
    expect(result.map((r) => r.memory.id)).toEqual(['a']);
    expect(result[0]!.source).toBe('lexical');
  });

  it('fail-open: throws from the provider fall back to the lexical list', async () => {
    const lexical = [fakeSage('a', 'apple')];
    const broken: VectorRecallProvider = {
      async search() {
        throw new Error('provider down');
      },
    };
    const result = await augmentLexicalWithVectorRecall('apple', lexical, {
      vectorRecall: broken,
    });
    expect(result.map((r) => r.memory.id)).toEqual(['a']);
  });

  it('sums RRF scores when a candidate appears in both channels', async () => {
    const lexical = [fakeSage('a', 'apple'), fakeSage('b', 'banana')];
    const provider = fakeProvider([{ id: 'a', score: 0.9, text: 'apple', sageId: 'a' }]);
    const noAugment = await augmentLexicalWithVectorRecall('apple', lexical);
    const augment = await augmentLexicalWithVectorRecall('apple', lexical, {
      vectorRecall: provider,
    });
    const aScore = augment.find((r) => r.memory.id === 'a')!.finalScore;
    const aBase = noAugment.find((r) => r.memory.id === 'a')!.finalScore;
    expect(aScore).toBeGreaterThan(aBase);
  });

  it('sorts by finalScore descending and caps at `limit`', async () => {
    const lexical = [
      fakeSage('a', 'apple'),
      fakeSage('b', 'banana'),
      fakeSage('c', 'cherry'),
    ];
    const provider = fakeProvider([
      { id: 'a', score: 0.95, text: 'apple', sageId: 'a' },
      { id: 'b', score: 0.7, text: 'banana', sageId: 'b' },
    ]);
    const result = await augmentLexicalWithVectorRecall('apple', lexical, {
      vectorRecall: provider,
      limit: 2,
    });
    expect(result).toHaveLength(2);
    // RRF-summed hits sort before pure-lexical hits at the tail.
    expect(result[0]!.finalScore).toBeGreaterThanOrEqual(result[1]!.finalScore);
  });
});

describe('augmentLexicalWithVectorRecall — vector-only materialization', () => {
  it('materializes a high-threshold vector-only hit when a materializer is supplied', async () => {
    const lexical = [fakeSage('a', 'apple')];
    const hidden = fakeSage('z', 'zurek soup recipe from the family archive');
    const provider = fakeProvider([{ id: 'vz', score: 0.9, text: 'zurek', sageId: 'z' }]);
    const result = await augmentLexicalWithVectorRecall('apple', lexical, {
      vectorRecall: provider,
      vectorOnlyThreshold: 0.8,
      materializeVectorOnly: (id) => (id === 'z' ? hidden : undefined),
    });
    const zHit = result.find((r) => r.memory.id === 'z');
    expect(zHit).toBeDefined();
    expect(zHit!.source).toBe('vector');
    expect(zHit!.vectorScore).toBe(0.9);
    expect(zHit!.lexicalScore).toBeNull();
    // The candidate is the callback's object — the fusion never fabricates a
    // Sage from the provider hit.
    expect(zHit!.memory).toBe(hidden);
  });

  it('keeps the reorder-only contract when no materializer is supplied', async () => {
    // Historical semantics: without a materializer there is no way to
    // materialize a Sage for a vector-only hit, so it is dropped regardless
    // of score or threshold.
    const provider = fakeProvider([{ id: 'vz', score: 0.99, text: 'zurek', sageId: 'z' }]);
    const result = await augmentLexicalWithVectorRecall('apple', [], {
      vectorRecall: provider,
      vectorOnlyThreshold: 0,
    });
    expect(result).toEqual([]);
  });

  it('drops vector-only hits below vectorOnlyThreshold even with a materializer', async () => {
    const hidden = fakeSage('z', 'zurek');
    const provider = fakeProvider([{ id: 'vz', score: 0.5, text: 'zurek', sageId: 'z' }]);
    const result = await augmentLexicalWithVectorRecall('apple', [fakeSage('a', 'apple')], {
      vectorRecall: provider,
      vectorOnlyThreshold: 0.8,
      materializeVectorOnly: () => hidden,
    });
    expect(result.map((r) => r.memory.id)).toEqual(['a']);
    expect(result.every((r) => r.source !== 'vector')).toBe(true);
  });

  it('applies a conservative default floor (0.62) when a materializer is present and no threshold is set', async () => {
    const hidden = fakeSage('z', 'zurek');
    const provider = (score: number) =>
      fakeProvider([{ id: 'vz', score, text: 'zurek', sageId: 'z' }]);
    const weak = await augmentLexicalWithVectorRecall('apple', [], {
      vectorRecall: provider(0.5),
      materializeVectorOnly: () => hidden,
    });
    expect(weak).toEqual([]);
    const strong = await augmentLexicalWithVectorRecall('apple', [], {
      vectorRecall: provider(0.7),
      materializeVectorOnly: () => hidden,
    });
    expect(strong.map((r) => r.memory.id)).toEqual(['z']);
  });

  it('drops the hit when the materializer returns undefined (visibility policy)', async () => {
    const provider = fakeProvider([{ id: 'vz', score: 0.95, text: 'zurek', sageId: 'z' }]);
    const result = await augmentLexicalWithVectorRecall('apple', [fakeSage('a', 'apple')], {
      vectorRecall: provider,
      vectorOnlyThreshold: 0.6,
      materializeVectorOnly: () => undefined,
    });
    expect(result.map((r) => r.memory.id)).toEqual(['a']);
  });

  it('drops the hit when the materializer throws (fail-open)', async () => {
    const provider = fakeProvider([{ id: 'vz', score: 0.95, text: 'zurek', sageId: 'z' }]);
    const result = await augmentLexicalWithVectorRecall('apple', [fakeSage('a', 'apple')], {
      vectorRecall: provider,
      vectorOnlyThreshold: 0.6,
      materializeVectorOnly: () => {
        throw new Error('db closed');
      },
    });
    expect(result.map((r) => r.memory.id)).toEqual(['a']);
  });

  it('does not let an unresolved vector-only hit consume a vector rank', async () => {
    const lexical = [fakeSage('a', 'apple')];
    // Provider order: the dead vector-only hit FIRST, then the boost for
    // 'a'. If the dead entry consumed a rank before being dropped, 'a'
    // would silently receive a worse RRF weight than in the control call.
    const withDeadHit = fakeProvider([
      { id: 'vz', score: 0.95, text: 'zurek', sageId: 'z' },
      { id: 'va', score: 0.9, text: 'apple', sageId: 'a' },
    ]);
    const withoutDeadHit = fakeProvider([{ id: 'va', score: 0.9, text: 'apple', sageId: 'a' }]);
    const materialize = (id: string) => (id === 'z' ? undefined : fakeSage(id, 'x'));
    const withDead = await augmentLexicalWithVectorRecall('apple', lexical, {
      vectorRecall: withDeadHit,
      vectorOnlyThreshold: 0.6,
      materializeVectorOnly: materialize,
    });
    const withoutDead = await augmentLexicalWithVectorRecall('apple', lexical, {
      vectorRecall: withoutDeadHit,
      vectorOnlyThreshold: 0.6,
      materializeVectorOnly: materialize,
    });
    const aWith = withDead.find((r) => r.memory.id === 'a')!;
    const aWithout = withoutDead.find((r) => r.memory.id === 'a')!;
    expect(aWith.finalScore).toBe(aWithout.finalScore);
    expect(withDead.some((r) => r.memory.id === 'z')).toBe(false);
  });
});

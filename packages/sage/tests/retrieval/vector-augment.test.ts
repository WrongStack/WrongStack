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

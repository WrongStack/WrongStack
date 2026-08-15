/**
 * Phase 3: hybrid search engine — vector embedding + RRF fusion tests.
 *
 * Verifies:
 *  - embedText produces deterministic, L2-normalized vectors
 *  - cosine similarity ranks similar symbols higher than dissimilar ones
 *  - RRF correctly merges two ranked lists with the k=60 formula
 *  - encode/decode round-trips a Float32Array through a Buffer losslessly
 */

import { describe, expect, it } from 'vitest';
import {
  RRF_K,
  VECTOR_DIMENSIONS,
  buildRankMap,
  cosineSimilarity,
  decodeVector,
  embedText,
  encodeVector,
  reciprocalRankFusion,
} from '../src/codebase-index/vector-search.js';

describe('embedText', () => {
  it('produces a fixed-length 384-dimensional vector', () => {
    const vec = embedText('verifySession');
    expect(vec.length).toBe(VECTOR_DIMENSIONS);
  });

  it('is deterministic — same input produces the same output', () => {
    const a = embedText('function verifySession(token: string): boolean');
    const b = embedText('function verifySession(token: string): boolean');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('L2-normalizes — the magnitude is 1 (or 0 for empty input)', () => {
    const vec = embedText('some meaningful text content here');
    let mag = 0;
    for (let i = 0; i < vec.length; i++) mag += vec[i]! * vec[i]!;
    expect(Math.sqrt(mag)).toBeCloseTo(1, 5);
  });

  it('produces a zero vector for empty input', () => {
    const vec = embedText('');
    let mag = 0;
    for (let i = 0; i < vec.length; i++) mag += vec[i]! * vec[i]!;
    expect(Math.sqrt(mag)).toBe(0);
  });
});

describe('cosineSimilarity', () => {
  it('is ~1.0 for identical text', () => {
    const a = embedText('verifySession');
    const b = embedText('verifySession');
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('is higher for similar names than for unrelated names', () => {
    const query = embedText('verifySession');
    const similar = embedText('verifySessionToken');
    const unrelated = embedText('deleteUserAccount');
    expect(cosineSimilarity(query, similar)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  it('is ~0 for completely disjoint character sets', () => {
    const a = embedText('aaa');
    const b = embedText('zzz');
    // Very unlikely to share trigrams, so similarity should be near 0
    expect(cosineSimilarity(a, b)).toBeLessThan(0.1);
  });
});

describe('encode/decode', () => {
  it('round-trips a Float32Array through a Buffer', () => {
    const original = embedText('round trip test');
    const encoded = encodeVector(original);
    const decoded = decodeVector(encoded);
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i]!, 5);
    }
  });
});

describe('reciprocalRankFusion', () => {
  it('assigns higher fused score to symbols present in both lists', () => {
    const bm25 = buildRankMap([10, 20, 30]);
    const vec = buildRankMap([30, 20, 40]);

    const fused = reciprocalRankFusion(bm25, vec);
    const scoreMap = new Map(fused);

    // Symbol 30 is rank 2 in BM25 and rank 0 in vector → highest fused score
    // Symbol 20 is rank 1 in both → second highest
    expect(fused[0]![0]).toBe(30);
    expect(fused[1]![0]).toBe(20);
    expect(scoreMap.get(30)!).toBeGreaterThan(scoreMap.get(20)!);
  });

  it('includes symbols from only one list with a single-source score', () => {
    const bm25 = buildRankMap([10, 20]);
    const vec = buildRankMap([30, 40]);

    const fused = reciprocalRankFusion(bm25, vec);
    const ids = fused.map(([id]) => id);
    expect(ids).toContain(10);
    expect(ids).toContain(40);
  });

  it('uses k=60 by default — the formula is 1/(60+rank)', () => {
    const bm25 = buildRankMap([1]);
    const vec = buildRankMap([1]);

    const fused = reciprocalRankFusion(bm25, vec);
    const score = fused[0]![1];
    // rank 0 in both: 1/60 + 1/60 = 2/60
    expect(score).toBeCloseTo(2 / RRF_K, 5);
  });

  it('returns an empty array when both inputs are empty', () => {
    const fused = reciprocalRankFusion(new Map(), new Map());
    expect(fused).toEqual([]);
  });

  it('sorts results descending by fused score', () => {
    const bm25 = buildRankMap([1, 2, 3, 4, 5]);
    const vec = buildRankMap([5, 4, 3, 2, 1]);

    const fused = reciprocalRankFusion(bm25, vec);
    // All symbols are at complementary ranks — symbol 3 (rank 2 in both) should
    // win because it's consistently high in both lists.
    const scores = fused.map(([, score]) => score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });
});

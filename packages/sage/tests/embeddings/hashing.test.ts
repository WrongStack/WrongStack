/**
 * Tests for HashingEmbeddingProvider — deterministic offline embedding.
 *
 * Coverage targets:
 * - constructor validation and metadata accessors (id, dimensions)
 * - embed() batch tokenization → hashing → projection → normalization
 * - empty array returns empty array
 * - deterministic: same input produces same vector
 * - different inputs produce different vectors
 * - empty string token produces zero-vector segment
 * - L2 normalization produces unit-length vectors
 * - sublinear log1p scaling on frequency
 */
import { describe, expect, it } from 'vitest';
import { HashingEmbeddingProvider } from '../../src/embeddings/hashing.js';

describe('HashingEmbeddingProvider', () => {
  describe('constructor and metadata', () => {
    it('uses default dimensions (256) when no options given', () => {
      const p = new HashingEmbeddingProvider();
      expect(p.dimensions).toBe(256);
      expect(p.id).toBe('hashing-v1-256');
    });

    it('accepts custom dimensions', () => {
      const p = new HashingEmbeddingProvider({ dimensions: 128 });
      expect(p.dimensions).toBe(128);
      expect(p.id).toBe('hashing-v1-128');
    });

    it('accepts a custom id', () => {
      const p = new HashingEmbeddingProvider({ dimensions: 64, id: 'my-custom-v1-64' });
      expect(p.id).toBe('my-custom-v1-64');
      expect(p.dimensions).toBe(64);
    });

    it('rejects zero dimensions', () => {
      expect(() => new HashingEmbeddingProvider({ dimensions: 0 })).toThrow();
    });

    it('rejects negative dimensions', () => {
      expect(() => new HashingEmbeddingProvider({ dimensions: -1 })).toThrow();
    });

    it('rejects dimensions above the maximum', () => {
      expect(() => new HashingEmbeddingProvider({ dimensions: 99999 })).toThrow();
    });
  });

  describe('embed() — batch embedding', () => {
    it('returns an array of Float32Arrays', async () => {
      const p = new HashingEmbeddingProvider({ dimensions: 128 });
      const results = await p.embed(['first text', 'second text']);
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r).toBeInstanceOf(Float32Array);
        expect(r.length).toBe(128);
      }
    });

    it('returns empty array for empty input', async () => {
      const p = new HashingEmbeddingProvider({ dimensions: 128 });
      const results = await p.embed([]);
      expect(results).toEqual([]);
    });

    it('handles single text', async () => {
      const p = new HashingEmbeddingProvider({ dimensions: 128 });
      const [vec] = await p.embed(['hello world']);
      expect(vec!.some((v) => v !== 0)).toBe(true);
    });

    it('is deterministic — same texts produce the same vectors', async () => {
      const p = new HashingEmbeddingProvider({ dimensions: 128 });
      const a = await p.embed(['the quick brown fox']);
      const b = await p.embed(['the quick brown fox']);
      expect(a).toEqual(b);
    });

    it('different texts produce different vectors (high probability)', async () => {
      const p = new HashingEmbeddingProvider({ dimensions: 128 });
      const [a] = await p.embed(['cats']);
      const [b] = await p.embed(['dogs']);
      let allSame = true;
      for (let i = 0; i < a!.length; i++) {
        if (a![i] !== b![i]) {
          allSame = false;
          break;
        }
      }
      expect(allSame).toBe(false);
    });

    it('empty string produces a zero vector', async () => {
      const p = new HashingEmbeddingProvider({ dimensions: 128 });
      const [vec] = await p.embed(['']);
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec!.length).toBe(128);
      for (let i = 0; i < 128; i++) {
        expect(vec![i]).toBe(0);
      }
    });

    it('produces L2-normalized vectors', async () => {
      const p = new HashingEmbeddingProvider({ dimensions: 128 });
      const [vec] = await p.embed(['a longer text with several words to embed']);
      const magnitude = Math.sqrt(vec!.reduce((sum, v) => sum + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 4);
    });

    it('multiple texts each produce normalized vectors', async () => {
      const p = new HashingEmbeddingProvider({ dimensions: 64 });
      const results = await p.embed(['alpha', 'beta', 'gamma']);
      expect(results).toHaveLength(3);
      for (const vec of results) {
        const magnitude = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        expect(magnitude).toBeCloseTo(1, 4);
      }
    });

    it('batch results are deterministic', async () => {
      const p = new HashingEmbeddingProvider({ dimensions: 128 });
      const a = await p.embed(['one', 'two', 'three']);
      const b = await p.embed(['one', 'two', 'three']);
      expect(a).toEqual(b);
    });

    it('covers the nullish-coalescing branch for null/undefined texts[i]', async () => {
      const p = new HashingEmbeddingProvider({ dimensions: 64 });
      const results = await p.embed(['hello', null as unknown as string, 'world']);
      expect(results).toHaveLength(3);
      expect(results[0]!.some((v) => v !== 0)).toBe(true);
      expect(results[1]!.every((v) => v === 0)).toBe(true);
      expect(results[2]!.some((v) => v !== 0)).toBe(true);
    });
  });

  describe('sublinear scaling', () => {
    it('all embedded vectors are L2-normalized regardless of term frequency', async () => {
      const p = new HashingEmbeddingProvider({ dimensions: 128 });
      const [single] = await p.embed(['word']);
      const [repeated] = await p.embed(['word '.repeat(50).trim()]);
      const singleMag = Math.sqrt(single!.reduce((s, v) => s + v * v, 0));
      const repeatedMag = Math.sqrt(repeated!.reduce((s, v) => s + v * v, 0));
      expect(singleMag).toBeCloseTo(1, 4);
      expect(repeatedMag).toBeCloseTo(1, 4);
    });

    it('non-alphanumeric text produces a zero vector (norm === 0 branch)', async () => {
      const p = new HashingEmbeddingProvider({ dimensions: 128 });
      const [vec] = await p.embed(['!!!']);
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec!.length).toBe(128);
      // Non-alphanumeric tokens are all filtered out → zero vector → norm === 0
      for (let i = 0; i < 128; i++) {
        expect(vec![i]).toBe(0);
      }
    });
  });
});

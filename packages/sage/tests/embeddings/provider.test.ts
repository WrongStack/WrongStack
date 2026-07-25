/**
 * Tests for EmbeddingProvider interface — contract enforcement.
 *
 * Coverage targets:
 * - EmbeddingProvider interface shape (id, dimensions, embed)
 * - HashingEmbeddingProvider conforms to the EmbeddingProvider interface
 * - Custom provider implementations work through the interface
 */
import { describe, expect, it } from 'vitest';
import { HashingEmbeddingProvider } from '../../src/embeddings/hashing.js';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';

describe('EmbeddingProvider interface contract', () => {
  it('HashingEmbeddingProvider satisfies EmbeddingProvider', () => {
    const p: EmbeddingProvider = new HashingEmbeddingProvider({ dimensions: 128 });
    expect(p.id).toBe('hashing-v1-128');
    expect(p.dimensions).toBe(128);
    expect(typeof p.embed).toBe('function');
  });

  it('custom provider can implement EmbeddingProvider', () => {
    class FakeProvider implements EmbeddingProvider {
      readonly id = 'fake-v1-4';
      readonly dimensions = 4;

      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]));
      }
    }

    const p: EmbeddingProvider = new FakeProvider();
    expect(p.id).toBe('fake-v1-4');
    expect(p.dimensions).toBe(4);
  });

  it('embed returns correct number of vectors', async () => {
    class FakeProvider implements EmbeddingProvider {
      readonly id = 'fake-v1-2';
      readonly dimensions = 2;

      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map((t) => new Float32Array([t.length * 0.1, t.length * 0.2]));
      }
    }

    const p = new FakeProvider();
    const results = await p.embed(['a', 'bb', 'ccc']);
    expect(results).toHaveLength(3);
    expect(results[0]!).toBeInstanceOf(Float32Array);
    expect(results[0]![0]).toBeCloseTo(0.1, 5);
    expect(results[2]![1]).toBeCloseTo(0.6, 5);
  });

  it('empty batch returns empty array', async () => {
    class EmptyProvider implements EmbeddingProvider {
      readonly id = 'empty-v1-3';
      readonly dimensions = 3;

      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(() => new Float32Array([1, 0, 0]));
      }
    }

    const p = new EmptyProvider();
    const results = await p.embed([]);
    expect(results).toEqual([]);
  });

  it('HashingEmbeddingProvider embed returns Float32Array instances of correct dimension', async () => {
    const p: EmbeddingProvider = new HashingEmbeddingProvider({ dimensions: 64 });
    const results = await p.embed(['test']);
    expect(results).toHaveLength(1);
    expect(results[0]!).toBeInstanceOf(Float32Array);
    expect(results[0]!.length).toBe(64);
  });
});

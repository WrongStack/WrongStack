/**
 * FakeEmbeddingProvider — deterministic, network-free test provider.
 *
 * Generates a per-text feature vector from the first `dimensions` characters'
 * byte codes (mod 256, mapped into [-1, 1]) and L2-normalizes. This means
 * texts sharing a prefix have similar vectors — enough to verify that
 * search ranking and threshold filtering work, without needing real ML.
 *
 * Tests inject this instead of `TransformersEmbeddingProvider` so they
 * never trigger a model download from the Hugging Face Hub.
 */
import type { EmbeddingProvider } from '@wrongstack/sage';

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly failNext = false;

  constructor(opts: { dimensions?: number; id?: string } = {}) {
    this.dimensions = opts.dimensions ?? 64;
    this.id = opts.id ?? `fake-v1-${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.failNext) {
      throw new Error('FakeEmbeddingProvider: simulated failure');
    }
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    if (!text) return vec;
    const normalized = text.normalize('NFKC').trim();
    for (let i = 0; i < this.dimensions; i++) {
      const byte = i < normalized.length ? normalized.charCodeAt(i) % 256 : 0;
      vec[i] = (byte - 128) / 128;
    }
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < this.dimensions; i++) vec[i] = vec[i]! / norm;
    return vec;
  }
}

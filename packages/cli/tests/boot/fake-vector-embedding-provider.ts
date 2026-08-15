/**
 * Deterministic, network-free fake embedding provider used by the
 * CLI smoke test for the vector_memory tools. Mirrors the same shape
 * the `vector-memory` package tests use, kept local to `packages/cli/tests/boot/`
 * so the CLI test bundle has no cross-package test-only imports.
 */
import type { EmbeddingProvider } from '@wrongstack/sage';

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;

  constructor(opts: { dimensions?: number; id?: string } = {}) {
    this.dimensions = opts.dimensions ?? 32;
    this.id = opts.id ?? `fake-v1-${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
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

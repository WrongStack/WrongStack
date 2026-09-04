/**
 * Pluggable embedding provider for hybrid (lexical + vector) retrieval.
 *
 * The provider is deliberately minimal: anything that can map a batch of
 * texts to equal-length Float32 vectors implements the contract — a local
 * hashing vectorizer (offline, deterministic), an HTTP embedding API, or a
 * local ONNX model. The store owns storage, backfill, and fusion; providers
 * own only text → vector.
 */
export interface EmbeddingProvider {
  /**
   * Stable, versioned identifier (e.g. `hashing-v1-128`). Persisted with
   * every stored vector; changing it invalidates previously embedded rows,
   * so bump it whenever the embedding semantics change.
   */
  readonly id: string;
  /** Vector length this provider emits. Fixed for the provider's lifetime. */
  readonly dimensions: number;
  /** Embed a batch of texts. Must return exactly one vector per input text. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Cosine similarity in [-1, 1]; zero-vector and dimension mismatch safe. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

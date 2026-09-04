/**
 * HashingEmbeddingProvider — deterministic, offline, zero-dependency embedding
 * provider that maps text to fixed-dimension vectors using hash-based feature
 * extraction.
 *
 * No external API, no ONNX model, no network calls. Every text produces the
 * same vector on every call (deterministic). Useful for hybrid lexical+vector
 * retrieval where an approximate vector index improves recall without the
 * operational cost of a real embedding API.
 *
 * ## How it works
 *
 * 1. Tokenize the text on word boundaries (lowercased).
 * 2. For each token, compute a 32-bit hash (FNV-1a).
 * 3. Each hash projects onto N dimensions via `hash % dimensions`.
 * 4. Accumulate term-frequency-like counts per dimension.
 * 5. Apply sublinear scaling (log1p) and L2-normalize.
 *
 * The result is a sparse, weighted lexical vector in the vein of SPLADE or
 * Lexical Weighted Embedding — not as accurate as a trained model, but fast,
 * deterministic, and sufficient for coarse relevance ranking.
 *
 * @see {@link EmbeddingProvider} for the implemented contract.
 */
import { type EmbeddingProvider, cosineSimilarity } from './provider.js';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** Caps each Float32 embedding at 256 KiB before object/array overhead. */
const MAX_DIMENSIONS = 65_536;

/**
 * Compute a 32-bit FNV-1a hash for a string.
 * Uses Math.imul for correct 32-bit integer multiplication.
 * Deterministic across platforms and runtimes.
 */
function fnv1a(text: string): number {
  let hash = FNV_OFFSET_BASIS >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash ^ text.charCodeAt(i)) >>> 0;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export interface HashingEmbeddingProviderOptions {
  /**
   * Vector dimensionality in the range 1–65,536. Default: 256.
   * Higher values add capacity but consume more memory.
   */
  dimensions?: number | undefined;
  /**
   * Unique identifier for this embedding scheme. Bump when changing
   * tokenizer or dimensionality (invalidates stored vectors).
   * Default: `hashing-v1-<dimensions>`.
   */
  id?: string | undefined;
}

export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;

  constructor(opts: HashingEmbeddingProviderOptions = {}) {
    const dim = opts.dimensions ?? 256;
    if (!Number.isInteger(dim) || dim <= 0 || dim > MAX_DIMENSIONS) {
      throw new Error(
        `HashingEmbeddingProvider: dimensions must be an integer from 1 to ${MAX_DIMENSIONS}, got ${dim}`,
      );
    }
    this.dimensions = dim;
    this.id = opts.id ?? `hashing-v1-${this.dimensions}`;
  }

  /**
   * Embed a batch of texts. Each text becomes an L2-normalized Float32Array
   * of `this.dimensions` floats.
   *
   * Implementation: tokenize (lowercase, split on non-alpha), hash each token
   * into a dimension index, accumulate sublinear weights (log1p), then
   * L2-normalize. Deterministic.
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    return this.embedSync(texts);
  }

  /**
   * Synchronous batch embed. The `EmbeddingProvider` contract is async
   * because it has to accommodate HTTP and ONNX backends; this provider is a
   * pure in-process hash with no I/O, so callers on a synchronous hot path
   * (the offline hybrid re-rank, which runs inside a synchronous SQLite read)
   * can use this without an await and without hand-inlining the tokenizer.
   */
  embedSync(texts: string[]): Float32Array[] {
    const results: Float32Array[] = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      results[i] = this.embedOne(texts[i] ?? '');
    }
    return results;
  }

  private embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    if (!text) return vec;

    // Tokenize using Unicode-aware word characters so scripts like
    // Chinese/Japanese/Arabic produce searchable features rather than zero vectors.
    const tokens = text
      .normalize('NFKC')
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length > 0);

    // Accumulate term-frequency-like counts via hash projection
    for (const token of tokens) {
      const hash = fnv1a(token);
      const dim = hash % this.dimensions;
      vec[dim]! += 1;
    }

    // Sublinear scaling: log1p dampens high-frequency tokens
    for (let d = 0; d < this.dimensions; d++) {
      vec[d] = Math.log1p(vec[d]!);
    }

    // L2-normalize
    let norm = 0;
    for (let d = 0; d < this.dimensions; d++) {
      norm += vec[d]! * vec[d]!;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let d = 0; d < this.dimensions; d++) {
        vec[d] = (vec[d]! / norm) as number;
      }
    }

    return vec;
  }
}

export { cosineSimilarity };

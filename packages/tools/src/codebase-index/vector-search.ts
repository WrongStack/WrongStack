/**
 * Phase 3: Hybrid Search Engine — vector embedding layer + RRF fusion.
 *
 * This module provides:
 *  - **Symbol embeddings**: a lightweight character n-gram TF-IDF representation
 *    of each symbol's text (name + signature + doc comment), producing a fixed
 *    384-dimensional float32 vector. No native deps (no ONNX runtime). Designed
 *    to be swapped for a real transformer embedding model in a future phase
 *    without changing the storage or fusion interface.
 *  - **Cosine similarity**: ranks symbols by vector proximity to a query vector.
 *  - **Reciprocal Rank Fusion (RRF)**: merges the ranked lists from BM25/FTS5
 *    trigram search and vector search into a single result set.
 *
 * The RRF formula (k=60, following the original Cormack et al. 2009 paper):
 *   RRF_Score(d) = 1/(k + Rank_BM25(d)) + 1/(k + Rank_Vector(d))
 * where a missing rank from either source is treated as infinity (contributes 0).
 */

/** The constant k in the RRF formula — the standard value from the literature. */
export const RRF_K = 60;

/**
 * P4.11: opt-in gate for the vector embedding layer. Default OFF.
 *
 * The 384-dim char-trigram embedding is lexical similarity — it duplicates
 * what the FTS5 trigram tokenizer already provides — while costing ~1.5 KB
 * of BLOB per symbol on every insert and an embedText() pass per symbol even
 * when the table is unavailable. With the gate off, ranking is BM25/FTS-only
 * (identical result set; the vector layer only re-ordered FTS candidates).
 * Set WRONGSTACK_INDEX_VECTORS=1 to restore the hybrid RRF path; a force
 * reindex repopulates the table for pre-existing symbols.
 */
export function vectorEmbeddingEnabled(): boolean {
  return process.env['WRONGSTACK_INDEX_VECTORS'] === '1';
}

/** Fixed vector dimensionality. 384 matches the proposal's spec. */
export const VECTOR_DIMENSIONS = 384;

/**
 * Character n-grams used for the TF-IDF embedding.
 * We use trigrams (3-char sliding windows), matching the FTS5 tokenizer choice.
 * The hash trick projects each trigram to one of VECTOR_DIMENSIONS buckets,
 * keeping the vector fixed-size regardless of vocabulary size.
 */
const NGRAM_SIZE = 3;

/**
 * Compute a fixed-dimensional embedding of a text string using character
 * n-gram hashing (the "hashing trick").
 *
 * Each n-gram is hashed to a bucket in [0, VECTOR_DIMENSIONS). The bucket's
 * float32 value is incremented by the n-gram's term frequency. After all
 * n-grams are counted, the vector is L2-normalized so cosine similarity
 * reduces to a dot product.
 *
 * This is NOT a semantic embedding — it captures **lexical similarity**
 * (shared substrings). A real embedding model would be dropped in here
 * without changing the storage or fusion interface.
 */
export function embedText(text: string): Float32Array {
  const vec = new Float32Array(VECTOR_DIMENSIONS);

  const normalized = text.toLowerCase().trim();
  if (normalized.length < NGRAM_SIZE) {
    // Pad short text with spaces so at least one trigram is produced.
    const padded = ` ${normalized} `.slice(0, Math.max(NGRAM_SIZE, normalized.length + 2));
    for (let i = 0; i <= padded.length - NGRAM_SIZE; i++) {
      const ngram = padded.slice(i, i + NGRAM_SIZE);
      const bucket = hashNgram(ngram) % VECTOR_DIMENSIONS;
      vec[bucket]! += 1;
    }
  } else {
    for (let i = 0; i <= normalized.length - NGRAM_SIZE; i++) {
      const ngram = normalized.slice(i, i + NGRAM_SIZE);
      const bucket = hashNgram(ngram) % VECTOR_DIMENSIONS;
      vec[bucket]! += 1;
    }
  }

  // L2-normalize so dot product = cosine similarity.
  let norm = 0;
  for (let i = 0; i < VECTOR_DIMENSIONS; i++) {
    norm += vec[i]! * vec[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIMENSIONS; i++) {
      vec[i]! /= norm;
    }
  }

  return vec;
}

/**
 * FNV-1a hash for n-grams. Fast, good distribution for short strings,
 * no dependencies. 32-bit output gives even distribution across 384 buckets.
 */
function hashNgram(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // unsigned 32-bit
}

/** Cosine similarity between two L2-normalized vectors (reduces to dot product). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

/** Serialize a Float32Array to a Buffer for SQLite BLOB storage. */
export function encodeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Deserialize a BLOB from SQLite back to a Float32Array. */
export function decodeVector(buf: Buffer | Uint8Array): Float32Array {
  // node:sqlite returns Uint8Array for BLOB columns, not Buffer. Buffer methods
  // like readFloatLE only exist on Buffer instances. Use DataView for portable
  // float decoding regardless of which type arrives from SQLite.
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const copy = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < copy.length; i++) {
    copy[i] = view.getFloat32(i * 4, true);
  }
  return copy;
}

/**
 * Rank map: symbolId → rank (0-based). Lower rank = more relevant.
 * Built from a search result list (already sorted by relevance).
 */
export type RankMap = Map<number, number>;

/** Build a RankMap from a sorted result list. */
export function buildRankMap(sortedIds: number[]): RankMap {
  const map = new Map<number, number>();
  for (let i = 0; i < sortedIds.length; i++) {
    map.set(sortedIds[i]!, i);
  }
  return map;
}

/**
 * Reciprocal Rank Fusion — merge two ranked lists into a single fused ranking.
 *
 * Each symbol's RRF score is the sum of 1/(k + rank) from each source.
 * Symbols only in one list still contribute 1/(k + rank) from that source.
 * Symbols in neither list are absent from the output.
 *
 * @param bm25Ranks - rank map from BM25/FTS5 trigram search
 * @param vectorRanks - rank map from vector similarity search
 * @param k - the RRF constant (default 60, per Cormack et al.)
 * @returns sorted [symbolId, rrfScore] pairs, descending by score
 */
export function reciprocalRankFusion(
  bm25Ranks: RankMap,
  vectorRanks: RankMap,
  k: number = RRF_K,
): Array<[number, number]> {
  const allIds = new Set<number>([...bm25Ranks.keys(), ...vectorRanks.keys()]);
  const scored: Array<[number, number]> = [];

  for (const id of allIds) {
    const bm25Rank = bm25Ranks.get(id);
    const vecRank = vectorRanks.get(id);

    let score = 0;
    if (bm25Rank !== undefined) score += 1 / (k + bm25Rank);
    if (vecRank !== undefined) score += 1 / (k + vecRank);

    scored.push([id, score]);
  }

  // Sort descending by fused score.
  scored.sort((a, b) => b[1] - a[1]);
  return scored;
}

/**
 * Soft hybrid re-rank: blend hashing-embedding cosine into an existing
 * candidate list without a persistent vector index.
 *
 * Fail-open and deterministic. Used after FTS/path retrieval so lexical
 * hits stay available if embedding math fails. This is the *offline*
 * fallback semantic signal — it runs whether or not a real vector store is
 * wired, and it only reorders candidates the lexical channel already found.
 * The real semantic recall (which can surface memories the lexical channel
 * missed entirely) is `augmentLexicalWithVectorRecall`.
 */

import { cosineSimilarity, HashingEmbeddingProvider } from '../embeddings/hashing.js';
import type { Sage } from '../types.js';

const DIMENSIONS = 256;
/**
 * One shared vectorizer instead of a second, hand-inlined copy of FNV-1a +
 * log1p + L2 that has to be kept byte-identical to `HashingEmbeddingProvider`
 * by hand — the two copies had already drifted apart in their tokenizer
 * comments. `embedSync` exists for exactly this caller: re-ranking runs
 * inside a synchronous SQLite read path.
 */
const vectorizer = new HashingEmbeddingProvider({ dimensions: DIMENSIONS });

/**
 * Bounded memo of text → vector.
 *
 * Re-ranking embedded every candidate's text on every search, and the same
 * candidates come back over and over: an injection-heavy session runs this
 * against a largely stable working set of memories, and each miss is a full
 * tokenize + hash + normalize over up to 2000 characters. Insertion-ordered
 * `Map` gives FIFO eviction for free, which is close enough to LRU for a
 * working set this shaped.
 */
const MAX_CACHED_VECTORS = 512;
const vectorCache = new Map<string, Float32Array>();

function embedCached(text: string): Float32Array {
  const cached = vectorCache.get(text);
  if (cached) return cached;
  const vector = vectorizer.embedSync([text])[0] ?? new Float32Array(DIMENSIONS);
  vectorCache.set(text, vector);
  if (vectorCache.size > MAX_CACHED_VECTORS) {
    const oldest = vectorCache.keys().next().value as string | undefined;
    if (oldest !== undefined) vectorCache.delete(oldest);
  }
  return vector;
}

/**
 * Re-order `candidates` by blending original rank position with cosine
 * similarity of hashing embeddings.
 *
 * @param semanticWeight weight of cosine in [0, 1]. Remainder keeps original order.
 */
export function hybridRerankMemories(
  query: string,
  candidates: Sage[],
  semanticWeight = 0.25,
): Sage[] {
  if (candidates.length <= 1) return candidates;
  const q = query.trim();
  if (q.length < 3) return candidates;
  const weight = Math.min(1, Math.max(0, semanticWeight));
  if (weight === 0) return candidates;

  try {
    const queryVec = embedCached(q);
    const n = candidates.length;
    const scored = candidates.map((memory, index) => {
      const vec = embedCached(memory.text.slice(0, 2000));
      const cosine = Math.max(0, cosineSimilarity(queryVec, vec));
      const positionScore = 1 - index / Math.max(1, n);
      const score = (1 - weight) * positionScore + weight * cosine;
      return { memory, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.memory);
  } catch {
    return candidates;
  }
}

/** Direct-module test seam; intentionally not re-exported by the package barrel. */
export const hybridRerankCoverage = {
  clearVectorCache: () => vectorCache.clear(),
  cacheSize: () => vectorCache.size,
};

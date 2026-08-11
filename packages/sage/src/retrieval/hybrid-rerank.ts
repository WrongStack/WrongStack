/**
 * Soft hybrid re-rank: blend hashing-embedding cosine into an existing
 * candidate list without a persistent vector index.
 *
 * Fail-open and deterministic. Used after FTS/path retrieval so lexical
 * hits stay available if embedding math fails.
 */

import { cosineSimilarity } from '../embeddings/provider.js';
import type { Sage } from '../types.js';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const DIMENSIONS = 256;

function hashEmbed(text: string): Float32Array {
  const vec = new Float32Array(DIMENSIONS);
  if (!text) return vec;
  const tokens = text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0);
  for (const token of tokens) {
    let hash = FNV_OFFSET_BASIS >>> 0;
    for (let i = 0; i < token.length; i++) {
      hash = (hash ^ token.charCodeAt(i)) >>> 0;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    const dim = (hash >>> 0) % DIMENSIONS;
    vec[dim]! += 1;
  }
  for (let d = 0; d < DIMENSIONS; d++) vec[d] = Math.log1p(vec[d]!);
  let norm = 0;
  for (let d = 0; d < DIMENSIONS; d++) norm += vec[d]! * vec[d]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let d = 0; d < DIMENSIONS; d++) vec[d] = vec[d]! / norm;
  }
  return vec;
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
    const queryVec = hashEmbed(q);
    const n = candidates.length;
    const scored = candidates.map((memory, index) => {
      const vec = hashEmbed(memory.text.slice(0, 2000));
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

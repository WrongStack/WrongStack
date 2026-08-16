/**
 * Vector-augmented SAGE search — fuse the lexical candidate set with a
 * parallel semantic recall. SAGE stays decoupled from any specific vector
 * backend; the caller supplies a `VectorRecallProvider` that knows how to
 * look up semantic matches (the wrongstack vector-memory package wires one
 * in production).
 *
 * Why a generic interface and not a direct dep on `@wrongstack/vector-memory`:
 *   - Avoids a circular dep (vector-memory already depends on sage).
 *   - Keeps sage usable without an embedding provider at all — the
 *     augmentation is opt-in via the `vectorRecall` field on the options.
 *
 * Fail-open semantics: any exception thrown by the provider is swallowed
 * and the function falls back to the lexical list, preserving the existing
 * retrieval contract.
 */
import type { Sage, VectorRecallProvider } from '../types.js';

const DEFAULT_RRF_K = 60;
/** Default vector weight. Mirrors `hybridRerankMemories` baseline. */
const DEFAULT_VECTOR_WEIGHT = 0.3;
const DEFAULT_LIMIT = 25;
const DEFAULT_VECTOR_FETCH = 50;

/**
 * A semantic-recall provider. `search` returns the top-k semantic matches
 * for `query`, each carrying a `metadata.sageId` field that the fusion
 * function uses to map hits back to SAGE memory ids. The interface stays
 * structural so any backend (vector-memory, a remote embedding API, a
 * test fake) plugs in without subclassing.
 *
 * Declared in `../types.js` (next to `SageSearchOptions.vectorRecall`,
 * which references it) — re-exported here for the historical import path.
 */
export type { VectorRecallProvider } from '../types.js';

export interface VectorAugmentOptions {
  /** Semantic-recall backend. When omitted, the lexical list passes through unchanged. */
  vectorRecall?: VectorRecallProvider | undefined;
  /** Weight of the vector channel in RRF. 0 = pure lexical, 1 = pure vector. Default 0.3. */
  vectorWeight?: number | undefined;
  /** RRF k constant. Default 60. */
  rrfK?: number | undefined;
  /** Cosine threshold forwarded to the vector backend. */
  threshold?: number | undefined;
  /** Cap on the final result list. */
  limit?: number | undefined;
  /**
   * Cosine threshold below which a vector-only hit is dropped. Default 0.
   * Use to keep semantic-only hits from flooding the result when the
   * lexical side already produced strong matches.
   */
  vectorOnlyThreshold?: number | undefined;
}

export interface VectorAugmentHit {
  memory: Sage;
  /** Cosine score from the vector backend, or null if not in that channel. */
  vectorScore: number | null;
  /** Position-derived score from the lexical channel, or null if not in that channel. */
  lexicalScore: number | null;
  /** RRF-style combined score, monotonically higher = better. */
  finalScore: number;
  /** Which channel(s) produced this hit. */
  source: 'lexical' | 'vector' | 'both';
}

function rankScore(index: number, total: number): number {
  if (total <= 1) return 1;
  return 1 - index / Math.max(1, total - 1);
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Augment `lexical` with semantic matches from `vectorRecall`. Both inputs
 * are optional in spirit: the function works with a missing/empty lexical
 * list (pure vector), a missing/empty vector channel (pure lexical), or
 * any combination in between.
 */
export async function augmentLexicalWithVectorRecall(
  query: string,
  lexical: readonly Sage[],
  options: VectorAugmentOptions = {},
): Promise<VectorAugmentHit[]> {
  const weight = clamp01(options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT, DEFAULT_VECTOR_WEIGHT);
  const k = Math.max(1, options.rrfK ?? DEFAULT_RRF_K);
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const vectorOnlyThreshold = options.vectorOnlyThreshold ?? 0;

  let vectorHits: Array<{
    id: string;
    score: number;
    text: string;
    summary?: string | undefined;
    tags: string[];
    metadata?: Record<string, unknown> | undefined;
  }> = [];
  if (options.vectorRecall) {
    try {
      vectorHits = await options.vectorRecall.search(query, {
        limit: Math.max(limit * 2, DEFAULT_VECTOR_FETCH),
        ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
      });
    } catch {
      vectorHits = [];
    }
  }

  // Map lexical by id for O(1) lookup.
  const lexicalById = new Map<string, Sage>();
  for (const memory of lexical) lexicalById.set(memory.id, memory);

  // Pull vector-side sageIds. Hits that don't reference a SAGE memory are
  // standalone (not in the lexical index) — skip them; SAGE callers want
  // SAGE objects, not foreign entries. Hits that reference a SAGE memory
  // but the memory is not present in the lexical list are also dropped:
  // we have no Sage object to materialize, and we don't want to fabricate
  // one from a vector hit (the lexical index is authoritative for shape).
  // The vector channel therefore re-orders / boosts only — it does not
  // add new memories.
  const vectorBySageId = new Map<string, typeof vectorHits[number]>();
  for (const hit of vectorHits) {
    const sageId =
      hit.metadata && typeof hit.metadata['sageId'] === 'string'
        ? (hit.metadata['sageId'] as string)
        : null;
    if (!sageId) continue;
    if (lexicalById.has(sageId) && !vectorBySageId.has(sageId)) {
      vectorBySageId.set(sageId, hit);
    }
  }

  // RRF over both channels.
  const fused = new Map<string, VectorAugmentHit>();

  // Lexical channel.
  for (let i = 0; i < lexical.length; i++) {
    const memory = lexical[i]!;
    const rrf = (1 - weight) * (1 / (k + i + 1));
    fused.set(memory.id, {
      memory,
      vectorScore: null,
      lexicalScore: rankScore(i, lexical.length),
      finalScore: rrf,
      source: 'lexical',
    });
  }

  // Vector channel.
  let vectorRank = 0;
  for (const [sageId, hit] of vectorBySageId) {
    const memory = lexicalById.get(sageId)!;
    const rrf = weight * (1 / (k + vectorRank + 1));
    const existing = fused.get(sageId);
    if (existing) {
      existing.finalScore += rrf;
      existing.vectorScore = hit.score;
      existing.source = 'both';
    } else if (hit.score >= vectorOnlyThreshold) {
      // Vector-only hit: requires standalone threshold to clear.
      fused.set(sageId, {
        memory,
        vectorScore: hit.score,
        lexicalScore: null,
        finalScore: rrf,
        source: 'vector',
      });
    }
    vectorRank++;
  }

  const out = Array.from(fused.values());
  out.sort((a, b) => b.finalScore - a.finalScore);
  return out.slice(0, limit);
}

/**
 * SAGE ⇄ Vector Memory fusion — combine a SAGE lexical candidate set with
 * a parallel semantic recall from the vector store. Operates without
 * modifying the SAGE store; the caller supplies both inputs and gets back
 * a ranked, deduplicated list keyed by the SAGE memory id.
 *
 * The fusion is a Reciprocal Rank Fusion (RRF)-style blend rather than a
 * raw cosine-blend, so it stays robust when one side returns nothing
 * (e.g. embedding provider unavailable).
 *
 * IMPORTANT — the vector channel can only RE-RANK the lexical list, never
 * extend it. A vector hit is kept only when its `metadata.sageId` resolves to
 * a memory already present in `lexical`, because the caller's lexical list is
 * the authoritative source of `Sage` objects and this function will not
 * fabricate one (pinned by tests/sage-fusion.test.ts). Therefore:
 *   - `lexical` may be `[]` → the result is `[]`, whatever the vector channel
 *     found. This is NOT a fallback to pure vector ranking.
 *   - `vector` may be `[]` → fusion falls back to pure lexical ranking.
 *   - either may be `undefined` → fusion silently drops that channel.
 *
 * The vector store is queried separately via `vectorStore.search(query)`,
 * so callers that have already done so can pass the hits directly. When
 * `vectorHits` is omitted, the function queries the store itself.
 */
import type { Sage, VectorRecallProvider } from '@wrongstack/sage';

import type { VectorMemoryStore } from './store.js';
import type { VectorSearchHit } from './types.js';

const DEFAULT_RRF_K = 60;
/** Default `vectorWeight` mirrors SAGE's `hybridRerankMemories` default. */
const DEFAULT_VECTOR_WEIGHT = 0.3;

export interface SageFusionOptions {
  /** Vector store queried for additional semantic recall. Optional. */
  store?: VectorMemoryStore | undefined;
  /** Pre-computed vector hits. Skip the embedded `store.search()` call. */
  vectorHits?: readonly VectorSearchHit[] | undefined;
  /**
   * Weight of the vector channel in the final score. 0 = pure lexical
   * order, 1 = pure vector order. Default 0.3.
   */
  vectorWeight?: number | undefined;
  /**
   * Reciprocal-Rank-Fusion k constant. Lower values amplify the top hits
   * of each channel; higher values flatten the curve. Default 60.
   */
  rrfK?: number | undefined;
  /** Cosine threshold forwarded to `store.search()` when querying internally. */
  threshold?: number | undefined;
  /** Hard cap on the final fused result list. */
  limit?: number | undefined;
  /**
   * Cosine threshold below which a vector-only hit is dropped (no lexical
   * counterpart to lift it). Default 0 — keep all, let RRF decide.
   *
   * Currently inert: vector-only hits cannot occur (see the module docstring),
   * so nothing ever reaches this threshold. Kept for API stability and for
   * the day the vector channel is allowed to extend the candidate set.
   */
  vectorOnlyThreshold?: number | undefined;
}

export interface SageFusionHit {
  memory: Sage;
  /** 0..1, 0 if the candidate only appeared in the lexical channel. */
  vectorScore: number | null;
  /** 0..1, 0 if the candidate only appeared in the vector channel. */
  lexicalScore: number | null;
  /** 0..1, monotonically higher = better. */
  finalScore: number;
  /**
   * Where the candidate came from. `'vector'` is currently unreachable —
   * every candidate originates in the lexical list (see the module
   * docstring); the vector channel only upgrades one to `'both'`.
   */
  source: 'lexical' | 'vector' | 'both';
}

interface LexicalCandidate {
  memory: Sage;
  /** 1 / rank (0-indexed). 1 for the top hit, 1/2 for second, etc. */
  rankScore: number;
  /** Map of the lexical score (0..1) for diagnostics. */
  lexicalScore: number;
}

function lexicalRankScore(index: number, total: number): number {
  if (total <= 1) return 1;
  return 1 - index / Math.max(1, total - 1);
}

function vectorRankScore(index: number, total: number): number {
  if (total <= 1) return 1;
  return 1 - index / Math.max(1, total - 1);
}

/**
 * Fuse lexical and vector recall into a single ranked list. The vector
 * channel pulls additional memories the lexical index missed (semantic
 * recall), and the lexical channel pulls precise matches the embedding
 * model would under-rank (rare-token recall).
 *
 * Returned order is `finalScore` descending, capped at `limit`.
 */
export async function fuseWithVectorMemory(
  query: string,
  lexical: readonly Sage[],
  options: SageFusionOptions = {},
): Promise<SageFusionHit[]> {
  const weight = clamp01(options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT);
  const k = options.rrfK ?? DEFAULT_RRF_K;
  const limit = options.limit ?? 25;
  const vectorOnlyThreshold = options.vectorOnlyThreshold ?? 0;

  // Resolve the vector channel.
  let vectorHits: VectorSearchHit[] = [];
  if (options.vectorHits) {
    vectorHits = [...options.vectorHits];
  } else if (options.store) {
    try {
      vectorHits = await options.store.search(query, {
        ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
        limit: Math.max(limit * 2, 50),
      });
    } catch {
      vectorHits = [];
    }
  }

  // Map vector hits to Sage memories via metadata.sageId (set by
  // syncFromSage). Memories without a sageId stay unreachable from this
  // fusion — they're standalone vector entries, not mirrored SAGE data.
  const sageById = new Map<string, Sage>();
  for (const memory of lexical) sageById.set(memory.id, memory);

  // Build the lexical-side rank list.
  const lexicalRanked: LexicalCandidate[] = lexical.map((memory, index) => ({
    memory,
    rankScore: lexicalRankScore(index, lexical.length),
    lexicalScore: lexicalRankScore(index, lexical.length),
  }));

  // Build the vector-side rank list, only including hits that map to a
  // SAGE memory present in the lexical list (otherwise fusion would
  // inject foreign Sage objects the caller never asked for).
  // Deduplicate by sageId so each SAGE memory has exactly one vector rank
  // (its highest-scoring hit), preventing duplicate RRF score accumulation.
  const vectorRanked: Array<{ memory: Sage; vectorScore: number }> = [];
  const seenVectorSageIds = new Set<string>();
  for (let i = 0; i < vectorHits.length; i++) {
    const hit = vectorHits[i]!;
    const sageId = (hit.entry.metadata as Record<string, unknown> | undefined)?.['sageId'];
    if (typeof sageId !== 'string' || seenVectorSageIds.has(sageId)) continue;
    const memory = sageById.get(sageId);
    if (!memory) continue;
    seenVectorSageIds.add(sageId);
    vectorRanked.push({ memory, vectorScore: hit.score });
  }

  // RRF over both channels. RRF (k + rank) is order-agnostic of score
  // scale — lexical ranks and vector scores live on different scales,
  // and RRF doesn't care.
  const fused = new Map<string, SageFusionHit>();
  for (let i = 0; i < lexicalRanked.length; i++) {
    const c = lexicalRanked[i]!;
    const rrf = (1 - weight) * (1 / (k + i + 1));
    fused.set(c.memory.id, {
      memory: c.memory,
      vectorScore: null,
      lexicalScore: c.lexicalScore,
      finalScore: rrf,
      source: 'lexical',
    });
  }
  for (let i = 0; i < vectorRanked.length; i++) {
    const v = vectorRanked[i]!;
    const rrf = weight * (1 / (k + i + 1));
    const existing = fused.get(v.memory.id);
    if (existing) {
      existing.finalScore += rrf;
      existing.vectorScore = v.vectorScore;
      existing.source = 'both';
    } else if (v.vectorScore >= vectorOnlyThreshold) {
      // Vector-only hit: must clear the standalone threshold.
      fused.set(v.memory.id, {
        memory: v.memory,
        vectorScore: v.vectorScore,
        lexicalScore: null,
        finalScore: rrf,
        source: 'vector',
      });
    }
  }

  const out = Array.from(fused.values());
  out.sort((a, b) => b.finalScore - a.finalScore);
  return out.slice(0, limit);
}

/**
 * Wrap a `VectorMemoryStore` as a `VectorRecallProvider` so it can be
 * passed to `searchSage({ vectorRecall })` and friends. The adapter is
 * intentionally thin: it forwards `search` to `store.search()` and
 * flattens the result into the structural shape the sage retrieval
 * module expects.
 *
 * Caller responsibility: ensure the vector store has been warm-started
 * via `startFirstBootSageSync()` (or equivalent) so vector hits carry
 * `metadata.sageId` and can be fused with the lexical list.
 */
export function asVectorRecallProvider(store: VectorMemoryStore): VectorRecallProvider {
  return {
    async search(query, opts) {
      const hits = await store.search(query, {
        limit: opts.limit,
        ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      });
      return hits.map((h) => ({
        id: h.entry.id,
        score: h.score,
        text: h.entry.text,
        ...(h.entry.summary ? { summary: h.entry.summary } : {}),
        tags: h.entry.tags,
        ...(h.entry.metadata ? { metadata: h.entry.metadata } : {}),
      }));
    },
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VECTOR_WEIGHT;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// Re-export so callers can `import { vectorRankScore }` for tests.
export const __testing = { lexicalRankScore, vectorRankScore, clamp01 };

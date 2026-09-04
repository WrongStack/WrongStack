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
 * Conservative default cosine floor for vector-only admission when a
 * materializer is present but the caller did not set `vectorOnlyThreshold`.
 * The option's historical "default 0" was written while the vector-only
 * branch was unreachable; with recall live, 0 would materialize every
 * semantic hit the lexical channel missed, flooding the tail. 0.62 is a
 * deliberate "clearly related" floor for MiniLM-class models — tune with
 * `/memory race` evidence.
 */
const DEFAULT_VECTOR_ONLY_THRESHOLD = 0.62;
/**
 * Default cap on `materializeVectorOnly` calls per fusion. Chosen so a
 * remote materializer costs at most a dozen round-trips even when the whole
 * vector fetch window is semantic-only — well above the 8-hint injection
 * budget the results feed.
 */
const DEFAULT_MAX_MATERIALIZATIONS = 12;

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
   * lexical side already produced strong matches. Only meaningful when
   * `materializeVectorOnly` can admit such hits — without it, vector-only
   * hits are always dropped regardless of this floor.
   */
  vectorOnlyThreshold?: number | undefined;
  /**
   * Resolve a vector-only hit's SAGE object by id. When supplied,
   * vector-only hits scoring at or above `vectorOnlyThreshold` are
   * materialized into the candidate pool (source `'vector'`) instead of
   * being dropped — the semantic channel can then surface memories the
   * lexical index missed entirely (paraphrases, synonyms, cross-file
   * concepts). The callback owns ALL visibility policy (status,
   * contextPolicy, audience, scope, session ownership); returning
   * `undefined` or throwing drops the hit without failing the fusion.
   * Callbacks are invoked CONCURRENTLY (one call per classified hit, via
   * `Promise.all`) — an implementation must be safe for parallel calls.
   * Omit to keep the historical reorder-only contract, where the vector
   * channel could only boost memories the lexical channel already found.
   */
  materializeVectorOnly?:
    | ((sageId: string) => Sage | undefined | Promise<Sage | undefined>)
    | undefined;
  /**
   * Upper bound on how many vector-only hits are handed to
   * `materializeVectorOnly`. Default {@link DEFAULT_MAX_MATERIALIZATIONS}.
   *
   * Load-bearing when the materializer is remote. The in-process store
   * resolves a vector-only hit with one prepared-statement `get()`, so the
   * fan-out is free and the historical code had no bound. The client-side
   * fusion used when SAGE runs in the per-project daemon resolves each hit
   * with an IPC round-trip instead, and the vector channel is fetched at
   * `max(limit * 2, 50)` — an unbounded fan-out there would put ~50
   * concurrent requests on the daemon's single event loop for one search.
   * Hits are already in provider (cosine-descending) order, so the cap keeps
   * the strongest semantic candidates and drops the tail.
   */
  maxMaterializations?: number | undefined;
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
  const vectorOnlyThreshold = options.materializeVectorOnly
    ? (options.vectorOnlyThreshold ?? DEFAULT_VECTOR_ONLY_THRESHOLD)
    : (options.vectorOnlyThreshold ?? 0);

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

  type VectorHit = (typeof vectorHits)[number];

  /**
   * Classify provider hits into the two vector-channel roles, preserving
   * provider order and one rank per distinct sageId:
   *  - `boost` — the sageId is already in the lexical list; the hit adds its
   *    RRF weight and cosine score to that entry.
   *  - `materialize` — a vector-only sageId at/above `vectorOnlyThreshold`
   *    whose Sage object can be resolved via `materializeVectorOnly`.
   * Everything else (no sageId, below-threshold, no materializer) is dropped
   * without entering the rank sequence.
   */
  const classified: Array<{
    sageId: string;
    hit: VectorHit;
    kind: 'boost' | 'materialize';
  }> = [];
  const seenSageIds = new Set<string>();
  const maxMaterializations = Math.max(0, options.maxMaterializations ?? DEFAULT_MAX_MATERIALIZATIONS);
  let materializeBudget = maxMaterializations;
  for (const hit of vectorHits) {
    const sageId =
      hit.metadata && typeof hit.metadata['sageId'] === 'string'
        ? (hit.metadata['sageId'] as string)
        : null;
    if (!sageId || seenSageIds.has(sageId)) continue;
    seenSageIds.add(sageId);
    if (lexicalById.has(sageId)) {
      classified.push({ sageId, hit, kind: 'boost' });
    } else if (
      options.materializeVectorOnly &&
      hit.score >= vectorOnlyThreshold &&
      materializeBudget > 0
    ) {
      materializeBudget--;
      classified.push({ sageId, hit, kind: 'materialize' });
    }
  }

  // Resolve vector-only Sage objects up front. The callback owns ALL
  // visibility policy (status, contextPolicy, audience, scope, session
  // ownership); an undefined result or a throw simply drops the hit — a
  // failing materializer must never break the fail-open fusion contract.
  const materializedById = new Map<string, Sage>();
  if (classified.some((entry) => entry.kind === 'materialize')) {
    await Promise.all(
      classified.map(async (entry) => {
        if (entry.kind !== 'materialize') return;
        try {
          const memory = await options.materializeVectorOnly?.(entry.sageId);
          if (memory) materializedById.set(entry.sageId, memory);
        } catch {
          // Dropped — see the fail-open note above.
        }
      }),
    );
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

  // Vector channel — one rank sequence over the FUSABLE hits, so a boosted
  // lexical hit and a materialized vector-only hit compete on the same RRF
  // curve. Unresolved `materialize` entries are removed BEFORE ranking: a
  // dropped hit must not consume a rank and silently shift every later
  // vector hit to a worse RRF weight.
  const fusable = classified.filter(
    (entry) => entry.kind === 'boost' || materializedById.has(entry.sageId),
  );
  let vectorRank = 0;
  for (const { sageId, hit, kind } of fusable) {
    const rrf = weight * (1 / (k + vectorRank + 1));
    vectorRank++;
    if (kind === 'boost') {
      // Boost entries are guaranteed present: every lexical id got a fused
      // entry above, and `boost` is only classified when lexicalById has it.
      const existing = fused.get(sageId)!;
      existing.finalScore += rrf;
      existing.vectorScore = hit.score;
      existing.source = 'both';
    } else {
      // Presence guaranteed by the `fusable` filter above.
      const memory = materializedById.get(sageId)!;
      fused.set(sageId, {
        memory,
        vectorScore: hit.score,
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

/**
 * Search-channel race — run a query through SAGE (lexical) and the
 * vector store (semantic) independently and surface the overlap and
 * the channel-specific misses. The point of the dual system is
 * precisely this comparison: the operator can SEE that one channel
 * caught a memory the other missed, and tune the RRF weight
 * accordingly.
 *
 * The output is structured for two consumers:
 *  - The WebUI's memory panel uses the `channels` / `overlap` arrays
 *    to render a side-by-side breakdown.
 *  - The CLI `/memory race <query>` command renders a human-readable
 *    summary via `formatSearchRace` in `@wrongstack/cli`.
 *
 * Race is read-only. No writes to either store.
 */
import type { Sage } from '@wrongstack/sage';

import type { VectorMemoryStore } from './store.js';
import type { VectorSearchHit } from './types.js';

export interface SearchRaceChannelHit {
  /** SAGE memory id (the join key — both channels index the same corpus). */
  id: string;
  /** Lexical rank score (0..1) — null on the vector channel. */
  lexicalScore: number | null;
  /** Vector cosine (0..1) — null on the lexical channel. */
  vectorScore: number | null;
  /** Truncated text preview, for human-readable output. */
  preview: string;
}

export interface SearchRaceResult {
  query: string;
  lexicalOnly: SearchRaceChannelHit[];
  vectorOnly: SearchRaceChannelHit[];
  overlap: Array<{
    id: string;
    lexicalScore: number;
    vectorScore: number;
    preview: string;
  }>;
  /**
   * Summary metrics — the whole point of the race is to surface
   * "what would the user have missed if they had only run one
   * channel?" Each ratio is a 0..1 number.
   */
  metrics: {
    /** Memories found by the lexical channel (incl. overlap). */
    lexicalCount: number;
    /** Memories found by the vector channel (incl. overlap). */
    vectorCount: number;
    /** Memories found by both. */
    overlapCount: number;
    /** `lexicalOnly / lexicalCount` — how much of lexical recall is invisible to vector. */
    lexicalOnlyRatio: number;
    /** `vectorOnly / vectorCount` — how much of vector recall is invisible to lexical. */
    vectorOnlyRatio: number;
    /** `overlapCount / max(lexicalCount, vectorCount)` — agreement rate. */
    agreementRatio: number;
  };
}

export interface SearchRaceOptions {
  /** Cap on each channel's result set. Default 20. */
  limit?: number | undefined;
  /** Cosine threshold forwarded to `vectorStore.search`. Default 0. */
  threshold?: number | undefined;
}

function previewText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

/**
 * Run the same query through both channels and compute the overlap.
 * Lexical hits come from the caller (the SAGE surface). Vector hits
 * are queried from the supplied `vectorStore`. Memories are joined
 * by SAGE id, so the race is only meaningful when the vector store
 * has been warm-started via the SAGE mirror.
 *
 * No writes. No events emitted. Safe to run on every TUI refresh.
 */
export async function runSearchRace(
  query: string,
  lexical: readonly Sage[],
  vectorStore: VectorMemoryStore,
  options: SearchRaceOptions = {},
): Promise<SearchRaceResult> {
  const limit = options.limit ?? 20;
  const threshold = options.threshold ?? 0;

  // Vector channel — independent semantic recall.
  let vectorHits: VectorSearchHit[] = [];
  try {
    vectorHits = await vectorStore.search(query, {
      limit,
      ...(threshold > 0 ? { threshold } : {}),
    });
  } catch {
    // Fail-open: treat provider errors as an empty channel rather than
    // throwing the race. The diagnostics block already surfaces model
    // load failures; the race stays usable on the lexical side.
    vectorHits = [];
  }

  // Lexical: by-rank (1.0 for top, 1 - i/(n-1) thereafter). Mirrors
  // the same heuristic the wrapper uses for `searchSageWithBreakdown`
  // so per-result scores stay comparable across the two entry points.
  const lexicalOnly: SearchRaceChannelHit[] = [];
  const vectorOnly: SearchRaceChannelHit[] = [];
  // Intermediate bucket: `vectorScore: null` means "no vector hit seen yet".
  // A real cosine of 0 is a legitimate overlap (the store clamps negatives
  // to 0), so 0 cannot double as the unpatched sentinel.
  const overlap: Array<{
    id: string;
    lexicalScore: number;
    vectorScore: number | null;
    preview: string;
  }> = [];
  const seenIds = new Set<string>();

  const lexicalCapped = lexical.slice(0, limit);
  for (let i = 0; i < lexicalCapped.length; i++) {
    const mem = lexicalCapped[i]!;
    const score = lexicalCapped.length <= 1 ? 1 : 1 - i / Math.max(1, lexicalCapped.length - 1);
    const id = mem.id;
    seenIds.add(id);
    overlap.push({
      id,
      lexicalScore: score,
      vectorScore: null, // patched below when a vector hit carries this id
      preview: previewText(mem.text, 140),
    });
  }
  // Patch vector scores + bucket.
  for (const hit of vectorHits) {
    const sageId = (hit.entry.metadata as Record<string, unknown> | undefined)?.['sageId'];
    if (typeof sageId !== 'string') continue;
    const existing = overlap.find((row) => row.id === sageId);
    if (existing) {
      existing.vectorScore = hit.score;
      continue;
    }
    if (seenIds.has(sageId)) continue;
    seenIds.add(sageId);
    vectorOnly.push({
      id: sageId,
      lexicalScore: null,
      vectorScore: hit.score,
      preview: previewText(hit.entry.text, 140),
    });
  }
  // Move "lexical only" (no vector hit) out of the overlap bucket.
  for (let i = overlap.length - 1; i >= 0; i--) {
    const row = overlap[i]!;
    if (row.vectorScore === null) {
      lexicalOnly.push({
        id: row.id,
        lexicalScore: row.lexicalScore,
        vectorScore: null,
        preview: row.preview,
      });
      overlap.splice(i, 1);
    }
  }

  const lexicalCount = lexicalOnly.length + overlap.length;
  const vectorCount = vectorOnly.length + overlap.length;
  const denom = Math.max(lexicalCount, vectorCount, 1);
  return {
    query,
    lexicalOnly,
    vectorOnly,
    // The sweep above removed every row still carrying a null vectorScore,
    // so every remaining row holds a real number here.
    overlap: overlap as SearchRaceResult['overlap'],
    metrics: {
      lexicalCount,
      vectorCount,
      overlapCount: overlap.length,
      lexicalOnlyRatio: lexicalCount === 0 ? 0 : lexicalOnly.length / lexicalCount,
      vectorOnlyRatio: vectorCount === 0 ? 0 : vectorOnly.length / vectorCount,
      agreementRatio: overlap.length / denom,
    },
  };
}

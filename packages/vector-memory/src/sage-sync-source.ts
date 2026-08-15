/**
 * SageSyncSource adapter over a SAGE `SageSurface`.
 *
 * Cursor-walks `listSagePage({ statuses: ['active'] })` so the whole active
 * corpus can be mirrored into the vector store via `syncFromSage()` without
 * the caller hand-rolling pagination. The walk terminates naturally when
 * `nextCursor` is empty (the canonical "end of corpus" signal) — the
 * historical 5 000 hard cap was removed because it silently truncated
 * large projects, and `nextCursor` already bounds the iteration.
 *
 * A `maxTotal` cap remains available for tests and pathological cases
 * (e.g. a runaway enumerator that never reports `nextCursor: null`); the
 * default is to walk the whole corpus.
 *
 * Privacy note: `sessionId`/`includeAllSessions` are deliberately NOT set.
 * Every SAGE retrieval surface hides owned session-scoped memories from an
 * enumerator that omits them — this adapter keeps that under-report default
 * so one session's private records are never mirrored into the shared,
 * project-scoped vector store.
 */
import type { SageSurface } from '@wrongstack/sage';

import type { SageSyncSource } from './store.js';

/** Sentinel: `maxTotal` left undefined means "walk the whole corpus". */
const DEFAULT_PAGE_SIZE = 500;
const HARD_FLOOR_PAGE = 1;
const HARD_CEILING_PAGE = 500;
/** Defensive ceiling for the optional cap. Picked arbitrarily large. */
const HARD_CEILING_TOTAL = 1_000_000;

export interface SageSurfaceSyncOptions {
  /**
   * Hard cap on total mirrored memories. Omit (or set to `Infinity`) to
   * walk the entire active corpus. Useful for tests that want a bounded
   * walk without depending on `nextCursor` termination.
   */
  maxTotal?: number | undefined;
  /** Page size per `listSagePage` call. Clamped to [1, 500]. */
  pageSize?: number | undefined;
}

/**
 * Build a `SageSyncSource` from any SAGE surface exposing `listSagePage`.
 * The surface capability is obtained via `getSageSurface(memoryPort)` from
 * `@wrongstack/sage`; a `Pick` keeps this adapter honest about what it calls.
 */
export function createSageSurfaceSyncSource(
  sage: Pick<SageSurface, 'listSagePage'>,
  opts: SageSurfaceSyncOptions = {},
): SageSyncSource {
  const pageSize = clamp(opts.pageSize ?? DEFAULT_PAGE_SIZE, HARD_FLOOR_PAGE, HARD_CEILING_PAGE);
  const maxTotal =
    opts.maxTotal === undefined
      ? Number.POSITIVE_INFINITY
      : clamp(opts.maxTotal, 1, HARD_CEILING_TOTAL);
  return {
    async listActiveMemories({ limit }) {
      // `limit` is what `VectorMemoryStore.syncFromSage` asks for (5 000
      // historically). It's now treated as a soft cap — the smaller of
      // `limit` and `maxTotal` bounds the walk; the larger wins when both
      // are set to a sentinel meaning "no cap".
      const requested =
        limit === undefined
          ? maxTotal
          : clamp(limit, 1, maxTotal === Number.POSITIVE_INFINITY ? limit : maxTotal);
      const memories: Array<{
        id: string;
        text: string;
        summary?: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
      }> = [];
      let cursor: string | undefined;
      // Hard stop on no-progress to defend against broken enumerators that
      // never return `nextCursor: null`. The page size is the smallest
      // legitimate progress signal — if a page returned nothing AND we
      // were given a cursor, the upstream is misbehaving; bail.
      let noProgressPages = 0;
      while (memories.length < requested) {
        const remaining = requested - memories.length;
        const page = await sage.listSagePage({
          statuses: ['active'],
          limit: Math.min(pageSize, Math.max(1, remaining)),
          ...(cursor ? { cursor } : {}),
        });
        const rows = page.memories ?? [];
        for (const m of rows) {
          memories.push({
            id: m.id,
            text: m.text,
            ...(m.summary ? { summary: m.summary } : {}),
            ...(m.tags && m.tags.length > 0 ? { tags: m.tags } : {}),
            metadata: {
              sageKind: m.kind,
              sageScope: m.scope,
              importance: m.importance,
              confidence: m.confidence,
            },
          });
        }
        if (!page.nextCursor || rows.length === 0) break;
        if (rows.length === 0) {
          noProgressPages++;
          if (noProgressPages > 3) break;
        } else {
          noProgressPages = 0;
        }
        cursor = page.nextCursor;
      }
      return memories.slice(0, requested);
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

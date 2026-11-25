/**
 * Shared pagination helpers for SAGE list/query operations.
 *
 * Both the legacy JSONL-backed store and the SQLite-backed
 * `SqliteSageStore` independently duplicated the cursor encoding,
 * page-limit clamping, status normalisation, and sort-comparator logic.
 * This module consolidates those pure functions and constants so every
 * backend shares the same paging contract.
 */

import type { Sage, SageStatus } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────

/** Statuses eligible for automatic injection into context. */
export const CONTEXT_STATUSES: SageStatus[] = ['active'];

/** All known lifecycle statuses. */
export const VALID_MEMORY_STATUSES = new Set<SageStatus>([
  'active',
  'stale',
  'superseded',
  'contradicted',
  'archived',
  'deleted',
]);

/** Statuses shown by default in paginated listings (everything except soft-delete trail). */
export const DEFAULT_PAGE_STATUSES: SageStatus[] = [
  'active',
  'stale',
  'superseded',
  'contradicted',
  'archived',
];

/** Hard page-size cap — a single page never exceeds this. */
export const MAX_PAGE_LIMIT = 500;

/** Default page size when the caller omits `limit`. */
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * Default non-page result cap (for `retrieveForPath`, `searchSage`, etc.).
 */
export const DEFAULT_LIST_LIMIT = 20;

// ─── Cursor types and helpers ───────────────────────────────────────────

export interface PageCursor {
  updatedAt: string;
  id: string;
}

/**
 * Encode the last item of a page into an opaque base64url cursor token.
 */
export function encodePageCursor(args: { updatedAt: string; id: string }): string {
  const raw = JSON.stringify({ u: args.updatedAt, i: args.id } satisfies { u: string; i: string });
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Decode an opaque cursor token; returns undefined for missing/malformed input. */
export function decodePageCursor(cursor: string | undefined): PageCursor | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      u?: unknown;
      i?: unknown;
    };
    if (typeof parsed.u === 'string' && typeof parsed.i === 'string') {
      return { updatedAt: parsed.u, id: parsed.i } satisfies PageCursor;
    }
  } catch {
    // Malformed cursor → treat as first page.
  }
  return undefined;
}

// ─── Clamping & normalisation ───────────────────────────────────────────

/**
 * Clamp a requested page size into [1, MAX_PAGE_LIMIT],
 * defaulting to DEFAULT_PAGE_LIMIT. */
export function clampPageLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(limit)));
}

/**
 * Resolve the set of allowed statuses for a page request.
 * When `statuses` is missing / empty the default (all except `deleted`) is used.
 */
export function normalizeListStatuses(
  statuses: SageStatus[] | undefined,
  validStatuses: ReadonlySet<SageStatus> = VALID_MEMORY_STATUSES,
): Set<SageStatus> {
  // `Array.isArray` distinguishes "not provided" (undefined) from
  // "explicitly empty" ([]). An empty array produces an empty result set
  // so the caller requesting zero statuses gets zero matches instead of
  // silently falling through to the default. An empty filtered list from
  // an explicitly-provided array also returns empty — matching the documented
  // contract ("return empty so the caller notices the mismatch").
  if (!Array.isArray(statuses)) return new Set(DEFAULT_PAGE_STATUSES);
  const filtered = statuses.filter((s) => validStatuses.has(s));
  return new Set(filtered);
}

/**
 * Bound a non-pagination limit: clamp into [0, max] with a fallback default.
 * Used by `retrieveForPath`, `searchSage`, etc.
 */
export function boundedLimit(
  limit: number | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  const safeDefault =
    typeof defaultLimit === 'number' && Number.isFinite(defaultLimit)
      ? Math.max(0, Math.floor(defaultLimit))
      : 0;
  const safeMax =
    typeof maxLimit === 'number' && Number.isFinite(maxLimit)
      ? Math.max(0, Math.floor(maxLimit))
      : safeDefault;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return Math.min(safeMax, safeDefault);
  }
  return Math.max(0, Math.min(safeMax, Math.floor(limit)));
}

// ─── Sorting ────────────────────────────────────────────────────────────

/**
 * Sort comparator: `updatedAt DESC, id DESC` (id is the stable tie-breaker).
 *
 * Uses **byte comparison**, not `localeCompare`. ISO-8601 timestamps are
 * pure ASCII and sort lexicographically byte-for-byte; `localeCompare` is
 * locale-aware and can reorder ASCII-only ISO strings across locales
 * (Turkish `i`/`I`, German `ß`/`ss`), producing different page orderings
 * across machines paginating the same store. The result was duplicate or
 * missed items at the pagination walk boundary. Byte comparison is
 * locale-independent and deterministic.
 */
export function compareByUpdatedDesc(a: Sage, b: Sage): number {
  if (a.updatedAt < b.updatedAt) return 1;
  if (a.updatedAt > b.updatedAt) return -1;
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

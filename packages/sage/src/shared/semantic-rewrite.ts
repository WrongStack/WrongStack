import type { Sage } from '../types.js';

/**
 * Apply a semantic change to a memory, always incrementing `revision`
 * and updating `updatedAt`. This is the single canonical entry point
 * for lifecycle rewrites (verification, dedup, session GC, recovery).
 *
 * Callers pass the existing memory and a partial patch. The helper
 * merges, bumps revision, and returns the updated record — ready for
 * `ctx.upsertMemory()`.
 *
 * @param existing - The current memory record from the store
 * @param patch - Partial fields to update (status, freshness, etc.)
 * @param nowIso - ISO timestamp for `updatedAt`
 * @returns A new `Sage` object with `revision + 1` and fresh `updatedAt`
 */
export function applySemanticChange(existing: Sage, patch: Partial<Sage>, nowIso: string): Sage {
  return {
    ...existing,
    ...patch,
    revision: existing.revision + 1,
    updatedAt: nowIso,
  };
}

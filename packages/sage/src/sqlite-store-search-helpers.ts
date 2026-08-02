import { sqliteRowToMemory, CorruptMemoryError } from './sqlite-store-codec.js';
import { encodePageCursor } from './shared/pagination.js';
import type { ListSagePageResult, Sage, SageStats } from './types.js';

export type SqliteMemoryDataRow = { data: string };
export type SqliteCountRow = { status?: string; kind?: string; n: number };
export type SqlitePageRow = { data: string; updated_at: string; id: string };

/**
 * Decode a batch of memory rows, skipping and logging corrupt records.
 *
 * Unlike the old silent-skip behavior, corrupt records now emit a
 * structured warning to stderr so operators can detect data degradation.
 * The records are still skipped (not returned) to preserve the "search
 * is advisory" contract — a corrupt row should not crash the caller.
 */
export function sqliteRowsToMemories(rows: readonly SqliteMemoryDataRow[]): Sage[] {
  const result: Sage[] = [];
  let corruptCount = 0;
  for (const row of rows) {
    try {
      result.push(sqliteRowToMemory(row));
    } catch (err) {
      corruptCount++;
      // Emit a structured warning for each corrupt record so operators
      // can detect data degradation without a crash.
      if (err instanceof CorruptMemoryError) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'sage.corrupt_memory_record',
            message: err.message,
            rawDataPreview: err.rawData.slice(0, 200),
          }),
        );
      } else {
        // JSON parse failure (not a shape validation error)
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'sage.corrupt_memory_json',
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }
  if (corruptCount > 0 && result.length === 0) {
    // All rows were corrupt — this is a health signal, not just noise.
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'sage.all_rows_corrupt_in_batch',
        corruptCount,
      }),
    );
  }
  return result;
}

/**
 * Tokenize a free-text query into FTS5 prefix terms.
 *
 * Strips non-alphanumeric characters so FTS operators (`AND`, `OR`, `NOT`,
 * `"`, `*`, column filters) cannot rewrite the MATCH expression when terms
 * are later joined. Each surviving token is emitted as `token*` (prefix).
 * FTS5 reserved words that slip through as plain tokens are harmless —
 * they match the literal word, not the operator — because the MATCH string
 * never concatenates unescaped user punctuation.
 */
/**
 * Upper bound on prefix terms sent to FTS5 in one MATCH.
 *
 * Each term becomes a branch of a prefix-OR expression, and the cost is
 * superlinear in the branch count: an unclamped 50k-word query built a
 * 50k-branch expression from a single tool call. Recall past a few dozen prefix
 * terms is not meaningfully better, so the clamp costs nothing real (WS-096).
 */
const MAX_FTS_PREFIX_TERMS = 64;

export function ftsPrefixTerms(query: string): string[] {
  const terms: string[] = [];
  for (const term of query.split(/\s+/)) {
    if (!term) continue;
    for (const token of term.split(/[^\p{L}\p{N}_]+/u)) {
      if (!token) continue;
      // Drop pure-numeric noise and single-character tokens that explode
      // the prefix index without improving recall.
      if (token.length < 2) continue;
      terms.push(`${token}*`);
      if (terms.length >= MAX_FTS_PREFIX_TERMS) return terms;
    }
  }
  return terms;
}

export function countRowsByField(rows: readonly SqliteCountRow[], field: 'status' | 'kind'): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = row[field];
    if (key) counts[key] = row.n;
  }
  return counts;
}

export function buildSageStats(input: {
  total: number;
  statusRows: readonly SqliteCountRow[];
  kindRows: readonly SqliteCountRow[];
  edges: number;
}): SageStats {
  return {
    total: input.total,
    byStatus: countRowsByField(input.statusRows, 'status') as SageStats['byStatus'],
    byKind: countRowsByField(input.kindRows, 'kind'),
    edges: input.edges,
  };
}

export function finalizeListSagePage(
  rows: readonly SqlitePageRow[],
  limit: number,
  total: number,
  statusCounts: Record<string, number>,
): ListSagePageResult {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const memories = sqliteRowsToMemories(pageRows);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && lastRow ? encodePageCursor({ updatedAt: lastRow.updated_at, id: lastRow.id }) : null;
  return { memories, nextCursor, total, statusCounts };
}

import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { encodePageCursor } from './shared/pagination.js';
import type { ListSagePageResult, Sage, SageStats } from './types.js';

export type SqliteMemoryDataRow = { data: string };
export type SqliteCountRow = { status?: string; kind?: string; n: number };
export type SqlitePageRow = { data: string; updated_at: string; id: string };

export function sqliteRowsToMemories(rows: readonly SqliteMemoryDataRow[]): Sage[] {
  return rows
    .map((row) => {
      try {
        return sqliteRowToMemory(row);
      } catch {
        return null;
      }
    })
    .filter((memory): memory is Sage => memory !== null);
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

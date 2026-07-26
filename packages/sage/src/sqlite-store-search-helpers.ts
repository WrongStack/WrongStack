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

export function ftsPrefixTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((term) =>
      term
        .split(/[^\p{L}\p{N}_]+/u)
        .filter(Boolean)
        .map((token) => `${token}*`),
    )
    .filter((term): term is string => term !== null);
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

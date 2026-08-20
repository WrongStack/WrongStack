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
      // Quoted, like the sibling builder in codebase-index/writer-search.ts.
      // FTS5 has BAREWORD operators — `AND`, `OR`, `NOT`, `NEAR` — so an
      // unquoted token emitted `… AND* …`, which is a hard `fts5: syntax error`
      // rather than a no-match. The tokenizer above strips quotes already; the
      // replaceAll is belt-and-braces so a quote can never escape the literal.
      terms.push(`"${token.replaceAll('"', '')}"*`);
      if (terms.length >= MAX_FTS_PREFIX_TERMS) return terms;
    }
  }
  return terms;
}

export interface SessionScopeFilter {
  sessionId?: string | undefined;
  includeAllSessions?: boolean | undefined;
}

/**
 * Build the SQL clause + params that enforce session isolation for a
 * retrieval query. Shared by every SQL retrieval surface (search, path,
 * related/graph, audience, unified search) so session-scoped memories can
 * only be seen by their owning session — and by unscoped calls only when
 * they are unowned.
 *
 * Returns `{ clause: '', params: [] }` (no-op) when `includeAllSessions` is
 * true — administrative surfaces opt into cross-session visibility.
 *
 * When `sessionId` is provided:
 *   `(scope != 'session' OR owner_session_id = ?)`
 * Non-session scopes pass; session-scoped memories must match the caller.
 *
 * When neither is set (unscoped call):
 *   `(scope != 'session' OR owner_session_id IS NULL)`
 * Unowned session memories remain visible for backward compatibility; owned
 * session memories are hidden from callers that did not identify themselves.
 *
 * The clause carries a leading `AND ` so it can be appended directly after
 * existing WHERE conditions; callers that join conditions with ` AND `
 * must strip the leading operator.
 *
 * `includeAllSessions` takes precedence over `sessionId` when both are set
 * (administrative opt-out wins).
 *
 * @param opts   - session filter; a subset of each retrieval surface's options.
 * @param prefix - SQL table-alias prefix for the columns (e.g. `'m.'`) when
 *                 the query joins the memories table under an alias.
 *                 Parameterized instead of string-replaced so both variants
 *                 come from one function and cannot diverge.
 */
export function buildSessionClause(
  opts: SessionScopeFilter | undefined,
  prefix = '',
): {
  clause: string;
  params: string[];
} {
  const scopeCol = `${prefix}scope`;
  const ownerCol = `${prefix}owner_session_id`;
  if (opts?.includeAllSessions) return { clause: '', params: [] };
  if (opts?.sessionId) {
    return {
      clause: ` AND (${scopeCol} != 'session' OR ${ownerCol} = ?)`,
      params: [opts.sessionId],
    };
  }
  return {
    clause: ` AND (${scopeCol} != 'session' OR ${ownerCol} IS NULL)`,
    params: [],
  };
}

/**
 * JS twin of `buildSessionClause`, for the one retrieval surface that filters
 * in memory rather than in SQL (`findSqliteMemoriesForFile` scores every
 * anchor of every memory, so it works from a materialized list).
 *
 * It lives beside the SQL builder on purpose: the visibility rule is one rule,
 * and `findMemoriesForFile` originally shipped without any session filter at
 * all — it was the only surface that returned every session's session-scoped
 * memories to any caller. A second, independently-written copy of the rule is
 * how that happens again.
 */
export function isVisibleToSession(
  memory: { scope: string; ownerSessionId?: string | undefined },
  opts: SessionScopeFilter | undefined,
): boolean {
  if (opts?.includeAllSessions) return true;
  if (memory.scope !== 'session') return true;
  if (opts?.sessionId) return memory.ownerSessionId === opts.sessionId;
  return memory.ownerSessionId === undefined || memory.ownerSessionId === null;
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

import {
  type CallSite,
  MODULE_OWNER_NAME,
  type Ref,
  type SymbolKind,
  type SymbolLang,
} from './schema.js';
import type { PrepareStatement } from './writer-graph-queries.js';
import { chunkedIdQuery, MAX_SQL_VARS, resolveIndexedFiles } from './writer-graph-queries.js';
import { inListChunks, padToInBucket, placeholders } from './writer-helpers.js';
import { mapWriterRefRow, type WriterRefRow } from './writer-ref-mapper.js';

/**
 * Declarations in one file, in source order.
 *
 * Ordered by line rather than by any score so the list reads the way the file
 * does — the atlas uses it to describe a file, not to rank within it.
 */
export function getFileSymbolsWithStatement(
  stmt: PrepareStatement,
  file: string,
  limit: number,
): Array<{
  id: number;
  name: string;
  kind: string;
  line: number;
  endLine?: number | undefined;
  isExported?: boolean | undefined;
  signature: string;
}> {
  if (limit <= 0) return [];
  // `<module>` only owns imports; it is listed only for a file that declares
  // nothing else, where it is the file's sole entry.
  const rows = stmt(
    `SELECT id, name, kind, line, end_line, is_exported, signature FROM symbols s
     WHERE file = ? AND NOT (name = '${MODULE_OWNER_NAME}' AND EXISTS (
       SELECT 1 FROM symbols o WHERE o.file = s.file AND o.name <> '${MODULE_OWNER_NAME}'))
     ORDER BY line ASC, name ASC LIMIT ?`,
  ).all(file, limit) as unknown as Array<{
    id: number;
    name: string;
    kind: string;
    line: number;
    end_line?: number | null;
    is_exported?: number | null;
    signature: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    line: r.line,
    ...(typeof r.end_line === 'number' && r.end_line > 0 ? { endLine: r.end_line } : {}),
    ...(typeof r.is_exported === 'number' ? { isExported: r.is_exported === 1 } : {}),
    signature: r.signature,
  }));
}

/** Like chunkedIdQuery but returns a single scalar (COUNT, SUM, …). */
function chunkedIdScalar(
  stmt: PrepareStatement,
  ids: readonly number[],
  buildSql: (placeholders: string) => string,
  extraArgs: readonly (string | number)[] = [],
): number {
  let total = 0;
  let cursor = 0;
  for (const take of inListChunks(ids.length, MAX_SQL_VARS)) {
    const chunk = padToInBucket(ids.slice(cursor, cursor + take));
    cursor += take;
    const sql = buildSql(placeholders(chunk.length));
    const rows = stmt(sql).all(...chunk, ...extraArgs) as Array<{ n: number }>;
    total += rows[0]?.n ?? 0;
  }
  return total;
}

// ─── Enriched call-site queries (by symbol name) ─────────────────────────────

type CallSiteRow = {
  sym_id: number;
  sym_name: string;
  sym_kind: string;
  sym_lang: string;
  sym_file: string;
  sym_line: number;
  sym_signature: string;
  call_type: string;
  ref_line: number;
  /** Hop distance from the seeds (1 = direct); transitive trees only. */
  depth?: number;
};

function mapCallSiteRow(row: CallSiteRow): CallSite {
  return {
    symbol: {
      id: row.sym_id,
      name: row.sym_name,
      kind: row.sym_kind as SymbolKind,
      lang: row.sym_lang as SymbolLang,
      file: row.sym_file,
      line: row.sym_line,
      signature: row.sym_signature,
    },
    callType: row.call_type as CallSite['callType'],
    line: row.ref_line,
  };
}

/**
 * Resolve a symbol name (optionally scoped by file) to matching symbol IDs.
 * When `file` is omitted, all symbols with that name across the project match.
 */
/**
 * Deterministic call-site order: reference line, then location. Transitive
 * CTE rows all carry `ref_line = 0`, so without the file/line tiebreak they
 * fell back to symbol-id order and `limit` kept an arbitrary subset.
 */
function compareCallSiteRows(a: CallSiteRow, b: CallSiteRow): number {
  return (
    a.ref_line - b.ref_line ||
    (a.sym_file < b.sym_file ? -1 : a.sym_file > b.sym_file ? 1 : 0) ||
    a.sym_line - b.sym_line ||
    a.sym_id - b.sym_id
  );
}

function resolveSymbolIds(
  stmt: PrepareStatement,
  symbolName: string,
  file: string | undefined,
): number[] {
  if (!file) {
    const rows = stmt('SELECT id FROM symbols WHERE name = ? ORDER BY id').all(
      symbolName,
    ) as Array<{
      id: number;
    }>;
    return rows.map((r) => r.id);
  }
  const indexedFiles = resolveIndexedFiles(stmt, file);
  if (indexedFiles.length === 0) return [];
  // P4.12: bucketed chunks — one statement when the padded bucket fits,
  // ladder within budget otherwise. The leading name=? bind rides outside
  // the chunking (each chunk repeats the full filter).
  const ids: number[] = [];
  let cursor = 0;
  for (const take of inListChunks(indexedFiles.length, MAX_SQL_VARS)) {
    const files = padToInBucket(indexedFiles.slice(cursor, cursor + take));
    cursor += take;
    const rows = stmt(
      `SELECT id FROM symbols WHERE name = ? AND file IN (${placeholders(files.length)}) ORDER BY id`,
    ).all(symbolName, ...files) as Array<{ id: number }>;
    ids.push(...rows.map((r) => r.id));
  }
  return ids;
}

/** Above this many target files the per-ref file check is skipped (bind budget). */
const MAX_DISAMBIGUATION_FILES = 64;

/**
 * An unresolved ref the name fallback may still attribute to a symbol: not
 * one the import-aware binding pass settled (ref-binding-pass.ts). A name
 * bound to an outside module (`to_file = ''`), or a JS import it could not
 * find in the project, is known NOT to reference any indexed symbol.
 */
const NOT_BOUND_ELSEWHERE_SQL = `(r.to_file IS NULL OR r.to_file <> '')
         AND NOT (r.call_type = 'import' AND r.module IS NOT NULL
                  AND r.lang IN (SELECT lang FROM lang_family WHERE family = 'js'))`;

/**
 * Direct incoming ref rows for `matchIds`.
 *
 * `scopedTargetIds` is set when a `file` filter was widened to every
 * same-named symbol. Widening kept callers that `to_id` misattributed, but it
 * also reported callers PROVABLY bound to another file: `other.ts#helper`
 * listed every caller of `b.ts#helper`. A ref is dropped only on evidence —
 * its own resolved `to_file`, or an import of that name in the caller's file
 * resolved to a different file. Refs without such evidence stay (ambiguous).
 */
function directIncomingRows(
  stmt: PrepareStatement,
  matchIds: readonly number[],
  scopedTargetIds: readonly number[] | null,
): CallSiteRow[] {
  const targetFiles =
    scopedTargetIds === null
      ? []
      : (
          chunkedIdQuery(
            stmt,
            scopedTargetIds,
            (ph) => `SELECT DISTINCT file FROM symbols WHERE id IN (${ph})`,
          ) as Array<{ file: string }>
        ).map((row) => row.file);
  const refine = targetFiles.length > 0 && targetFiles.length <= MAX_DISAMBIGUATION_FILES;
  const fph = refine ? targetFiles.map(() => '?').join(',') : '';
  const evidenceFilter = refine
    ? `AND (r.to_file IS NULL OR r.to_file IN (${fph}))
       AND NOT EXISTS (
         SELECT 1 FROM refs ri JOIN symbols si ON si.id = ri.from_id
         WHERE si.file = s.file AND ri.call_type = 'import' AND ri.to_name = r.to_name
           AND ri.to_file IS NOT NULL AND ri.to_file NOT IN (${fph})
       )`
    : '';
  return chunkedIdQuery(
    stmt,
    matchIds,
    (ph) =>
      `SELECT
         s.id   AS sym_id,
         s.name AS sym_name,
         s.kind AS sym_kind,
         s.lang AS sym_lang,
         s.file AS sym_file,
         s.line AS sym_line,
         s.signature AS sym_signature,
         r.call_type,
         r.line AS ref_line
       FROM refs r
       JOIN symbols s ON s.id = r.from_id
       WHERE r.to_id IN (${ph})
       ${evidenceFilter}
       ORDER BY r.line, r.id`,
    refine ? [...targetFiles, ...targetFiles] : [],
  ) as CallSiteRow[];
}

/**
 * Drop a file's `<module>` import row (direct, or a deeper hop with no edge
 * metadata) when a declaration in the same file is also listed: that row
 * already names the file. Import-only files (barrels, re-exports) keep it —
 * it is their only edge.
 */
function dropRedundantModuleImports(rows: CallSiteRow[]): CallSiteRow[] {
  const isModuleImport = (r: CallSiteRow) =>
    r.sym_name === MODULE_OWNER_NAME && (r.call_type === 'import' || r.call_type === '');
  const used = new Set(rows.filter((r) => !isModuleImport(r)).map((r) => r.sym_file));
  return rows.filter((r) => !isModuleImport(r) || !used.has(r.sym_file));
}

/**
 * Find all symbols that CALL/USE the named target symbol (incoming callers).
 *
 * Returns one `CallSite` per ref edge, with the caller's full metadata so the
 * agent sees file, line, kind, and signature without a second lookup.
 */
export function findIncomingCallsByName(
  stmt: PrepareStatement,
  symbolName: string,
  file: string | undefined,
  limit: number,
): { calls: CallSite[]; symbolFound: boolean; ambiguous: boolean; totalMatches: number } {
  const targetIds = resolveSymbolIds(stmt, symbolName, file);
  if (targetIds.length === 0)
    return { calls: [], symbolFound: false, ambiguous: false, totalMatches: 0 };

  // Ref resolution (writer.ts `resolveRefs`) assigns `to_id` via `MIN(id)`
  // across the ref's language family — it is not file-aware. (JS-family refs
  // with import or same-file evidence are rebound precisely and carry their
  // target's `to_file`, which the evidence filter below keys on; the rest
  // keep the name guess.) When `file` scopes the query but other
  // files also define this name, id-only matching attributes every caller to
  // whichever duplicate holds the lowest id and returns nothing for the rest.
  // Stored refs cannot disambiguate same-named targets, so we must widen to
  // all ids with this name under ambiguity. Flag it so the caller can inform
  // the agent that results may include callers of a different same-named symbol.
  let matchIds = targetIds;
  let ambiguous = false;
  if (file !== undefined) {
    const allNamedIds = resolveSymbolIds(stmt, symbolName, undefined);
    if (allNamedIds.length > targetIds.length) {
      matchIds = allNamedIds;
      ambiguous = true;
    }
  }

  // Also match refs whose to_name resolves to this symbol even if to_id was
  // not filled during index resolution (e.g. cross-language refs).
  // When `file` is scoped, skip the fallback — an unresolved to_name can't be
  // attributed to a specific file's symbol, so including it would leak callers
  // of same-named symbols in other files.
  //
  // The fallback is queried SEPARATELY from the chunked id-query. If it were
  // baked into the chunked WHERE clause, every chunk would repeat the
  // `OR (r.to_id IS NULL AND r.to_name = ?)` predicate and return the same
  // unresolved-ref rows multiple times. Splitting eliminates the duplicate.
  const useFallback = !file;

  const rows = directIncomingRows(stmt, matchIds, ambiguous ? targetIds : null);

  if (useFallback) {
    const fallbackRows = stmt(
      `SELECT
         s.id   AS sym_id,
         s.name AS sym_name,
         s.kind AS sym_kind,
         s.lang AS sym_lang,
         s.file AS sym_file,
         s.line AS sym_line,
         s.signature AS sym_signature,
         r.call_type,
         r.line AS ref_line
       FROM refs r
       JOIN symbols s ON s.id = r.from_id
       WHERE r.to_id IS NULL AND r.to_name = ?
         AND ${NOT_BOUND_ELSEWHERE_SQL}
       ORDER BY r.line, r.id`,
    ).all(symbolName) as CallSiteRow[];
    rows.push(...fallbackRows);
  }

  // Global sort after merge — each chunk sorts independently, so the merged
  // array is not globally ordered. The main query (to_id IN) and fallback
  // (to_id IS NULL) are mutually exclusive, so no dedup is needed.
  const kept = dropRedundantModuleImports(rows).sort(compareCallSiteRows);

  const safeLimit =
    typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : 100;
  const allCalls = kept.map(mapCallSiteRow);
  return {
    calls: allCalls.slice(0, safeLimit),
    symbolFound: true,
    ambiguous,
    totalMatches: allCalls.length,
  };
}

/**
 * Find all symbols that the named source symbol CALLS/USES (outgoing callees).
 *
 * Returns one `CallSite` per ref edge, with the callee's full metadata.
 */
export function findOutgoingCallsByName(
  stmt: PrepareStatement,
  symbolName: string,
  file: string | undefined,
  limit: number,
): { calls: CallSite[]; symbolFound: boolean; unresolvedCount: number; totalMatches: number } {
  const sourceIds = resolveSymbolIds(stmt, symbolName, file);
  if (sourceIds.length === 0)
    return { calls: [], symbolFound: false, unresolvedCount: 0, totalMatches: 0 };

  // Count refs that could not be resolved (to_id IS NULL) so callers know
  // dependencies were silently dropped.
  const unresolvedCount = chunkedIdScalar(
    stmt,
    sourceIds,
    (ph) => `SELECT COUNT(*) AS n FROM refs WHERE from_id IN (${ph}) AND to_id IS NULL`,
  );

  // Query without LIMIT — chunked execution would apply LIMIT per-chunk,
  // leaking past the caller's ceiling. This fetches ALL matching refs then
  // slices to `limit` after merge. Safe because callers cap at 200; a symbol
  // with thousands of callees is rare and the limit protects memory.
  const rows = chunkedIdQuery(
    stmt,
    sourceIds,
    (ph) =>
      `SELECT
         s.id   AS sym_id,
         s.name AS sym_name,
         s.kind AS sym_kind,
         s.lang AS sym_lang,
         s.file AS sym_file,
         s.line AS sym_line,
         s.signature AS sym_signature,
         r.call_type,
         r.line AS ref_line
       FROM refs r
       JOIN symbols s ON s.id = r.to_id
       WHERE r.from_id IN (${ph})
         AND r.to_id IS NOT NULL  -- INNER JOIN already excludes NULL to_id; this is defensive belt-and-suspenders
       ORDER BY r.line, r.id`,
    [],
  ) as CallSiteRow[];

  // Global sort after merge — each chunk sorts independently, so the merged
  // array is not globally ordered. Sort by ref_line then sym_id for determinism.
  rows.sort(compareCallSiteRows);

  const safeLimit =
    typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : 100;
  const calls = rows.map(mapCallSiteRow).slice(0, safeLimit);
  return { calls, symbolFound: true, unresolvedCount, totalMatches: rows.length };
}

// ─── Recursive CTE transitive call-tree queries ─────────────────────────────
//
// These offload graph traversal from JavaScript BFS loops to native SQLite
// recursive CTE execution. The `UNION` (not `UNION ALL`) deduplication breaks
// dependency cycles automatically — a graph with A→B→C→A terminates after 3
// rows rather than looping forever.
//
// They add depth-aware variants to the existing single-level call queries.

/**
 * Hop bound for transitive trees. Unbounded, the closure walked through barrel
 * `<module>` re-exports to the whole repository: on the WrongStack index every
 * symbol had the same 34k "transitive callers".
 */
const MAX_TRANSITIVE_DEPTH = 3;

/**
 * Nearest first: direct edges, then by hop, then by location. The limit is
 * applied after this order, so it can never cut a direct call site — sorting
 * by `ref_line` first put every depth>1 row (line 0) ahead of them.
 */
function compareTreeRows(a: CallSiteRow, b: CallSiteRow): number {
  return (a.depth ?? 1) - (b.depth ?? 1) || compareCallSiteRows(a, b);
}

/**
 * Run a recursive CTE over a potentially large seed-ID set.
 *
 * `chunkedIdQuery` is unsafe for recursive CTEs: each chunk runs an
 * independent closure of the CTE, and transitive edges that cross chunk
 * boundaries are silently dropped. Instead, load all seeds into a temp
 * table and run a single CTE over the full set.
 *
 * For small seed sets (≤900) the temp table is skipped and seeds are
 * inlined via placeholders — cheaper than a CREATE TEMP TABLE round-trip.
 */
function runCteWithSeeds(
  stmt: PrepareStatement,
  seedIds: readonly number[],
  buildSql: (seedSource: string) => string,
): unknown[] {
  if (seedIds.length <= 900) {
    const ph = seedIds.map(() => '?').join(',');
    return stmt(buildSql(ph)).all(...seedIds);
  }
  stmt('DROP TABLE IF EXISTS _cte_seeds').run();
  try {
    stmt('CREATE TEMP TABLE _cte_seeds (id INTEGER PRIMARY KEY)').run();
    for (let i = 0; i < seedIds.length; i += 500) {
      const chunk = seedIds.slice(i, i + 500);
      const ph = chunk.map(() => '(?)').join(',');
      stmt(`INSERT OR IGNORE INTO _cte_seeds (id) VALUES ${ph}`).run(...chunk);
    }
    return stmt(buildSql('SELECT id FROM _cte_seeds')).all();
  } finally {
    stmt('DROP TABLE IF EXISTS _cte_seeds').run();
  }
}

/**
 * Give first-hop rows of a transitive tree the metadata of the edge that
 * actually connects them to the seeds. Only deeper hops keep the `''` / `0`
 * placeholders: a direct caller reported at line 0 read as a real (and wrong)
 * call-site location in codebase-impact-analysis. A real call wins over an
 * import edge of the same pair, then the earliest line.
 */
function annotateDirectEdges(
  stmt: PrepareStatement,
  rows: CallSiteRow[],
  seedIds: readonly number[],
  seedColumn: 'from_id' | 'to_id',
  otherColumn: 'from_id' | 'to_id',
): void {
  if (rows.length === 0) return;
  const edges = chunkedIdQuery(
    stmt,
    [...seedIds],
    (ph) =>
      `SELECT ${otherColumn} AS sym_id, call_type, line
       FROM refs
       WHERE ${seedColumn} IN (${ph}) AND ${otherColumn} IS NOT NULL`,
    [],
  ) as Array<{ sym_id: number; call_type: string; line: number }>;
  const best = new Map<number, { call_type: string; line: number }>();
  for (const edge of edges) {
    const current = best.get(edge.sym_id);
    const edgeIsImport = edge.call_type === 'import';
    const currentIsImport = current?.call_type === 'import';
    if (
      !current ||
      (currentIsImport && !edgeIsImport) ||
      (currentIsImport === edgeIsImport && edge.line < current.line)
    ) {
      best.set(edge.sym_id, { call_type: edge.call_type, line: edge.line });
    }
  }
  for (const row of rows) {
    const edge = best.get(row.sym_id);
    if (!edge) continue;
    row.call_type = edge.call_type;
    row.ref_line = edge.line;
  }
}

/**
 * Transitive incoming-call tree: all symbols that transitively call the target.
 *
 * Anchor: direct callers of the target symbol(s).
 * Recursive: callers of callers, up to `maxDepth` hops.
 *
 * `UNION` (not `UNION ALL`) deduplicates per recursion level, so dependency
 * cycles (A→B→C→A) terminate instead of looping.
 */
export function findTransitiveIncomingCallsByName(
  stmt: PrepareStatement,
  symbolName: string,
  file: string | undefined,
  limit: number,
): { calls: CallSite[]; symbolFound: boolean; ambiguous: boolean; totalMatches: number } {
  const targetIds = resolveSymbolIds(stmt, symbolName, file);
  if (targetIds.length === 0)
    return { calls: [], symbolFound: false, ambiguous: false, totalMatches: 0 };

  let matchIds = targetIds;
  let ambiguous = false;
  if (file !== undefined) {
    const allNamedIds = resolveSymbolIds(stmt, symbolName, undefined);
    if (allNamedIds.length > targetIds.length) {
      matchIds = allNamedIds;
      ambiguous = true;
    }
  }

  // Recursive CTE carrying the hop depth. (node, 2) ≠ (node, 3) defeats UNION
  // deduplication, so cycles are terminated by the MAX_TRANSITIVE_DEPTH bound
  // instead; each node appears at most once per depth and MIN(depth) keeps its
  // nearest hop. The caller-side ref metadata is omitted: a
  // transitive caller's "call_type" is semantically meaningless (the edge that
  // reached it is different from the edge that reached its callee).
  //
  // For large seed sets (>900), chunkedIdQuery would run the CTE per chunk
  // with each chunk building an independent transitive tree — cross-chunk
  // edges are silently dropped. The temp-table approach runs a single CTE
  // over the full seed set.
  // Under a widened file filter the first hop comes from the evidence-filtered
  // direct callers, so the tree does not grow from callers of another file's
  // same-named symbol; otherwise the CTE anchors on the ref edges itself.
  const anchorCallerIds = ambiguous
    ? [...new Set(directIncomingRows(stmt, matchIds, targetIds).map((row) => row.sym_id))]
    : null;
  const cteSql = (seedSource: string) =>
    `WITH RECURSIVE incoming_tree(from_id, depth) AS (
       ${
         anchorCallerIds === null
           ? `SELECT r.from_id, 1
       FROM refs r
       WHERE r.to_id IN (${seedSource})`
           : `SELECT s0.id, 1 FROM symbols s0 WHERE s0.id IN (${seedSource})`
       }

       UNION

       SELECT r.from_id, it.depth + 1
       FROM refs r
       JOIN incoming_tree it ON r.to_id = it.from_id
       WHERE it.depth < ${MAX_TRANSITIVE_DEPTH}
     )
     SELECT
       s.id   AS sym_id,
       s.name AS sym_name,
       s.kind AS sym_kind,
       s.lang AS sym_lang,
       s.file AS sym_file,
       s.line AS sym_line,
       s.signature AS sym_signature,
       '' AS call_type,
       0 AS ref_line,
       MIN(it.depth) AS depth
     FROM incoming_tree it
     JOIN symbols s ON s.id = it.from_id
     GROUP BY s.id
     ORDER BY s.file, s.line`;

  const rows =
    anchorCallerIds !== null && anchorCallerIds.length === 0
      ? []
      : (runCteWithSeeds(stmt, anchorCallerIds ?? matchIds, cteSql) as CallSiteRow[]);
  annotateDirectEdges(stmt, rows, matchIds, 'to_id', 'from_id');

  // Fallback: refs whose to_id was never resolved (cross-language, etc.)
  if (!file) {
    const fallbackRows = stmt(
      `SELECT
         s.id   AS sym_id,
         s.name AS sym_name,
         s.kind AS sym_kind,
         s.lang AS sym_lang,
         s.file AS sym_file,
         s.line AS sym_line,
         s.signature AS sym_signature,
         r.call_type,
         r.line AS ref_line
       FROM refs r
       JOIN symbols s ON s.id = r.from_id
       WHERE r.to_id IS NULL AND r.to_name = ?
         AND ${NOT_BOUND_ELSEWHERE_SQL}
       ORDER BY r.line, r.id`,
    ).all(symbolName) as CallSiteRow[];
    rows.push(...fallbackRows);
  }

  const kept = dropRedundantModuleImports(rows).sort(compareTreeRows);
  const safeLimit =
    typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : 100;
  const allCalls = kept.map(mapCallSiteRow);
  return {
    calls: allCalls.slice(0, safeLimit),
    symbolFound: true,
    ambiguous,
    totalMatches: allCalls.length,
  };
}

/**
 * Transitive outgoing-call tree: all symbols that the target transitively calls.
 *
 * Anchor: direct callees of the target symbol(s).
 * Recursive: callees of callees, up to `maxDepth` hops.
 */
export function findTransitiveOutgoingCallsByName(
  stmt: PrepareStatement,
  symbolName: string,
  file: string | undefined,
  limit: number,
): { calls: CallSite[]; symbolFound: boolean; unresolvedCount: number; totalMatches: number } {
  const sourceIds = resolveSymbolIds(stmt, symbolName, file);
  if (sourceIds.length === 0)
    return { calls: [], symbolFound: false, unresolvedCount: 0, totalMatches: 0 };

  const unresolvedCount = chunkedIdScalar(
    stmt,
    sourceIds,
    (ph) => `SELECT COUNT(*) AS n FROM refs WHERE from_id IN (${ph}) AND to_id IS NULL`,
  );

  // Same temp-table seed handling as findTransitiveIncomingCallsByName.
  const cteSql = (seedSource: string) =>
    `WITH RECURSIVE outgoing_tree(to_id, depth) AS (
       SELECT r.to_id, 1
       FROM refs r
       WHERE r.from_id IN (${seedSource}) AND r.to_id IS NOT NULL

       UNION

       SELECT r.to_id, ot.depth + 1
       FROM refs r
       JOIN outgoing_tree ot ON r.from_id = ot.to_id
       WHERE r.to_id IS NOT NULL AND ot.depth < ${MAX_TRANSITIVE_DEPTH}
     )
     SELECT
       s.id   AS sym_id,
       s.name AS sym_name,
       s.kind AS sym_kind,
       s.lang AS sym_lang,
       s.file AS sym_file,
       s.line AS sym_line,
       s.signature AS sym_signature,
       '' AS call_type,
       0 AS ref_line,
       MIN(ot.depth) AS depth
     FROM outgoing_tree ot
     JOIN symbols s ON s.id = ot.to_id
     GROUP BY s.id
     ORDER BY s.file, s.line`;

  const rows = runCteWithSeeds(stmt, sourceIds, cteSql) as CallSiteRow[];
  annotateDirectEdges(stmt, rows, sourceIds, 'from_id', 'to_id');
  rows.sort(compareTreeRows);

  const safeOutgoingLimit =
    typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : 100;
  const calls = rows.map(mapCallSiteRow).slice(0, safeOutgoingLimit);
  return { calls, symbolFound: true, unresolvedCount, totalMatches: rows.length };
}

export function findRefsToWithStatement(stmt: PrepareStatement, symbolId: number): Ref[] {
  return (
    stmt(
      'SELECT id, from_id, to_name, to_id, call_type, line FROM refs WHERE to_id = ? OR to_name = (SELECT name FROM symbols WHERE id = ?)',
    ).all(symbolId, symbolId) as WriterRefRow[]
  ).map(mapWriterRefRow);
}

export function findRefsFromWithStatement(stmt: PrepareStatement, symbolId: number): Ref[] {
  return (
    stmt('SELECT id, from_id, to_name, to_id, call_type, line FROM refs WHERE from_id = ?').all(
      symbolId,
    ) as WriterRefRow[]
  ).map(mapWriterRefRow);
}
export {
  getFileGraphWithStatement,
  getPackageGraphWithStatement,
  getSymbolGraphWithStatement,
} from './writer-graph-projections.js';

export { getSymbolsByIdsWithStatement } from './writer-graph-queries.js';

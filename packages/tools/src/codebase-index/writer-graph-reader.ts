import type { DatabaseSync } from 'node:sqlite';
import { detectLang } from './languages.js';
import type { CallSite, CodeMapGraph, Ref, SymbolKind, SymbolLang } from './schema.js';
import {
  addWeightedEdge,
  buildFileGraphNodeState,
  buildPackageGraphNodes,
  buildSymbolGraphNodes,
  createPackageLabeller,
  materializeWeightedEdges,
  type WeightedEdgeAccumulator,
  type WriterFileGraphSymbolRow,
  type WriterSymbolGraphRow,
} from './writer-graph-helpers.js';
import {
  indexedFileMatchArgs,
  indexedFileMatchSql,
  inListChunks,
  matchesIndexedPackageFilter,
  padToInBucket,
  placeholders,
} from './writer-helpers.js';
import { mapWriterRefRow, type WriterRefRow } from './writer-ref-mapper.js';

type Statement = ReturnType<DatabaseSync['prepare']>;
type PrepareStatement = (sql: string) => Statement;

/** Stay under typical SQLite SQLITE_MAX_VARIABLE_NUMBER (often 999). */
const MAX_SQL_VARS = 900;

/**
 * Run a query that takes a list of IDs, chunking the IDs so the total
 * placeholder count never exceeds SQLite's variable limit.
 *
 * IMPORTANT: the SQL built by `buildSql` MUST NOT include a `LIMIT` clause.
 * Applying LIMIT per-chunk would silently cap results at the chunk boundary
 * rather than the caller's ceiling. Callers must slice the returned array
 * to enforce their own limit after merge.
 *
 * P4.12: chunk sizes and each chunk's placeholder count come from a
 * powers-of-two ladder + padToInBucket, so `buildSql` resolves to a small
 * fixed set of SQL strings instead of one per distinct id count.
 */
function chunkedIdQuery(
  stmt: PrepareStatement,
  ids: readonly number[],
  buildSql: (placeholders: string) => string,
  extraArgs: readonly (string | number)[] = [],
): unknown[] {
  const results: unknown[] = [];
  let cursor = 0;
  for (const take of inListChunks(ids.length, MAX_SQL_VARS)) {
    const chunk = padToInBucket(ids.slice(cursor, cursor + take));
    cursor += take;
    const sql = buildSql(placeholders(chunk.length));
    results.push(...(stmt(sql).all(...chunk, ...extraArgs) as unknown[]));
  }
  return results;
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
function resolveIndexedFiles(stmt: PrepareStatement, file: string): string[] {
  const rows = stmt(
    `SELECT DISTINCT file FROM symbols WHERE ${indexedFileMatchSql('file')} ORDER BY length(file), file`,
  ).all(...indexedFileMatchArgs(file)) as Array<{ file: string }>;
  return rows.map((row) => row.file);
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
  // across the ref's language family — it is not file-aware. When `file` scopes
  // the query but other
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

  const rows = chunkedIdQuery(
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
       ORDER BY r.line, r.id`,
    [],
  ) as CallSiteRow[];

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
       ORDER BY r.line, r.id`,
    ).all(symbolName) as CallSiteRow[];
    rows.push(...fallbackRows);
  }

  // Global sort after merge — each chunk sorts independently, so the merged
  // array is not globally ordered. The main query (to_id IN) and fallback
  // (to_id IS NULL) are mutually exclusive, so no dedup is needed.
  rows.sort((a, b) => a.ref_line - b.ref_line || a.sym_id - b.sym_id);

  const allCalls = rows.map(mapCallSiteRow);
  return {
    calls: allCalls.slice(0, limit),
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
  rows.sort((a, b) => a.ref_line - b.ref_line || a.sym_id - b.sym_id);

  const calls = rows.map(mapCallSiteRow).slice(0, limit);
  return { calls, symbolFound: true, unresolvedCount, totalMatches: rows.length };
}

// ─── Recursive CTE transitive call-tree queries ─────────────────────────────
//
// These offload graph traversal from JavaScript BFS loops to native SQLite
// recursive CTE execution. The `UNION` (not `UNION ALL`) deduplication breaks
// dependency cycles automatically — a graph with A→B→C→A terminates after 3
// rows rather than looping forever.
//
// Per the proposal §Phase 4, these replace the in-memory BFS in
// `dead-code-scan.ts` and add depth-aware variants to the existing
// single-level call queries.

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

  // Recursive CTE: `UNION` (not `UNION ALL`) deduplicates by `from_id` only,
  // breaking dependency cycles automatically (A→B→C→A terminates after 3 rows).
  // We intentionally do NOT track depth in the CTE columns — including depth
  // breaks UNION deduplication because (node, 2) ≠ (node, 3), so cyclic nodes
  // recur at every depth. The caller-side ref metadata is also omitted: a
  // transitive caller's "call_type" is semantically meaningless (the edge that
  // reached it is different from the edge that reached its callee).
  //
  // For large seed sets (>900), chunkedIdQuery would run the CTE per chunk
  // with each chunk building an independent transitive tree — cross-chunk
  // edges are silently dropped. The temp-table approach runs a single CTE
  // over the full seed set. Mirrors findReachableSymbolIds.
  const cteSql = (seedSource: string) =>
    `WITH RECURSIVE incoming_tree(from_id) AS (
       SELECT r.from_id
       FROM refs r
       WHERE r.to_id IN (${seedSource})

       UNION

       SELECT r.from_id
       FROM refs r
       JOIN incoming_tree it ON r.to_id = it.from_id
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
       0 AS ref_line
     FROM incoming_tree it
     JOIN symbols s ON s.id = it.from_id
     GROUP BY s.id
     ORDER BY s.file, s.line`;

  const rows = runCteWithSeeds(stmt, matchIds, cteSql) as CallSiteRow[];

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
       ORDER BY r.line, r.id`,
    ).all(symbolName) as CallSiteRow[];
    rows.push(...fallbackRows);
  }

  rows.sort((a, b) => a.ref_line - b.ref_line || a.sym_id - b.sym_id);
  const allCalls = rows.map(mapCallSiteRow);
  return {
    calls: allCalls.slice(0, limit),
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
    `WITH RECURSIVE outgoing_tree(to_id) AS (
       SELECT r.to_id
       FROM refs r
       WHERE r.from_id IN (${seedSource}) AND r.to_id IS NOT NULL

       UNION

       SELECT r.to_id
       FROM refs r
       JOIN outgoing_tree ot ON r.from_id = ot.to_id
       WHERE r.to_id IS NOT NULL
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
       0 AS ref_line
     FROM outgoing_tree ot
     JOIN symbols s ON s.id = ot.to_id
     GROUP BY s.id
     ORDER BY s.file, s.line`;

  const rows = runCteWithSeeds(stmt, sourceIds, cteSql) as CallSiteRow[];

  const calls = rows.map(mapCallSiteRow).slice(0, limit);
  return { calls, symbolFound: true, unresolvedCount, totalMatches: rows.length };
}

/**
 * Compute the set of symbol IDs reachable from a set of seed IDs using a
 * recursive CTE. Replaces the in-memory BFS in `dead-code-scan.ts`.
 *
 * The `UNION` (not `UNION ALL`) deduplication breaks dependency cycles
 * automatically: A→B→C→A terminates after 3 rows.
 *
 * Returns a `Set<number>` of all transitively-reachable symbol IDs (including
 * the seeds themselves). Callers subtract this from the full symbol set to
 * find dead code.
 */
export function findReachableSymbolIds(stmt: PrepareStatement, seedIds: number[]): Set<number> {
  if (seedIds.length === 0) return new Set();

  // For large seed sets (>900), chunkedIdQuery would run the CTE per chunk,
  // but each CTE builds its own independent reachability tree — transitive
  // edges that cross chunk boundaries are silently dropped. Instead, load
  // all seeds into a temp table and run a single CTE over the full set.
  if (seedIds.length > 900) {
    stmt('DROP TABLE IF EXISTS _seeds').run();
    try {
      stmt('CREATE TEMP TABLE _seeds (id INTEGER PRIMARY KEY)').run();
      for (let i = 0; i < seedIds.length; i += 500) {
        const chunk = seedIds.slice(i, i + 500);
        const ph = chunk.map(() => '(?)').join(',');
        stmt(`INSERT OR IGNORE INTO _seeds (id) VALUES ${ph}`).run(...chunk);
      }
      const rows = stmt(
        `WITH RECURSIVE reachable(id) AS (
           SELECT id FROM _seeds
           UNION
           SELECT r.to_id
           FROM refs r
           JOIN reachable ON r.from_id = reachable.id
           WHERE r.to_id IS NOT NULL
         )
         SELECT DISTINCT id FROM reachable`,
      ).all() as Array<{ id: number }>;
      return new Set(rows.map((r) => r.id));
    } finally {
      stmt('DROP TABLE IF EXISTS _seeds').run();
    }
  }

  // Small seed set: single CTE with placeholder IN-list
  const ph = seedIds.map(() => '?').join(',');
  const rows = stmt(
    `WITH RECURSIVE reachable(id) AS (
       SELECT id FROM symbols WHERE id IN (${ph})
       UNION
       SELECT r.to_id
       FROM refs r
       JOIN reachable ON r.from_id = reachable.id
       WHERE r.to_id IS NOT NULL
     )
     SELECT DISTINCT id FROM reachable`,
  ).all(...seedIds) as Array<{ id: number }>;

  return new Set(rows.map((r) => r.id));
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

export function getPackageGraphWithStatement(stmt: PrepareStatement): CodeMapGraph {
  const fileCounts = stmt('SELECT file, COUNT(*) AS n FROM symbols GROUP BY file').all() as Array<{
    file: string;
    n: number;
  }>;

  const files = stmt('SELECT DISTINCT file FROM files').all() as { file: string }[];
  const packageOf = readPackageLabeller(stmt);
  const { pkgNodes, fileToPkg } = buildPackageGraphNodes(fileCounts, files, packageOf);

  const refRows = stmt(
    `SELECT r.call_type, sf.file AS from_file, st.file AS to_file, COUNT(*) AS n
       FROM refs r
       JOIN symbols sf ON sf.id = r.from_id
       JOIN symbols st ON st.id = r.to_id
       WHERE r.to_id IS NOT NULL AND r.call_type != 'import'
       GROUP BY r.call_type, sf.file, st.file`,
  ).all() as Array<{ call_type: string; from_file: string; to_file: string; n: number }>;

  const edgeMap = new Map<string, WeightedEdgeAccumulator>();
  for (const r of refRows) {
    const fromPkg = fileToPkg.get(r.from_file) ?? packageOf(r.from_file);
    const toPkg = fileToPkg.get(r.to_file) ?? packageOf(r.to_file);
    if (fromPkg === toPkg) continue;
    const n = Number(r.n) || 0;
    addWeightedEdge(edgeMap, fromPkg, toPkg, r.call_type, n);
  }

  // Import edges resolve to a target file two ways, in priority order:
  // `to_file` (the module specifier resolved against the project's real layout
  // at index time — the only path that works for Go, Python, Rust, JVM, …) and
  // otherwise the file declaring the imported symbol, which covers namespace
  // ecosystems like C# where a specifier names no file at all.
  const importRows = stmt(
    `SELECT s.file AS from_file,
            COALESCE(r.to_file, st.file) AS to_file,
            COUNT(*) AS n
       FROM refs r
       JOIN symbols s ON s.id = r.from_id
       LEFT JOIN symbols st ON st.id = r.to_id
       WHERE r.call_type = 'import'
         AND COALESCE(r.to_file, st.file) IS NOT NULL
       GROUP BY s.file, COALESCE(r.to_file, st.file)`,
  ).all() as Array<{ from_file: string; to_file: string; n: number }>;
  for (const r of importRows) {
    const fromPkg = fileToPkg.get(r.from_file) ?? packageOf(r.from_file);
    const toPkg = fileToPkg.get(r.to_file) ?? packageOf(r.to_file);
    // `to_file` may be an index-time module resolution result outside the
    // `files`/`symbols` tables; its package label can have no node in
    // `pkgNodes`, and materializeWeightedEdges does not create target nodes.
    if (fromPkg === toPkg || !pkgNodes.has(toPkg)) continue;
    const n = Number(r.n) || 0;
    addWeightedEdge(edgeMap, fromPkg, toPkg, 'import', n);
  }

  const edges = materializeWeightedEdges(edgeMap, 'pkg');
  return { nodes: [...pkgNodes.values()], edges };
}

/**
 * `file → package` from the labels the indexer stored, with the path-shape
 * fallback for rows an older index left blank.
 */
function readPackageLabeller(stmt: PrepareStatement): (file: string) => string {
  const rows = stmt("SELECT file, package FROM files WHERE package != ''").all() as Array<{
    file: string;
    package: string;
  }>;
  return createPackageLabeller(new Map(rows.map((row) => [row.file, row.package])));
}

export function getFileGraphWithStatement(
  stmt: PrepareStatement,
  packageFilter: string,
): CodeMapGraph {
  const allFiles = stmt('SELECT DISTINCT file FROM symbols').all() as { file: string }[];
  const packageOf = readPackageLabeller(stmt);
  // Nodes pulled in from outside the drill-down scope have no symbol rows here
  // to read a language from. The path is enough, and cheaper than a query —
  // getting it wrong would paint an imported Go file as TypeScript.
  const langOf = (file: string): SymbolLang => detectLang(file) ?? 'other';
  const pkgFilePaths = allFiles
    .filter((f) => matchesIndexedPackageFilter(f.file, packageOf(f.file), packageFilter))
    .map((f) => f.file);
  const localFiles = new Set(pkgFilePaths);
  if (localFiles.size === 0) return { nodes: [], edges: [] };

  const filePlaceholders = [...localFiles].map(() => '?').join(',');
  const pkgSyms = stmt(
    `SELECT file, id, name, kind, lang, line FROM symbols WHERE file IN (${filePlaceholders}) ORDER BY id`,
  ).all(...pkgFilePaths) as WriterFileGraphSymbolRow[];
  const { fileNodes, symToFile, fileStats, ensureFileNode } = buildFileGraphNodeState(
    pkgSyms,
    localFiles,
    packageOf,
  );

  const refRows = stmt(
    `SELECT r.from_id, r.to_id, r.call_type, COUNT(*) AS n
       FROM refs r
       WHERE (r.from_id IN (SELECT id FROM symbols WHERE file IN (${filePlaceholders}))
           OR r.to_id IN (SELECT id FROM symbols WHERE file IN (${filePlaceholders})))
         AND r.to_id IS NOT NULL
       GROUP BY r.from_id, r.to_id, r.call_type`,
  ).all(...pkgFilePaths, ...pkgFilePaths) as {
    from_id: number;
    to_id: number;
    call_type: string;
    n: number;
  }[];

  const knownSymIds = new Set(pkgSyms.map((s) => s.id));
  const crossRefIds = new Set<number>();
  for (const r of refRows) {
    if (!knownSymIds.has(r.from_id)) crossRefIds.add(r.from_id);
    if (!knownSymIds.has(r.to_id)) crossRefIds.add(r.to_id);
  }
  if (crossRefIds.size > 0) {
    const crossPlaceholders = [...crossRefIds].map(() => '?').join(',');
    const extras = stmt(`SELECT id, file FROM symbols WHERE id IN (${crossPlaceholders})`).all(
      ...crossRefIds,
    ) as { id: number; file: string }[];
    for (const x of extras) {
      symToFile.set(x.id, x.file);
      if (!fileStats.has(x.file)) {
        fileStats.set(x.file, { count: 0, lang: langOf(x.file) });
      }
    }
  }

  const edgeMap = new Map<string, WeightedEdgeAccumulator>();
  for (const r of refRows) {
    if (r.call_type === 'import') continue;
    const fromFile = symToFile.get(r.from_id);
    const toFile = symToFile.get(r.to_id);
    if (!fromFile || !toFile || fromFile === toFile) continue;
    if (!localFiles.has(fromFile) && !localFiles.has(toFile)) continue;
    ensureFileNode(fromFile);
    ensureFileNode(toFile);
    const n = Number(r.n) || 0;
    addWeightedEdge(edgeMap, fromFile, toFile, r.call_type, n);
  }

  // Same two-way target resolution as the package graph: the index-time module
  // resolution result first, the imported symbol's declaring file second.
  const importRows = stmt(
    `SELECT r.from_id, COALESCE(r.to_file, st.file) AS to_file, COUNT(*) AS n
       FROM refs r
       LEFT JOIN symbols st ON st.id = r.to_id
       WHERE r.call_type = 'import'
         AND COALESCE(r.to_file, st.file) IS NOT NULL
         AND r.from_id IN (SELECT id FROM symbols WHERE file IN (${filePlaceholders}))
       GROUP BY r.from_id, COALESCE(r.to_file, st.file)`,
  ).all(...pkgFilePaths) as { from_id: number; to_file: string; n: number }[];
  for (const r of importRows) {
    const fromFile = symToFile.get(r.from_id);
    if (!fromFile || !localFiles.has(fromFile)) continue;
    const toFile = r.to_file;
    if (!toFile || fromFile === toFile) continue;
    if (!fileStats.has(toFile)) {
      // An import target outside the drill-down scope still gets a node, so the
      // edge has somewhere to land and renders as an external dependency.
      fileStats.set(toFile, { count: 0, lang: langOf(toFile) });
    }
    ensureFileNode(fromFile);
    ensureFileNode(toFile);
    const n = Number(r.n) || 0;
    addWeightedEdge(edgeMap, fromFile, toFile, 'import', n);
  }

  const edges = materializeWeightedEdges(edgeMap, 'file');
  return { nodes: [...fileNodes.values()], edges };
}

export function getSymbolGraphWithStatement(
  stmt: PrepareStatement,
  fileFilter: string,
): CodeMapGraph {
  const indexedFiles = resolveIndexedFiles(stmt, fileFilter);
  if (indexedFiles.length === 0) return { nodes: [], edges: [] };
  const filePlaceholders = indexedFiles.map(() => '?').join(',');

  const syms = stmt(
    `SELECT id, name, kind, lang, file, line, signature, scope FROM symbols WHERE file IN (${filePlaceholders}) ORDER BY line, id`,
  ).all(...indexedFiles) as WriterSymbolGraphRow[];

  if (syms.length === 0) return { nodes: [], edges: [] };

  const symById = new Map(syms.map((symbol) => [symbol.id, symbol]));
  const relatedIds = new Set(syms.map((symbol) => symbol.id));

  const refRows = stmt(
    `SELECT from_id, to_id, call_type, COUNT(*) AS n
       FROM (
         SELECT r.from_id, r.to_id, r.to_name, r.call_type, r.line
         FROM refs r
         JOIN symbols s ON s.id = r.from_id
         WHERE s.file IN (${filePlaceholders})
         UNION
         SELECT r.from_id, r.to_id, r.to_name, r.call_type, r.line
         FROM refs r
         JOIN symbols s ON s.id = r.to_id
         WHERE s.file IN (${filePlaceholders})
       )
       WHERE to_id IS NOT NULL
       GROUP BY from_id, to_id, call_type`,
  ).all(...indexedFiles, ...indexedFiles) as {
    from_id: number;
    to_id: number;
    call_type: string;
    n: number;
  }[];

  const edgeMap = new Map<string, WeightedEdgeAccumulator>();
  for (const r of refRows) {
    if (r.to_id == null) continue;
    relatedIds.add(r.from_id);
    relatedIds.add(r.to_id);
    const n = Number(r.n) || 0;
    addWeightedEdge(edgeMap, r.from_id, r.to_id, r.call_type, n);
  }
  const edges = materializeWeightedEdges(edgeMap, 'sym');

  const loadedIds = new Set(syms.map((s) => s.id));
  const missingIds = [...relatedIds].filter((id) => !loadedIds.has(id));
  if (missingIds.length > 0) {
    const placeholders = missingIds.map(() => '?').join(',');
    const extras = stmt(
      `SELECT id, name, kind, lang, file, line, signature, scope FROM symbols WHERE id IN (${placeholders})`,
    ).all(...missingIds) as WriterSymbolGraphRow[];
    for (const s of extras) symById.set(s.id, s);
  }

  const nodes = buildSymbolGraphNodes(
    symById,
    relatedIds,
    new Set(syms.map((symbol) => symbol.file)),
    readPackageLabeller(stmt),
  );
  return { nodes, edges };
}

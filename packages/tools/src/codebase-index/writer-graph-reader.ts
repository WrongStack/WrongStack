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
 */
function chunkedIdQuery(
  stmt: PrepareStatement,
  ids: number[],
  buildSql: (placeholders: string) => string,
  extraArgs: readonly (string | number)[] = [],
): unknown[] {
  const results: unknown[] = [];
  for (let start = 0; start < ids.length; start += MAX_SQL_VARS) {
    const chunk = ids.slice(start, start + MAX_SQL_VARS);
    const placeholders = chunk.map(() => '?').join(',');
    const sql = buildSql(placeholders);
    results.push(...(stmt(sql).all(...chunk, ...extraArgs) as unknown[]));
  }
  return results;
}

/** Like chunkedIdQuery but returns a single scalar (COUNT, SUM, …). */
function chunkedIdScalar(
  stmt: PrepareStatement,
  ids: number[],
  buildSql: (placeholders: string) => string,
  extraArgs: readonly (string | number)[] = [],
): number {
  let total = 0;
  for (let start = 0; start < ids.length; start += MAX_SQL_VARS) {
    const chunk = ids.slice(start, start + MAX_SQL_VARS);
    const placeholders = chunk.map(() => '?').join(',');
    const sql = buildSql(placeholders);
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
function resolveSymbolIds(
  stmt: PrepareStatement,
  symbolName: string,
  file: string | undefined,
): number[] {
  const baseSql = file
    ? `SELECT id FROM symbols WHERE name = ? AND file = ? ORDER BY id`
    : `SELECT id FROM symbols WHERE name = ? ORDER BY id`;
  const args = file ? [symbolName, file] : [symbolName];
  const rows = stmt(baseSql).all(...args) as Array<{ id: number }>;
  return rows.map((r) => r.id);
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
  if (targetIds.length === 0) return { calls: [], symbolFound: false, ambiguous: false, totalMatches: 0 };

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
  return { calls: allCalls.slice(0, limit), symbolFound: true, ambiguous, totalMatches: allCalls.length };
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
  if (sourceIds.length === 0) return { calls: [], symbolFound: false, unresolvedCount: 0, totalMatches: 0 };

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
  const pkgFilePaths = allFiles.filter((f) => packageOf(f.file) === packageFilter).map((f) => f.file);
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
  const syms = stmt(
    'SELECT id, name, kind, lang, file, line, signature, scope FROM symbols WHERE file = ? ORDER BY line, id',
  ).all(fileFilter) as WriterSymbolGraphRow[];

  if (syms.length === 0) return { nodes: [], edges: [] };

  const symById = new Map(syms.map((symbol) => [symbol.id, symbol]));
  const relatedIds = new Set(syms.map((symbol) => symbol.id));

  const refRows = stmt(
    `SELECT from_id, to_id, call_type, COUNT(*) AS n
       FROM (
         SELECT r.from_id, r.to_id, r.to_name, r.call_type, r.line
         FROM refs r
         JOIN symbols s ON s.id = r.from_id
         WHERE s.file = ?
         UNION
         SELECT r.from_id, r.to_id, r.to_name, r.call_type, r.line
         FROM refs r
         JOIN symbols s ON s.id = r.to_id
         WHERE s.file = ?
       )
       WHERE to_id IS NOT NULL
       GROUP BY from_id, to_id, call_type`,
  ).all(fileFilter, fileFilter) as {
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

  const nodes = buildSymbolGraphNodes(symById, relatedIds, fileFilter, readPackageLabeller(stmt));
  return { nodes, edges };
}

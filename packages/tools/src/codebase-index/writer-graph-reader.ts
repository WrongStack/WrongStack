import type { DatabaseSync } from 'node:sqlite';
import type { CallSite, CodeMapGraph, Ref, SymbolKind, SymbolLang } from './schema.js';
import {
  addWeightedEdge,
  buildFileGraphNodeState,
  buildPackageGraphNodes,
  buildSymbolGraphNodes,
  derivePackage,
  materializeWeightedEdges,
  packageFromImport,
  resolveRelativeImport,
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
): { calls: CallSite[]; symbolFound: boolean; ambiguous: boolean } {
  const targetIds = resolveSymbolIds(stmt, symbolName, file);
  if (targetIds.length === 0) return { calls: [], symbolFound: false, ambiguous: false };

  // Ref resolution (writer.ts `resolveRefs`) assigns `to_id` name-globally via
  // `MIN(id)` — it is not file-aware. When `file` scopes the query but other
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
  const useFallback = !file;
  const fallbackArgs = useFallback ? [symbolName] : [];

  // Query without LIMIT — chunked execution would apply LIMIT per-chunk,
  // leaking past the caller's ceiling. This fetches ALL matching refs then
  // slices to `limit` after merge. Safe because callers cap at 200; a symbol
  // with thousands of callers is rare and the limit protects memory.
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
       WHERE r.to_id IN (${ph})${useFallback ? ` OR (r.to_id IS NULL AND r.to_name = ?)` : ''}
       ORDER BY r.line, r.id`,
    fallbackArgs,
  ) as CallSiteRow[];

  const calls = rows.map(mapCallSiteRow).slice(0, limit);
  return { calls, symbolFound: true, ambiguous };
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
): { calls: CallSite[]; symbolFound: boolean; unresolvedCount: number } {
  const sourceIds = resolveSymbolIds(stmt, symbolName, file);
  if (sourceIds.length === 0) return { calls: [], symbolFound: false, unresolvedCount: 0 };

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
  // with thousands of callers is rare and the limit protects memory.
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

  const calls = rows.map(mapCallSiteRow).slice(0, limit);
  return { calls, symbolFound: true, unresolvedCount };
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
  const { pkgNodes, fileToPkg } = buildPackageGraphNodes(fileCounts, files);

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
    const fromPkg = fileToPkg.get(r.from_file) ?? derivePackage(r.from_file) ?? '(root)';
    const toPkg = fileToPkg.get(r.to_file) ?? derivePackage(r.to_file) ?? '(root)';
    if (fromPkg === toPkg) continue;
    const n = Number(r.n) || 0;
    addWeightedEdge(edgeMap, fromPkg, toPkg, r.call_type, n);
  }

  const importRows = stmt(
    `SELECT r.to_name, s.file AS from_file, COUNT(*) AS n
       FROM refs r
       JOIN symbols s ON s.id = r.from_id
       WHERE r.call_type = 'import'
       GROUP BY r.to_name, s.file`,
  ).all() as Array<{ to_name: string; from_file: string; n: number }>;
  for (const r of importRows) {
    const fromPkg = fileToPkg.get(r.from_file) ?? derivePackage(r.from_file) ?? '(root)';
    const toPkg = packageFromImport(r.to_name);
    if (!fromPkg || !toPkg || fromPkg === toPkg || !pkgNodes.has(toPkg)) continue;
    const n = Number(r.n) || 0;
    addWeightedEdge(edgeMap, fromPkg, toPkg, 'import', n);
  }

  const edges = materializeWeightedEdges(edgeMap, 'pkg');
  return { nodes: [...pkgNodes.values()], edges };
}

export function getFileGraphWithStatement(
  stmt: PrepareStatement,
  packageFilter: string,
): CodeMapGraph {
  const allFiles = stmt('SELECT DISTINCT file FROM symbols').all() as { file: string }[];
  const pkgFilePaths = allFiles
    .filter((f) => (derivePackage(f.file) ?? '(root)') === packageFilter)
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
  );

  const indexedFiles = new Set(allFiles.map((f) => f.file));

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
        fileStats.set(x.file, { count: 0, lang: 'ts' as SymbolLang });
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

  const importRows = stmt(
    `SELECT r.from_id, r.to_name, COUNT(*) AS n
       FROM refs r
       WHERE r.call_type = 'import'
         AND r.from_id IN (SELECT id FROM symbols WHERE file IN (${filePlaceholders}))
       GROUP BY r.from_id, r.to_name`,
  ).all(...pkgFilePaths) as { from_id: number; to_name: string; n: number }[];
  for (const r of importRows) {
    const fromFile = symToFile.get(r.from_id);
    if (!fromFile || !localFiles.has(fromFile)) continue;
    const toFile = resolveRelativeImport(fromFile, r.to_name, indexedFiles);
    if (!toFile || fromFile === toFile) continue;
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

  const nodes = buildSymbolGraphNodes(symById, relatedIds, fileFilter);
  return { nodes, edges };
}

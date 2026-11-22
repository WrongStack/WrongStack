import { detectLang } from './languages.js';
import type { CodeMapGraph, SymbolLang } from './schema.js';
import { allRowsAsArrays } from './sqlite-runtime.js';
import { decorateGraphNodes } from './writer-graph-decorate.js';
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
import type { PrepareStatement } from './writer-graph-queries.js';
import {
  chunkedIdQuery,
  chunkedValueQuery,
  getSymbolsByIdsWithStatement,
  refCountsTouching,
  resolveIndexedFiles,
} from './writer-graph-queries.js';
import { matchesIndexedPackageFilter } from './writer-helpers.js';

/**
 * The package-level dependency graph — the Code Map's opening view.
 *
 * Aggregated in one pass over `refs` straight to package pairs. It used to
 * GROUP BY `(call_type, from_file, to_file)` in SQL with two symbol joins —
 * SQLite drove that through `idx_r_call_type` for the `!=` predicate and a
 * temp B-tree over ~95k file pairs, ~1.1 s on this repository — only for the
 * rows to be folded into ~900 package pairs here anyway. Semantics are those
 * of the SQL form: a non-import ref needs both endpoint symbols, an import
 * lands on its resolved `to_file` else its target symbol's file, and a
 * package pair's dominant type breaks ties the way the sorted SQL stream did
 * (other types alphabetically, `import` last).
 */
export function getPackageGraphWithStatement(stmt: PrepareStatement): CodeMapGraph {
  const fileOfSymbol = new Map<number, string>();
  const symbolsPerFile = new Map<string, number>();
  for (const [id, file] of allRowsAsArrays(stmt('SELECT id, file FROM symbols')) as Array<
    [number, string]
  >) {
    fileOfSymbol.set(id, file);
    symbolsPerFile.set(file, (symbolsPerFile.get(file) ?? 0) + 1);
  }
  // Node order follows the file order the GROUP BY used to produce.
  const fileCounts = [...symbolsPerFile]
    .map(([file, n]) => ({ file, n }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const files = stmt('SELECT DISTINCT file FROM files').all() as { file: string }[];
  const packageOf = readPackageLabeller(stmt);
  const { pkgNodes, fileToPkg } = buildPackageGraphNodes(fileCounts, files, packageOf);
  const pkgOfFile = (file: string): string => {
    let pkg = fileToPkg.get(file);
    if (pkg === undefined) {
      pkg = packageOf(file);
      fileToPkg.set(file, pkg);
    }
    return pkg;
  };

  // pair key → per-type counts; imports kept apart for the tie-break order.
  const pairs = new Map<string, { from: string; to: string; types: Map<string, number> }>();
  const count = (fromPkg: string, toPkg: string, callType: string): void => {
    const key = `${fromPkg}\u0000${toPkg}`;
    let pair = pairs.get(key);
    if (pair === undefined) {
      pair = { from: fromPkg, to: toPkg, types: new Map() };
      pairs.set(key, pair);
    }
    pair.types.set(callType, (pair.types.get(callType) ?? 0) + 1);
  };

  const refRows = allRowsAsArrays(
    stmt('SELECT from_id, to_id, to_file, call_type FROM refs'),
  ) as Array<[number, number | null, string | null, string]>;
  for (const [fromId, toId, toFileColumn, callType] of refRows) {
    const fromFile = fileOfSymbol.get(fromId);
    if (fromFile === undefined) continue;
    const targetFile = toId === null ? undefined : fileOfSymbol.get(toId);
    if (callType === 'import') {
      // Import edges resolve to a target file two ways, in priority order:
      // `to_file` (the module specifier resolved against the project's real
      // layout at index time — the only path that works for Go, Python, Rust,
      // JVM, …) and otherwise the file declaring the imported symbol, which
      // covers namespace ecosystems like C# where a specifier names no file.
      const toFile = toFileColumn ?? targetFile;
      if (toFile === undefined) continue;
      const fromPkg = pkgOfFile(fromFile);
      const toPkg = pkgOfFile(toFile);
      // `to_file` may be an index-time module resolution result outside the
      // `files`/`symbols` tables; its package label can have no node in
      // `pkgNodes`, and edges never create target nodes.
      if (fromPkg === toPkg || !pkgNodes.has(toPkg)) continue;
      count(fromPkg, toPkg, 'import');
    } else {
      if (targetFile === undefined) continue;
      const fromPkg = pkgOfFile(fromFile);
      const toPkg = pkgOfFile(targetFile);
      if (fromPkg === toPkg) continue;
      count(fromPkg, toPkg, callType);
    }
  }

  const edgeMap = new Map<string, WeightedEdgeAccumulator>();
  const ordered = [...pairs.values()].sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  );
  for (const pair of ordered) {
    const types = [...pair.types.keys()].sort((a, b) =>
      a === 'import' ? 1 : b === 'import' ? -1 : a < b ? -1 : a > b ? 1 : 0,
    );
    for (const type of types) {
      addWeightedEdge(edgeMap, pair.from, pair.to, type, pair.types.get(type) ?? 0);
    }
  }

  const edges = materializeWeightedEdges(edgeMap, 'pkg');
  const nodes = [...pkgNodes.values()];
  decorateGraphNodes(stmt, nodes, packageOf);
  return { nodes, edges };
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

  const pkgSyms = (
    chunkedValueQuery(
      stmt,
      [...localFiles],
      (ph) => `SELECT file, id, name, kind, lang, line FROM symbols WHERE file IN (${ph})`,
    ) as WriterFileGraphSymbolRow[]
  ).sort((a, b) => a.id - b.id);
  const { fileNodes, symToFile, fileStats, ensureFileNode } = buildFileGraphNodeState(
    pkgSyms,
    localFiles,
    packageOf,
  );

  const localIds = pkgSyms.map((s) => s.id);
  const refRows = refCountsTouching(stmt, localIds);

  const knownSymIds = new Set(localIds);
  const crossRefIds = new Set<number>();
  for (const r of refRows) {
    if (!knownSymIds.has(r.from_id)) crossRefIds.add(r.from_id);
    if (!knownSymIds.has(r.to_id)) crossRefIds.add(r.to_id);
  }
  if (crossRefIds.size > 0) {
    const extras = chunkedIdQuery(
      stmt,
      [...crossRefIds],
      (ph) => `SELECT id, file FROM symbols WHERE id IN (${ph})`,
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
  const importRows = chunkedIdQuery(
    stmt,
    localIds,
    (ph) =>
      `SELECT r.from_id, COALESCE(r.to_file, st.file) AS to_file, COUNT(*) AS n
         FROM refs r
         LEFT JOIN symbols st ON st.id = r.to_id
         WHERE +r.call_type = 'import'
           AND COALESCE(r.to_file, st.file) IS NOT NULL
           AND r.from_id IN (${ph})
         GROUP BY r.from_id, COALESCE(r.to_file, st.file)`,
  ) as { from_id: number; to_file: string; n: number }[];
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
  const nodes = [...fileNodes.values()];
  decorateGraphNodes(stmt, nodes, packageOf);
  return { nodes, edges };
}

export function getSymbolGraphWithStatement(
  stmt: PrepareStatement,
  fileFilter: string,
): CodeMapGraph {
  const indexedFiles = resolveIndexedFiles(stmt, fileFilter);
  if (indexedFiles.length === 0) return { nodes: [], edges: [] };

  // A suffix filter can match many files; chunk instead of one unbounded IN.
  const syms = (
    chunkedValueQuery(
      stmt,
      indexedFiles,
      (ph) =>
        `SELECT id, name, kind, lang, file, line, signature, scope FROM symbols WHERE file IN (${ph})`,
    ) as WriterSymbolGraphRow[]
  ).sort((a, b) => a.line - b.line || a.id - b.id);

  if (syms.length === 0) return { nodes: [], edges: [] };

  const symById = new Map(syms.map((symbol) => [symbol.id, symbol]));
  const relatedIds = new Set<number>(syms.map((symbol) => symbol.id));

  const refRows = refCountsTouching(
    stmt,
    syms.map((symbol) => symbol.id),
  );

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
    for (const s of getSymbolsByIdsWithStatement(stmt, missingIds)) symById.set(s.id, s);
  }

  const packageOf = readPackageLabeller(stmt);
  const nodes = buildSymbolGraphNodes(
    symById,
    relatedIds,
    new Set(syms.map((symbol) => symbol.file)),
    packageOf,
  );
  decorateGraphNodes(stmt, nodes, packageOf);
  return { nodes, edges };
}

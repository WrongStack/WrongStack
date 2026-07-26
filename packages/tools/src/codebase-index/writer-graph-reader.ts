import type { DatabaseSync } from 'node:sqlite';
import type { CodeMapGraph, Ref, SymbolLang } from './schema.js';
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

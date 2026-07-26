import * as path from 'node:path';
import type { CallType, GraphEdge, GraphNode, SymbolKind, SymbolLang } from './schema.js';

/**
 * Derive a monorepo package name from an absolute file path.
 * Handles both `packages/<name>/...` and `apps/<name>/...` layouts.
 */
export function derivePackage(filePath: string): string | undefined {
  const f = filePath.replace(/\\/g, '/');
  const pkgsIdx = f.indexOf('/packages/');
  if (pkgsIdx !== -1) {
    const rest = f.slice(pkgsIdx + '/packages/'.length);
    const seg = rest.split('/')[0];
    return seg ? `@wrongstack/${seg}` : undefined;
  }
  const appsIdx = f.indexOf('/apps/');
  if (appsIdx !== -1) {
    const rest = f.slice(appsIdx + '/apps/'.length);
    const seg = rest.split('/')[0];
    return seg ? `app:${seg}` : undefined;
  }
  return undefined;
}

export function packageFromImport(moduleName: string): string | undefined {
  if (!moduleName.startsWith('@wrongstack/')) return undefined;
  const parts = moduleName.split('/');
  return parts[1] ? `@wrongstack/${parts[1]}` : undefined;
}

export function buildPackageGraphNodes(
  fileCounts: Array<{ file: string; n: number }>,
  files: Array<{ file: string }>,
): { pkgNodes: Map<string, GraphNode>; fileToPkg: Map<string, string> } {
  const pkgNodes = new Map<string, GraphNode>();
  const fileToPkg = new Map<string, string>();

  for (const { file, n } of fileCounts) {
    const pkg = derivePackage(file) ?? '(root)';
    fileToPkg.set(file, pkg);
    const node = pkgNodes.get(pkg);
    if (node) {
      node.symbolCount = (node.symbolCount ?? 0) + n;
    } else {
      pkgNodes.set(pkg, {
        id: `pkg:${pkg}`,
        label: pkg,
        kind: 'package',
        package: pkg,
        symbolCount: n,
        fileCount: 0,
      });
    }
  }

  for (const { file } of files) {
    const pkg = derivePackage(file) ?? '(root)';
    fileToPkg.set(file, pkg);
    const node = pkgNodes.get(pkg);
    if (node) {
      node.fileCount = (node.fileCount ?? 0) + 1;
    } else {
      pkgNodes.set(pkg, {
        id: `pkg:${pkg}`,
        label: pkg,
        kind: 'package',
        package: pkg,
        symbolCount: 0,
        fileCount: 1,
      });
    }
  }

  return { pkgNodes, fileToPkg };
}

export type WriterFileGraphSymbolRow = {
  file: string;
  id: number;
  name: string;
  kind: string;
  lang: string;
  line: number;
};

export function buildFileGraphNodeState(
  pkgSyms: WriterFileGraphSymbolRow[],
  localFiles: Set<string>,
): {
  fileNodes: Map<string, GraphNode>;
  symToFile: Map<number, string>;
  fileStats: Map<string, { count: number; lang: SymbolLang }>;
  ensureFileNode: (file: string) => void;
} {
  const fileNodes = new Map<string, GraphNode>();
  const symToFile = new Map<number, string>();
  const fileStats = new Map<string, { count: number; lang: SymbolLang }>();
  for (const s of pkgSyms) {
    symToFile.set(s.id, s.file);
    const current = fileStats.get(s.file);
    fileStats.set(s.file, {
      count: (current?.count ?? 0) + 1,
      lang: (current?.lang ?? s.lang) as SymbolLang,
    });
  }

  const ensureFileNode = (file: string): void => {
    if (fileNodes.has(file)) return;
    const stats = fileStats.get(file);
    fileNodes.set(file, {
      id: `file:${file}`,
      label: file.replace(/\\/g, '/').split('/').pop() ?? file,
      kind: 'file',
      package: derivePackage(file) ?? '(root)',
      file,
      symbolCount: stats?.count ?? 0,
      lang: stats?.lang,
      external: !localFiles.has(file),
    });
  };
  for (const file of localFiles) {
    ensureFileNode(file);
  }
  return { fileNodes, symToFile, fileStats, ensureFileNode };
}

export type WriterSymbolGraphRow = {
  id: number;
  name: string;
  kind: string;
  lang: string;
  file: string;
  line: number;
  signature: string;
  scope: string;
};

export function buildSymbolGraphNodes(
  symById: Map<number, WriterSymbolGraphRow>,
  relatedIds: Set<number>,
  fileFilter: string,
): GraphNode[] {
  return [...relatedIds]
    .map((id) => symById.get(id))
    .filter((symbol): symbol is WriterSymbolGraphRow => symbol !== undefined)
    .sort((a, b) => {
      const aExternal = a.file === fileFilter ? 0 : 1;
      const bExternal = b.file === fileFilter ? 0 : 1;
      return aExternal - bExternal || a.file.localeCompare(b.file) || a.line - b.line || a.id - b.id;
    })
    .map((s) => ({
      id: `sym:${s.id}`,
      label: s.name,
      kind: 'symbol',
      symbolId: s.id,
      symbolKind: s.kind as SymbolKind,
      file: s.file,
      package: derivePackage(s.file) ?? '(root)',
      lang: s.lang as SymbolLang,
      line: s.line,
      signature: s.signature,
      scope: s.scope,
      external: s.file !== fileFilter,
    }));
}

export function resolveRelativeImport(
  fromFile: string,
  moduleName: string,
  indexedFiles: Set<string>,
): string | undefined {
  if (!moduleName.startsWith('.')) return undefined;
  const normalizedFrom = fromFile.replace(/\\/g, '/');
  const absolute = path.posix.normalize(
    path.posix.join(path.posix.dirname(normalizedFrom), moduleName),
  );
  const extension = path.posix.extname(absolute);
  const base = extension ? absolute.slice(0, -extension.length) : absolute;
  const candidates = [
    absolute,
    ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].map((ext) => `${base}${ext}`),
    ...['.ts', '.tsx', '.js', '.jsx'].map((ext) => path.posix.join(absolute, `index${ext}`)),
    ...['.ts', '.tsx', '.js', '.jsx'].map((ext) => path.posix.join(base, `index${ext}`)),
  ];
  const indexedByPortablePath = new Map(
    [...indexedFiles].map((file) => [file.replace(/\\/g, '/').toLocaleLowerCase(), file]),
  );
  for (const candidate of candidates) {
    const indexed = indexedByPortablePath.get(candidate.toLocaleLowerCase());
    if (indexed) return indexed;
  }
  return undefined;
}

export type WeightedEdgeAccumulator = {
  weight: number;
  types: Map<string, number>;
};

export function addWeightedEdge(
  edgeMap: Map<string, WeightedEdgeAccumulator>,
  source: string | number,
  target: string | number,
  callType: string,
  weight: number,
): void {
  const key = `${source}\u0000${target}`;
  let edge = edgeMap.get(key);
  if (!edge) {
    edge = { weight: 0, types: new Map() };
    edgeMap.set(key, edge);
  }
  edge.weight += weight;
  edge.types.set(callType, (edge.types.get(callType) ?? 0) + weight);
}

export function materializeWeightedEdges(
  edgeMap: Map<string, WeightedEdgeAccumulator>,
  idPrefix: 'pkg' | 'file' | 'sym',
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [key, edge] of edgeMap) {
    const [source, target] = key.split('\u0000');
    let bestType = 'call';
    let bestCount = 0;
    for (const [type, count] of edge.types) {
      if (count > bestCount) {
        bestType = type;
        bestCount = count;
      }
    }
    edges.push({
      source: `${idPrefix}:${source}`,
      target: `${idPrefix}:${target}`,
      weight: edge.weight,
      refType: bestType as CallType,
    });
  }
  return edges;
}

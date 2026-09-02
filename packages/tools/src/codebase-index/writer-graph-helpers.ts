import { derivePackageFromLayout } from './module-roots.js';
import type { CallType, GraphEdge, GraphNode, SymbolKind, SymbolLang } from './schema.js';

/**
 * Derive a monorepo package name from an absolute file path.
 * Handles both `packages/<name>/...` and `apps/<name>/...` layouts.
 *
 * This is the fallback only. The authoritative grouping is computed at index
 * time from each ecosystem's own manifests and stored on `files.package` —
 * see {@link createPackageLabeller}. A path-shape guess is all that is left
 * for a repo with no manifest at all.
 */
export function derivePackage(filePath: string): string | undefined {
  return derivePackageFromLayout(filePath);
}

/**
 * Build the `file → package` lookup the graph readers group by.
 *
 * `stored` comes from `files.package`, which the indexer filled from `go.mod`,
 * `Cargo.toml`, `package.json`, `pom.xml` and friends. Files missing a stored
 * label (indexed by an older run, or outside any manifest) fall back to the
 * path-shape heuristic and finally to `(root)`.
 */
export function createPackageLabeller(
  stored: ReadonlyMap<string, string>,
): (file: string) => string {
  return (file: string): string => stored.get(file) ?? derivePackageFromLayout(file) ?? '(root)';
}

export function buildPackageGraphNodes(
  fileCounts: Array<{ file: string; n: number }>,
  files: Array<{ file: string }>,
  packageOf: (file: string) => string,
): { pkgNodes: Map<string, GraphNode>; fileToPkg: Map<string, string> } {
  const pkgNodes = new Map<string, GraphNode>();
  const fileToPkg = new Map<string, string>();

  const getOrSetPkg = (file: string): string => {
    let pkg = fileToPkg.get(file);
    if (pkg === undefined) {
      pkg = packageOf(file);
      fileToPkg.set(file, pkg);
    }
    return pkg;
  };

  for (const { file, n } of fileCounts) {
    const pkg = getOrSetPkg(file);
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
    const pkg = getOrSetPkg(file);
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
  packageOf: (file: string) => string,
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
    const lastSlash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
    const label = lastSlash === -1 ? file : file.slice(lastSlash + 1);
    fileNodes.set(file, {
      id: `file:${file}`,
      label,
      kind: 'file',
      package: packageOf(file),
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
  localFiles: ReadonlySet<string> | string,
  packageOf: (file: string) => string,
): GraphNode[] {
  const rawSet = typeof localFiles === 'string' ? [localFiles] : localFiles;
  const local = new Set<string>();
  for (const f of rawSet) {
    local.add(f.includes('\\') ? f.replace(/\\/g, '/') : f);
  }
  const isLocal = (file: string): boolean =>
    local.has(file.includes('\\') ? file.replace(/\\/g, '/') : file);

  const matched: Array<WriterSymbolGraphRow & { isExt: boolean }> = [];
  for (const id of relatedIds) {
    const s = symById.get(id);
    if (s) {
      matched.push({ ...s, isExt: !isLocal(s.file) });
    }
  }

  matched.sort((a, b) => {
    const aExternal = a.isExt ? 1 : 0;
    const bExternal = b.isExt ? 1 : 0;
    return aExternal - bExternal || a.file.localeCompare(b.file) || a.line - b.line || a.id - b.id;
  });

  return matched.map((s) => ({
    id: `sym:${s.id}`,
    label: s.name,
    kind: 'symbol',
    symbolId: s.id,
    symbolKind: s.kind as SymbolKind,
    file: s.file,
    package: packageOf(s.file),
    lang: s.lang as SymbolLang,
    line: s.line,
    signature: s.signature,
    scope: s.scope,
    external: s.isExt,
  }));
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

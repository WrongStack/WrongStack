type GraphNodeKind = 'package' | 'file' | 'symbol';
export type GraphRefType = 'call' | 'import' | 'type_ref' | 'inherit' | 'implement';

export interface GraphNodeData {
  id: string;
  label: string;
  kind: GraphNodeKind;
  package?: string;
  file?: string;
  symbolId?: number;
  symbolKind?: string;
  symbolCount?: number;
  fileCount?: number;
  lang?: string;
  line?: number;
  signature?: string;
  scope?: string;
  external?: boolean;
}

export interface GraphEdgeData {
  source: string;
  target: string;
  weight: number;
  refType: GraphRefType;
}

export interface CodeMapGraphResponse {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
}

export type CodeMapScope =
  | { level: 'packages' }
  | { level: 'files'; package: string }
  | { level: 'symbols'; file: string; package?: string };

export type CodeMapLayout = 'layers' | 'orbit';

interface PositionedGraphNode {
  node: GraphNodeData;
  position: { x: number; y: number };
}

export interface RelationItem {
  node: GraphNodeData;
  edge: GraphEdgeData;
}

export interface DirectoryNode {
  name: string;
  path: string;
  directories: DirectoryNode[];
  files: GraphNodeData[];
}

const NODE_WIDTH = 236;
const NODE_HEIGHT = 108;
const X_GAP = 150;
const Y_GAP = 52;

/**
 * Module-level memo cache for `normalizedPath`. Path strings are stable
 * across renders — the same file path always normalizes to the same string —
 * so caching by the raw input is safe and eliminates the per-render regex
 * cost. `sameFile()` calls `normalizedPath` twice per comparison, and
 * `activityMatchesNode` invokes it once per activity × node pair, so the
 * total call count can reach 10K+ per render for medium graphs.
 */
const NORMALIZED_PATH_CACHE_MAX_ENTRIES = 4_096;
const normalizedPathCache = new Map<string, string>();
export function normalizedPath(filePath: string): string {
  const cached = normalizedPathCache.get(filePath);
  if (cached !== undefined) return cached;
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase();
  while (normalizedPathCache.size >= NORMALIZED_PATH_CACHE_MAX_ENTRIES) {
    const oldest = normalizedPathCache.keys().next().value;
    if (oldest === undefined) break;
    normalizedPathCache.delete(oldest);
  }
  normalizedPathCache.set(filePath, normalized);
  return normalized;
}

export function _clearNormalizedPathCacheForTests(): void {
  normalizedPathCache.clear();
}

export function _normalizedPathCacheSizeForTests(): number {
  return normalizedPathCache.size;
}

export function scopeKey(scope: CodeMapScope): string {
  if (scope.level === 'packages') return 'packages';
  if (scope.level === 'files') return `files:${scope.package}`;
  return `symbols:${scope.file}`;
}

export function scopeUrl(scope: CodeMapScope): string {
  if (scope.level === 'packages') return '/api/codemap/packages';
  if (scope.level === 'files') {
    return `/api/codemap/files?package=${encodeURIComponent(scope.package)}`;
  }
  return `/api/codemap/symbols?file=${encodeURIComponent(scope.file)}`;
}

export function relationItems(
  graph: CodeMapGraphResponse,
  nodeId: string,
  direction: 'incoming' | 'outgoing',
): RelationItem[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const items: RelationItem[] = [];
  for (const edge of graph.edges) {
    const relatedId =
      direction === 'incoming'
        ? edge.target === nodeId
          ? edge.source
          : undefined
        : edge.source === nodeId
          ? edge.target
          : undefined;
    if (!relatedId) continue;
    const node = byId.get(relatedId);
    if (node) items.push({ node, edge });
  }
  return items.sort(
    (a, b) => b.edge.weight - a.edge.weight || a.node.label.localeCompare(b.node.label),
  );
}

export function connectedNodeIds(graph: CodeMapGraphResponse, nodeId: string): Set<string> {
  const connected = new Set([nodeId]);
  for (const edge of graph.edges) {
    if (edge.source === nodeId) connected.add(edge.target);
    if (edge.target === nodeId) connected.add(edge.source);
  }
  return connected;
}

function graphDegrees(graph: CodeMapGraphResponse, ids: Set<string>): Map<string, number> {
  const degrees = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + edge.weight);
    if (edge.target !== edge.source) {
      degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + edge.weight);
    }
  }
  return degrees;
}

function layeredLayout(graph: CodeMapGraphResponse): PositionedGraphNode[] {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const degrees = graphDegrees(graph, ids);
  const incoming = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }

  const rank = new Map<string, number>();
  const queue = graph.nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .sort((a, b) => (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0))
    .map((node) => node.id);
  if (queue.length === 0 && graph.nodes[0]) queue.push(graph.nodes[0].id);
  for (const id of queue) rank.set(id, 0);

  const visited = new Set<string>();
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const source = queue[queueIndex++]!;
    if (visited.has(source)) continue;
    visited.add(source);
    for (const target of outgoing.get(source) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, Math.min((rank.get(source) ?? 0) + 1, 7)));
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if ((incoming.get(target) ?? 0) <= 0) queue.push(target);
    }
  }

  // Cyclic islands have no Kahn root. Keep them legible as compact staggered
  // layers instead of collapsing every node onto the same coordinate.
  const unresolved = graph.nodes
    .filter((node) => !rank.has(node.id))
    .sort((a, b) => (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0));
  unresolved.forEach((node, index) => {
    rank.set(node.id, index % Math.min(4, Math.max(1, unresolved.length)));
  });

  const layers = new Map<number, GraphNodeData[]>();
  for (const node of graph.nodes) {
    const nodeRank = rank.get(node.id) ?? 0;
    const layer = layers.get(nodeRank) ?? [];
    layer.push(node);
    layers.set(nodeRank, layer);
  }
  for (const layer of layers.values()) {
    layer.sort(
      (a, b) =>
        Number(a.external) - Number(b.external) ||
        (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0) ||
        a.label.localeCompare(b.label),
    );
  }

  const maxLayerSize = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const canvasHeight = maxLayerSize * (NODE_HEIGHT + Y_GAP);
  const positioned: PositionedGraphNode[] = [];
  for (const [layerIndex, layer] of [...layers.entries()].sort(([a], [b]) => a - b)) {
    const layerHeight = layer.length * (NODE_HEIGHT + Y_GAP);
    const startY = (canvasHeight - layerHeight) / 2;
    layer.forEach((node, index) => {
      positioned.push({
        node,
        position: {
          x: layerIndex * (NODE_WIDTH + X_GAP),
          y: startY + index * (NODE_HEIGHT + Y_GAP),
        },
      });
    });
  }
  return positioned;
}

function orbitLayout(graph: CodeMapGraphResponse, focusId?: string): PositionedGraphNode[] {
  if (graph.nodes.length === 0) return [];
  const ids = new Set(graph.nodes.map((node) => node.id));
  const degrees = graphDegrees(graph, ids);
  const focus =
    graph.nodes.find((node) => node.id === focusId) ??
    [...graph.nodes].sort((a, b) => (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0))[0]!;
  const directlyConnected = connectedNodeIds(graph, focus.id);
  directlyConnected.delete(focus.id);
  const near = graph.nodes.filter((node) => directlyConnected.has(node.id));
  const far = graph.nodes.filter((node) => node.id !== focus.id && !directlyConnected.has(node.id));
  const result: PositionedGraphNode[] = [{ node: focus, position: { x: 0, y: 0 } }];

  const placeRing = (nodes: GraphNodeData[], radius: number, offset: number): void => {
    nodes.forEach((node, index) => {
      const angle = offset + (Math.PI * 2 * index) / Math.max(1, nodes.length);
      result.push({
        node,
        position: { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
      });
    });
  };
  placeRing(near, Math.max(330, near.length * 34), -Math.PI / 2);
  const ringSize = 18;
  for (let start = 0; start < far.length; start += ringSize) {
    placeRing(
      far.slice(start, start + ringSize),
      620 + Math.floor(start / ringSize) * 280,
      -Math.PI / 2 + 0.12,
    );
  }
  return result;
}

export function layoutGraph(
  graph: CodeMapGraphResponse,
  layout: CodeMapLayout,
  focusId?: string,
): PositionedGraphNode[] {
  return layout === 'orbit' ? orbitLayout(graph, focusId) : layeredLayout(graph);
}

/** Default SMART canvas node budget — keeps React Flow DOM under control. */
export const SMART_CANVAS_NODE_LIMIT = 96;
/** SMART mode also caps edges; dense graphs otherwise paint thousands of SVG paths. */
export const SMART_CANVAS_EDGE_LIMIT = 180;

function cullSmartEdges(
  edges: GraphEdgeData[],
  selectedId: string | null,
  limit: number,
): GraphEdgeData[] {
  if (edges.length <= limit) return edges;
  const focused = selectedId
    ? edges.filter((edge) => edge.source === selectedId || edge.target === selectedId)
    : [];
  const rest = edges
    .filter((edge) => !selectedId || (edge.source !== selectedId && edge.target !== selectedId))
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        left.source.localeCompare(right.source) ||
        left.target.localeCompare(right.target),
    );
  const budget = Math.max(0, limit - focused.length);
  return [...focused, ...rest.slice(0, budget)];
}

/**
 * Reduce a scope graph to a renderable SMART subset: strongest nodes, selected
 * neighbourhood, and a capped edge set so React Flow stays interactive.
 */
export function smartCanvasGraph(
  graph: CodeMapGraphResponse,
  selectedId: string | null,
  mode: 'smart' | 'all',
): CodeMapGraphResponse {
  if (mode === 'all') return graph;

  let nodes = graph.nodes;
  if (graph.nodes.length > SMART_CANVAS_NODE_LIMIT) {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const scores = new Map<string, number>();
    for (const edge of graph.edges) {
      scores.set(edge.source, (scores.get(edge.source) ?? 0) + edge.weight);
      scores.set(edge.target, (scores.get(edge.target) ?? 0) + edge.weight);
    }
    const ranked = [...graph.nodes].sort(
      (left, right) =>
        (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0) ||
        left.label.localeCompare(right.label),
    );
    const retained = new Set<string>();
    const add = (id: string): void => {
      if (byId.has(id) && retained.size < SMART_CANVAS_NODE_LIMIT) retained.add(id);
    };

    if (selectedId && byId.has(selectedId)) {
      add(selectedId);
      const directEdges = graph.edges
        .filter((edge) => edge.source === selectedId || edge.target === selectedId)
        .sort((left, right) => right.weight - left.weight);
      for (const edge of directEdges) {
        add(edge.source);
        add(edge.target);
      }
      const directNodes = new Set(retained);
      const secondDegree = graph.edges
        .filter((edge) => directNodes.has(edge.source) || directNodes.has(edge.target))
        .sort((left, right) => right.weight - left.weight);
      for (const edge of secondDegree) {
        add(edge.source);
        add(edge.target);
      }
    } else {
      // Keep local + external mix within the hard node budget.
      const localBudget = Math.floor(SMART_CANVAS_NODE_LIMIT * 0.75);
      const externalBudget = SMART_CANVAS_NODE_LIMIT - localBudget;
      const local = ranked.filter((node) => !node.external).slice(0, localBudget);
      const external = ranked.filter((node) => node.external).slice(0, externalBudget);
      for (const node of [...local, ...external]) add(node.id);
    }
    for (const node of ranked) add(node.id);
    nodes = graph.nodes.filter((node) => retained.has(node.id));
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const scopedEdges = graph.edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );
  return {
    nodes,
    edges: cullSmartEdges(scopedEdges, selectedId, SMART_CANVAS_EDGE_LIMIT),
  };
}

/**
 * Directories that conventionally mark the top of a source tree.
 *
 * Used to shorten an absolute path for display when nothing better is known.
 * `/src/` alone only ever matched npm, Cargo and Maven layouts — a Go module
 * (`cmd/`, `internal/`, `pkg/`) or a Ruby gem (`lib/`) fell through to a blind
 * "last three segments", which drops the part of the path that identifies the
 * file.
 */
const SOURCE_ROOT_MARKERS = [
  '/src/main/java/',
  '/src/main/kotlin/',
  '/src/',
  '/lib/',
  '/internal/',
  '/cmd/',
  '/pkg/',
  '/app/',
];

/**
 * Path relative to the node's npm-workspace package directory, or `undefined`
 * when the package label does not name one.
 *
 * Only `@wrongstack/…` and `app:…` labels can be turned back into a directory:
 * a Cargo crate, Maven artifact or Go module path need not match the folder
 * they live in.
 */
function workspaceRelativePath(node: GraphNodeData): string | undefined {
  const normalized = (node.file ?? node.label).replace(/\\/g, '/');
  const packageName = node.package ?? '';
  const packageSegment = packageName.startsWith('@wrongstack/')
    ? `/packages/${packageName.slice('@wrongstack/'.length)}/`
    : packageName.startsWith('app:')
      ? `/apps/${packageName.slice('app:'.length)}/`
      : undefined;
  if (!packageSegment) return undefined;
  const index = normalized.indexOf(packageSegment);
  return index >= 0 ? normalized.slice(index + packageSegment.length) : undefined;
}

export function relativeFilePath(node: GraphNodeData): string {
  const normalized = (node.file ?? node.label).replace(/\\/g, '/');
  const workspaceRelative = workspaceRelativePath(node);
  if (workspaceRelative !== undefined) return workspaceRelative;
  // Deepest marker wins, so `repo/src/x/internal/y.go` keeps `internal/y.go`
  // rather than the whole `src/…` tail.
  let best = -1;
  let bestEnd = 0;
  for (const marker of SOURCE_ROOT_MARKERS) {
    const index = normalized.lastIndexOf(marker);
    if (index > best) {
      best = index;
      bestEnd = index + marker.length;
    }
  }
  if (best >= 0) return normalized.slice(bestEnd);
  return normalized.split('/').slice(-3).join('/');
}

/**
 * Longest directory path shared by every file, as a prefix ending in `/`.
 * Empty when the files have no common directory (or there are fewer than two).
 */
function commonDirectoryPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const split = paths.map((value) => value.split('/'));
  const first = split[0] ?? [];
  let shared = 0;
  // Stop one short of the filename: a lone file must not have its own name
  // consumed as a directory.
  while (shared < first.length - 1) {
    const segment = first[shared];
    if (!split.every((parts) => parts.length - 1 > shared && parts[shared] === segment)) break;
    shared++;
  }
  return shared === 0 ? '' : `${first.slice(0, shared).join('/')}/`;
}

const directoryTreeCache = new WeakMap<GraphNodeData[], DirectoryNode>();

export function buildDirectoryTree(nodes: GraphNodeData[]): DirectoryNode {
  const cached = directoryTreeCache.get(nodes);
  if (cached) return cached;
  const root: DirectoryNode = { name: '', path: '', directories: [], files: [] };
  const local = nodes.filter((candidate) => candidate.kind === 'file' && !candidate.external);
  // An npm workspace package anchors on its own directory, which keeps the
  // familiar `src/…` shape. Every other ecosystem gets the exact shared prefix
  // of the files the package actually contains: no layout has to be guessed
  // at, and two files in different directories can never collapse onto one
  // tree node the way a fixed-depth truncation allows.
  const workspaceRelatives = local.map(workspaceRelativePath);
  const allAnchored = workspaceRelatives.every((value) => value !== undefined);
  const prefix = allAnchored
    ? ''
    : commonDirectoryPrefix(local.map((node) => (node.file ?? node.label).replace(/\\/g, '/')));

  for (const [index, node] of local.entries()) {
    const normalized = (node.file ?? node.label).replace(/\\/g, '/');
    const anchored = workspaceRelatives[index];
    const relative = allAnchored
      ? (anchored ?? relativeFilePath(node))
      : prefix && normalized.startsWith(prefix)
        ? normalized.slice(prefix.length)
        : relativeFilePath(node);
    const parts = relative.split('/').filter(Boolean);
    const fileName = parts.pop() ?? node.label;
    let cursor = root;
    for (const part of parts) {
      const path = cursor.path ? `${cursor.path}/${part}` : part;
      let directory = cursor.directories.find((entry) => entry.name === part);
      if (!directory) {
        directory = { name: part, path, directories: [], files: [] };
        cursor.directories.push(directory);
      }
      cursor = directory;
    }
    cursor.files.push({ ...node, label: fileName });
  }
  const sort = (directory: DirectoryNode): void => {
    directory.directories.sort((a, b) => a.name.localeCompare(b.name));
    directory.files.sort((a, b) => a.label.localeCompare(b.label));
    directory.directories.forEach(sort);
  };
  sort(root);
  directoryTreeCache.set(nodes, root);
  return root;
}

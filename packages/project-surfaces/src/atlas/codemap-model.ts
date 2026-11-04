type GraphNodeKind = 'package' | 'file' | 'symbol';
export type GraphRefType = 'call' | 'import' | 'type_ref' | 'inherit' | 'implement';

export interface GraphNodeData {
  id: string;
  label: string;
  kind: GraphNodeKind;
  package?: string | undefined;
  file?: string | undefined;
  symbolId?: number | undefined;
  symbolKind?: string | undefined;
  symbolCount?: number | undefined;
  fileCount?: number | undefined;
  lang?: string | undefined;
  line?: number | undefined;
  signature?: string | undefined;
  scope?: string | undefined;
  external?: boolean | undefined;
  /**
   * Global PageRank centrality, re-normalised to a 1.0 maximum within the
   * drill-down level being rendered. Absent until the rank pass has run.
   */
  rank?: number | undefined;
  /** Plain-language description from the concept layer, when enriched. */
  concept?: string | undefined;
  /** 1-based inclusive source span the concept summary was drawn from. */
  crux?: { start: number; end: number } | undefined;
  /** Subsystem this node belongs to, when one was derived. */
  subsystem?: string | undefined;
  /** `files.mtime_ms`, for recency shading. */
  lastModifiedMs?: number | undefined;
  /** Number of active SAGE memories anchored to this node. */
  memoryCount?: number | undefined;
  /** Active SAGE institutional memories anchored to this node. */
  memories?: Array<{ id: string; kind: string; text: string }> | undefined;
  /** True when WrongTrace marks this file as fragile / high-churn. */
  isFragile?: boolean | undefined;
  /** Number of recent edit/revert thrashing cycles reported by WrongTrace. */
  thrashingCount?: number | undefined;
  /** WrongTrace file health score (0..100). */
  healthScore?: number | undefined;
  /** Active WrongTrace file lock owner when locked by an agent. */
  lockOwner?: string | undefined;
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
  | { level: 'symbols'; file: string; package?: string | undefined };

export type CodeMapLayout = 'layers' | 'orbit' | 'subsystems';

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
// Reserve room for the persistent actions and optional concept summary.
const NODE_HEIGHT = 156;
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

export interface ShortestPathResult {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  nodeIds: Set<string>;
  directed: boolean;
}

/**
 * Find the shortest path between two graph nodes using BFS.
 * Tries a directed walk (`source -> target`) first unless `directed === false`;
 * when `mode === 'auto'` (the default), falls back to an undirected walk if no
 * directed path exists.
 */
export function findShortestPathBetweenNodes(
  graph: CodeMapGraphResponse,
  fromId: string,
  toId: string,
  options: { mode?: 'auto' | 'directed' | 'undirected' } = {},
): ShortestPathResult | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const startNode = byId.get(fromId);
  const endNode = byId.get(toId);
  if (!startNode || !endNode) return null;
  if (fromId === toId) {
    return {
      nodes: [startNode],
      edges: [],
      nodeIds: new Set([fromId]),
      directed: true,
    };
  }

  const runBfs = (directed: boolean): ShortestPathResult | null => {
    const queue: string[] = [fromId];
    const visited = new Set<string>([fromId]);
    const parent = new Map<string, { prevId: string; edge: GraphEdgeData }>();

    let cursor = 0;
    while (cursor < queue.length) {
      const current = queue[cursor++]!;
      if (current === toId) break;

      for (const edge of graph.edges) {
        let nextId: string | undefined;
        if (edge.source === current && byId.has(edge.target)) {
          nextId = edge.target;
        } else if (!directed && edge.target === current && byId.has(edge.source)) {
          nextId = edge.source;
        }
        if (!nextId || visited.has(nextId)) continue;
        visited.add(nextId);
        parent.set(nextId, { prevId: current, edge });
        queue.push(nextId);
      }
    }

    if (!visited.has(toId)) return null;

    const pathNodes: GraphNodeData[] = [];
    const pathEdges: GraphEdgeData[] = [];
    let curr: string | undefined = toId;
    while (curr !== undefined) {
      const node = byId.get(curr);
      if (node) pathNodes.push(node);
      const step = parent.get(curr);
      if (!step) break;
      pathEdges.push(step.edge);
      curr = step.prevId;
    }
    pathNodes.reverse();
    pathEdges.reverse();

    return {
      nodes: pathNodes,
      edges: pathEdges,
      nodeIds: new Set(pathNodes.map((n) => n.id)),
      directed,
    };
  };

  const mode = options.mode ?? 'auto';
  if (mode === 'directed') return runBfs(true);
  if (mode === 'undirected') return runBfs(false);
  return runBfs(true) ?? runBfs(false);
}

/**
 * Deterministic Louvain modularity clustering over a `CodeMapGraphResponse`.
 * Returns `nodeId -> communityLabel` for graphs that lack explicit subsystem
 * labels or collapse into a single band (e.g. file/symbol drill-down scopes).
 */
export function inferGraphCommunities(graph: CodeMapGraphResponse): Map<string, string> {
  const result = new Map<string, string>();
  const sortedNodes = [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = sortedNodes.length;
  if (n === 0) return result;

  const indexById = new Map<string, number>();
  for (let idx = 0; idx < sortedNodes.length; idx++) {
    indexById.set(sortedNodes[idx]!.id, idx);
  }

  const adj: Array<Map<number, number>> = Array.from(
    { length: n },
    () => new Map<number, number>(),
  );
  const degree = new Float64Array(n);
  let totalDoubleWeight = 0;

  for (const edge of graph.edges) {
    const u = indexById.get(edge.source);
    const v = indexById.get(edge.target);
    if (u === undefined || v === undefined || u === v) continue;
    const w = edge.weight > 0 ? edge.weight : 1;
    adj[u]!.set(v, (adj[u]!.get(v) ?? 0) + w);
    adj[v]!.set(u, (adj[v]!.get(u) ?? 0) + w);
    degree[u] = (degree[u] ?? 0) + w;
    degree[v] = (degree[v] ?? 0) + w;
    totalDoubleWeight += 2 * w;
  }

  if (totalDoubleWeight === 0) return result;

  const comm = new Int32Array(n);
  const sigmaTot = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    comm[i] = i;
    sigmaTot[i] = degree[i] ?? 0;
  }

  for (let pass = 0; pass < 10; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const ki = degree[i] ?? 0;
      if (ki === 0) continue;
      const cur = comm[i]!;
      sigmaTot[cur] = (sigmaTot[cur] ?? 0) - ki;

      const weights = new Map<number, number>([[cur, 0]]);
      for (const [nbr, w] of adj[i]!) {
        const c = comm[nbr]!;
        weights.set(c, (weights.get(c) ?? 0) + w);
      }

      let bestComm = cur;
      let bestGain = (weights.get(cur) ?? 0) - ((sigmaTot[cur] ?? 0) * ki) / totalDoubleWeight;
      for (const candidate of [...weights.keys()].sort((a, b) => a - b)) {
        const gain =
          (weights.get(candidate) ?? 0) - ((sigmaTot[candidate] ?? 0) * ki) / totalDoubleWeight;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          bestComm = candidate;
        }
      }

      sigmaTot[bestComm] = (sigmaTot[bestComm] ?? 0) + ki;
      if (bestComm !== cur) {
        comm[i] = bestComm;
        moved = true;
      }
    }
    if (!moved) break;
  }

  const membersByComm = new Map<number, GraphNodeData[]>();
  for (let i = 0; i < n; i++) {
    const c = comm[i]!;
    const list = membersByComm.get(c);
    if (list) list.push(sortedNodes[i]!);
    else membersByComm.set(c, [sortedNodes[i]!]);
  }

  for (const [, members] of membersByComm) {
    if (members.length < 2) continue;
    const hub = [...members].sort(
      (a, b) =>
        (b.rank ?? 0) - (a.rank ?? 0) ||
        (degree[indexById.get(b.id)!] ?? 0) - (degree[indexById.get(a.id)!] ?? 0) ||
        a.label.localeCompare(b.label),
    )[0]!;
    const label = `cluster:${hub.label}`;
    for (const m of members) {
      result.set(m.id, label);
    }
  }
  return result;
}

export interface BlastRadiusOverlay {
  /** 0-hop directly modified/selected node IDs. */
  direct: Set<string>;
  /** 1-hop incoming callers/dependents (`edge.target` in `direct`). */
  firstHop: Set<string>;
  /** 2-hop transitive callers/dependents (`edge.target` in `firstHop`). */
  secondHop: Set<string>;
  /** All impacted node IDs (`direct ∪ firstHop ∪ secondHop`). */
  allImpacted: Set<string>;
}

/**
 * Compute 0-hop, 1-hop, and 2-hop incoming blast-radius sets over a
 * `CodeMapGraphResponse` for visual diff / impact highlighting.
 */
export function computeBlastRadiusOverlay(
  graph: CodeMapGraphResponse,
  seedNodeIds: Iterable<string>,
): BlastRadiusOverlay {
  const validIds = new Set(graph.nodes.map((n) => n.id));
  const direct = new Set<string>();
  for (const id of seedNodeIds) {
    if (validIds.has(id)) direct.add(id);
  }

  const firstHop = new Set<string>();
  for (const edge of graph.edges) {
    if (direct.has(edge.target) && validIds.has(edge.source) && !direct.has(edge.source)) {
      firstHop.add(edge.source);
    }
  }

  const secondHop = new Set<string>();
  for (const edge of graph.edges) {
    if (
      firstHop.has(edge.target) &&
      validIds.has(edge.source) &&
      !direct.has(edge.source) &&
      !firstHop.has(edge.source)
    ) {
      secondHop.add(edge.source);
    }
  }

  const allImpacted = new Set<string>([...direct, ...firstHop, ...secondHop]);
  return { direct, firstHop, secondHop, allImpacted };
}

export type CanvasTourPersona = 'junior' | 'experienced' | 'non-technical';

export interface CanvasTourStep {
  order: number;
  node: GraphNodeData;
  stage: 'foundation' | 'hub' | 'entry';
  inCount: number;
  outCount: number;
  explanation: string;
}

/**
 * Build a dependency-ordered Guided Tour (`CanvasTourStep[]`) over the active
 * `CodeMapGraphResponse`: foundational dependencies first (high incoming, low
 * outgoing), followed by central hubs, and ending at top-level entry points.
 */
export function buildCanvasGuidedTour(
  graph: CodeMapGraphResponse,
  maxSteps = 8,
  persona: CanvasTourPersona = 'experienced',
): CanvasTourStep[] {
  const localNodes = graph.nodes.filter((n) => !n.external);
  const pool = localNodes.length > 0 ? localNodes : graph.nodes;
  if (pool.length === 0) return [];

  const inCounts = new Map<string, number>();
  const outCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    outCounts.set(edge.source, (outCounts.get(edge.source) ?? 0) + edge.weight);
    inCounts.set(edge.target, (inCounts.get(edge.target) ?? 0) + edge.weight);
  }

  const scored = pool.map((node) => {
    const inCount = inCounts.get(node.id) ?? 0;
    const outCount = outCounts.get(node.id) ?? 0;
    const importance = (node.rank ?? 0) * 10 + inCount + outCount;
    return { node, inCount, outCount, importance };
  });

  // Pick the most important nodes up to maxSteps, then sort foundation-first
  const top = [...scored]
    .sort((a, b) => b.importance - a.importance || a.node.label.localeCompare(b.node.label))
    .slice(0, Math.max(1, maxSteps));

  top.sort((a, b) => {
    const aFoundationRatio = (a.inCount + 1) / (a.outCount + 1);
    const bFoundationRatio = (b.inCount + 1) / (b.outCount + 1);
    return (
      bFoundationRatio - aFoundationRatio ||
      b.importance - a.importance ||
      a.node.label.localeCompare(b.node.label)
    );
  });

  return top.map((item, idx) => {
    let stage: CanvasTourStep['stage'] = 'hub';
    if (item.outCount === 0 || item.inCount >= item.outCount * 2) {
      stage = 'foundation';
    } else if (item.inCount === 0 && item.outCount > 0) {
      stage = 'entry';
    }
    const conceptPart = item.node.concept ? `${item.node.concept} ` : '';
    let explanation: string;
    if (persona === 'non-technical') {
      explanation = `${conceptPart}Serves ${item.inCount} upstream workflow(s) and coordinates ${item.outCount} downstream component(s).`;
    } else if (persona === 'junior') {
      const tip =
        stage === 'foundation'
          ? 'Start here (core building block).'
          : stage === 'entry'
            ? 'Top-level entry flow.'
            : 'Central architectural bridge.';
      explanation = `${conceptPart}${tip} (${item.inCount} in / ${item.outCount} out)`;
    } else {
      explanation =
        `${conceptPart}${item.inCount} incoming / ${item.outCount} outgoing connection(s)` +
        (item.node.rank !== undefined ? ` • rank ${item.node.rank.toFixed(2)}` : '');
    }
    return {
      order: idx + 1,
      node: item.node,
      stage,
      inCount: item.inCount,
      outCount: item.outCount,
      explanation,
    };
  });
}

/**
 * Slice a forward execution flow (`ShortestPathResult`) starting from
 * `startNodeId` by walking highest-weight outgoing edges up to `maxSteps`.
 */
export function sliceCanvasExecutionFlow(
  graph: CodeMapGraphResponse,
  startNodeId: string,
  maxSteps = 6,
): ShortestPathResult | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const startNode = byId.get(startNodeId);
  if (!startNode) return null;

  const nodes: GraphNodeData[] = [startNode];
  const edges: GraphEdgeData[] = [];
  const visited = new Set<string>([startNodeId]);
  let currentId = startNodeId;

  while (nodes.length < maxSteps) {
    const outgoing = graph.edges
      .filter((e) => e.source === currentId && e.target !== currentId && !visited.has(e.target))
      .sort((a, b) => b.weight - a.weight || a.target.localeCompare(b.target));
    const best = outgoing[0];
    if (!best) break;
    const nextNode = byId.get(best.target);
    if (!nextNode) break;
    visited.add(best.target);
    nodes.push(nextNode);
    edges.push(best);
    currentId = best.target;
  }

  return nodes.length >= 2
    ? { nodes, edges, nodeIds: new Set(nodes.map((n) => n.id)), directed: true }
    : null;
}

export interface GraphClusterSummary {
  name: string;
  count: number;
  memberIds: string[];
}

/**
 * Partition `graph.nodes` into named subsystem / Louvain community clusters.
 * Used for both the `subsystems` layout and two-stage collapsible cluster
 * containers.
 */
export function listGraphClusters(graph: CodeMapGraphResponse): GraphClusterSummary[] {
  const byCluster = new Map<string, GraphNodeData[]>();
  for (const node of graph.nodes) {
    const band = subsystemOf(node);
    const list = byCluster.get(band);
    if (list) list.push(node);
    else byCluster.set(band, [node]);
  }

  if (byCluster.size <= 1 && graph.nodes.length >= 4 && graph.edges.length > 0) {
    const inferred = inferGraphCommunities(graph);
    if (inferred.size >= 2) {
      byCluster.clear();
      for (const node of graph.nodes) {
        const band = node.subsystem ?? inferred.get(node.id) ?? node.package ?? UNGROUPED_BAND;
        const list = byCluster.get(band);
        if (list) list.push(node);
        else byCluster.set(band, [node]);
      }
    }
  }

  return [...byCluster.entries()]
    .map(([name, members]) => ({
      name,
      count: members.length,
      memberIds: members.map((m) => m.id),
    }))
    .sort((a, b) => {
      if (a.name === UNGROUPED_BAND) return 1;
      if (b.name === UNGROUPED_BAND) return -1;
      return b.count - a.count || a.name.localeCompare(b.name);
    });
}

/**
 * Two-stage hierarchical container projection: collapse any cluster in
 * `collapsedClusters` (with ≥ 2 members) into a single container `GraphNodeData`
 * and aggregate all cross-cluster edges.
 */
export function collapseGraphClusters(
  graph: CodeMapGraphResponse,
  collapsedClusters: ReadonlySet<string>,
): CodeMapGraphResponse {
  if (collapsedClusters.size === 0 || graph.nodes.length === 0) return graph;

  const clusters = listGraphClusters(graph);
  const memberToContainerId = new Map<string, string>();
  const containerNodes: GraphNodeData[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  for (const cluster of clusters) {
    if (!collapsedClusters.has(cluster.name) || cluster.count < 2) continue;
    const containerId = `cluster-container:${cluster.name}`;
    let maxRank = 0;
    let totalSyms = 0;
    for (const id of cluster.memberIds) {
      memberToContainerId.set(id, containerId);
      const member = byId.get(id);
      if (member) {
        if ((member.rank ?? 0) > maxRank) maxRank = member.rank ?? 0;
        totalSyms += member.symbolCount ?? (member.kind === 'symbol' ? 1 : 0);
      }
    }
    containerNodes.push({
      id: containerId,
      label: cluster.name,
      kind: 'package',
      subsystem: cluster.name,
      fileCount: cluster.count,
      symbolCount: totalSyms,
      rank: maxRank,
      concept: `Collapsed cluster container (${cluster.count} members)`,
    });
  }

  if (containerNodes.length === 0) return graph;

  const nextNodes: GraphNodeData[] = [
    ...containerNodes,
    ...graph.nodes.filter((n) => !memberToContainerId.has(n.id)),
  ];

  const edgeMap = new Map<string, GraphEdgeData>();
  for (const edge of graph.edges) {
    const src = memberToContainerId.get(edge.source) ?? edge.source;
    const tgt = memberToContainerId.get(edge.target) ?? edge.target;
    if (src === tgt) continue;
    const key = `${src}->${tgt}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight += edge.weight;
    } else {
      edgeMap.set(key, {
        source: src,
        target: tgt,
        weight: edge.weight,
        refType: edge.refType,
      });
    }
  }

  return {
    nodes: nextNodes,
    edges: [...edgeMap.values()],
  };
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
  if (layout === 'orbit') return orbitLayout(graph, focusId);
  if (layout === 'subsystems') return subsystemLayout(graph);
  return layeredLayout(graph);
}

/** Band that collects nodes belonging to no subsystem and no package. */
export const UNGROUPED_BAND = '(ungrouped)';

/** Band label for a node in the subsystem layout. */
export function subsystemOf(node: GraphNodeData): string {
  return node.subsystem ?? node.package ?? UNGROUPED_BAND;
}

/** Cards per row inside one subsystem band before it wraps. */
const BAND_COLUMNS = 6;
/** Vertical gap between two bands, on top of the row gap. */
const BAND_GAP = 96;

/**
 * Group nodes into horizontal bands, one per subsystem.
 *
 * The other two layouts answer "what depends on what". This one answers "what
 * is this repository made of" — the question a newcomer actually opens the map
 * with, and the one the concept layer exists to answer. Bands are ordered by
 * the centrality they contain, so the subsystem that carries the codebase is
 * the first thing on screen rather than whichever package sorts first
 * alphabetically.
 */
function subsystemLayout(graph: CodeMapGraphResponse): PositionedGraphNode[] {
  if (graph.nodes.length === 0) return [];
  const degrees = graphDegrees(graph, new Set(graph.nodes.map((node) => node.id)));
  const weightOf = (node: GraphNodeData): number => node.rank ?? (degrees.get(node.id) ?? 0) / 1000;

  const bands = new Map<string, GraphNodeData[]>();
  for (const node of graph.nodes) {
    const band = subsystemOf(node);
    const bucket = bands.get(band);
    if (bucket === undefined) bands.set(band, [node]);
    else bucket.push(node);
  }

  // When all nodes lack explicit subsystem/package labels (or collapse into a
  // single band inside a file/symbol scope), partition using deterministic
  // Louvain community detection so coupled clusters form distinct visual bands.
  if (bands.size <= 1 && graph.nodes.length >= 4 && graph.edges.length > 0) {
    const inferred = inferGraphCommunities(graph);
    if (inferred.size >= 2) {
      bands.clear();
      for (const node of graph.nodes) {
        const band = node.subsystem ?? inferred.get(node.id) ?? node.package ?? UNGROUPED_BAND;
        const bucket = bands.get(band);
        if (bucket === undefined) bands.set(band, [node]);
        else bucket.push(node);
      }
    }
  }

  const ordered = [...bands.entries()]
    .map(([name, nodes]) => ({
      name,
      nodes: [...nodes].sort(
        (left, right) => weightOf(right) - weightOf(left) || left.label.localeCompare(right.label),
      ),
      weight: nodes.reduce((total, node) => total + weightOf(node), 0),
    }))
    // The catch-all band is never the headline, however much it happens to
    // contain — it is the absence of a grouping, not a grouping.
    .sort((left, right) => {
      if (left.name === UNGROUPED_BAND) return 1;
      if (right.name === UNGROUPED_BAND) return -1;
      return right.weight - left.weight || left.name.localeCompare(right.name);
    });

  const positioned: PositionedGraphNode[] = [];
  let y = 0;
  for (const band of ordered) {
    band.nodes.forEach((node, index) => {
      positioned.push({
        node,
        position: {
          x: (index % BAND_COLUMNS) * (NODE_WIDTH + X_GAP / 2),
          y: y + Math.floor(index / BAND_COLUMNS) * (NODE_HEIGHT + Y_GAP),
        },
      });
    });
    const rows = Math.ceil(band.nodes.length / BAND_COLUMNS);
    y += rows * (NODE_HEIGHT + Y_GAP) + BAND_GAP;
  }
  return positioned;
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
    // Edge weight inside the current scope is a local proxy for importance;
    // PageRank is the real thing, computed over the whole index. Prefer it
    // when the rank pass has run, and keep the proxy for indexes where it has
    // not — a scope where no node carries a rank must not sort by a column
    // that is uniformly undefined.
    const hasRank = graph.nodes.some((node) => node.rank !== undefined);
    const importance = (node: GraphNodeData): number =>
      hasRank ? (node.rank ?? 0) : (scores.get(node.id) ?? 0);
    const ranked = [...graph.nodes].sort(
      (left, right) =>
        importance(right) - importance(left) || left.label.localeCompare(right.label),
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

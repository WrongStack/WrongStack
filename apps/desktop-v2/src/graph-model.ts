import { entries, record } from './engine-values';

export interface VisualNode {
  id: string;
  label: string;
  detail: string;
  group: string;
  weight: number;
  data: Record<string, unknown>;
}
export interface VisualEdge {
  source: string;
  target: string;
  label: string;
  weight: number;
}
export interface VisualGraph {
  nodes: VisualNode[];
  edges: VisualEdge[];
}
export interface PlacedNode extends VisualNode {
  x: number;
  y: number;
}
export function atlasGraph(value: unknown): VisualGraph {
  const raw = record(value);
  const nodes = entries(raw['nodes'])
    .filter((node) => typeof node['id'] === 'string' && typeof node['label'] === 'string')
    .map((node) => ({
      id: String(node['id']),
      label: String(node['label']),
      detail: String(
        node['concept'] ??
          (node['kind'] === 'symbol'
            ? `${node['symbolKind'] ?? 'symbol'}${typeof node['line'] === 'number' ? ` · line ${node['line']}` : ''}`
            : node['kind'] === 'package'
              ? `${node['fileCount'] ?? 0} files · ${node['symbolCount'] ?? 0} symbols`
              : `${node['lang'] ?? 'file'} · ${node['symbolCount'] ?? 0} symbols`),
      ),
      group: String(node['subsystem'] ?? node['package'] ?? node['kind'] ?? 'Code'),
      weight: Number(node['rank'] ?? 0),
      data: node,
    }));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = entries(raw['edges'])
    .filter((edge) => ids.has(String(edge['source'])) && ids.has(String(edge['target'])))
    .map((edge) => ({
      source: String(edge['source']),
      target: String(edge['target']),
      label: String(edge['refType'] ?? 'dependency'),
      weight: Number(edge['weight'] ?? 1),
    }));
  return { nodes, edges };
}
export function memoryGraph(
  memories: Record<string, unknown>[],
  relations: unknown[] = [],
): VisualGraph {
  const nodes = new Map<string, VisualNode>();
  const edges: VisualEdge[] = [];
  for (const memory of memories) {
    if (typeof memory['id'] !== 'string') continue;
    const id = `mem:${memory['id']}`;
    nodes.set(id, {
      id,
      label: String(memory['text'] ?? 'Untitled memory'),
      detail:
        Array.isArray(memory['tags']) && memory['tags'].length
          ? memory['tags'].slice(0, 3).join(' · ')
          : String(memory['status'] ?? 'Project memory'),
      group: String(memory['kind'] ?? 'fact'),
      weight: Number(memory['importance'] ?? 0.5),
      data: memory,
    });
    for (const tag of Array.isArray(memory['tags']) ? memory['tags'] : []) {
      if (typeof tag !== 'string' || !tag.trim()) continue;
      const target = `tag:${tag}`;
      nodes.set(target, {
        id: target,
        label: tag,
        detail: 'Shared topic',
        group: 'topic',
        weight: 0.2,
        data: { tag },
      });
      edges.push({ source: id, target, label: 'tagged', weight: 1 });
    }
    for (const anchor of entries(memory['anchors'])) {
      const path = anchor['path'] ?? anchor['file'] ?? anchor['filePath'];
      if (typeof path !== 'string') continue;
      const target = `file:${path}`;
      nodes.set(target, {
        id: target,
        label: path.split(/[/\\]/).at(-1) ?? path,
        detail: path,
        group: 'file',
        weight: 0.3,
        data: anchor,
      });
      edges.push({ source: id, target, label: 'anchored to', weight: 1 });
    }
  }
  for (const value of relations) {
    const edge = record(value);
    const source = String(edge['from'] ?? '');
    const target = String(edge['to'] ?? '');
    if (nodes.has(source) && nodes.has(target))
      edges.push({
        source,
        target,
        label: String(edge['relation'] ?? edge['type'] ?? 'related'),
        weight: Number(edge['weight'] ?? 1),
      });
  }
  return {
    nodes: [...nodes.values()],
    edges: [
      ...new Map(
        edges.map((edge) => [`${edge.source}:${edge.target}:${edge.label}`, edge]),
      ).values(),
    ],
  };
}
/** A visible rendering budget keeps selected nodes and traced paths reachable. Null means all. */
export function graphScope(
  graph: VisualGraph,
  selected = '',
  path: string[] = [],
  limit: number | null = 160,
): VisualGraph {
  if (limit === null || graph.nodes.length <= limit) return graph;
  const available = new Set(graph.nodes.map((n) => n.id));
  const keep = new Set([selected, ...path].filter((id) => available.has(id)));
  const budget = Math.max(limit, keep.size);
  const neighbors = new Set(
    graph.edges
      .filter((e) => e.source === selected || e.target === selected)
      .flatMap((e) => [e.source, e.target]),
  );
  const priority = [...graph.nodes].sort(
    (a, b) =>
      Number(neighbors.has(b.id)) - Number(neighbors.has(a.id)) ||
      b.weight - a.weight ||
      a.id.localeCompare(b.id),
  );
  for (const node of priority) {
    if (keep.size >= budget) break;
    keep.add(node.id);
  }
  return {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}
/** Stable clusters, then bounded force relaxation. Coordinates never depend on wall time. */
export function placeGraph(
  graph: VisualGraph,
  layout: 'clusters' | 'layers' | 'orbit' = 'clusters',
): PlacedNode[] {
  const ordered = [...graph.nodes].sort(
    (a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id),
  );
  const groups = [...new Set(ordered.map((node) => node.group))];
  if (layout === 'orbit')
    return ordered.map((node, index) => ({
      ...node,
      x:
        550 +
        Math.cos((index / Math.max(1, ordered.length)) * Math.PI * 2) *
          Math.max(220, Math.sqrt(ordered.length) * 90),
      y:
        360 +
        Math.sin((index / Math.max(1, ordered.length)) * Math.PI * 2) *
          Math.max(170, Math.sqrt(ordered.length) * 70),
    }));
  if (layout === 'layers') {
    const ids = new Set(ordered.map((node) => node.id)),
      levels = new Map<string, number>(),
      indegree = new Map(ordered.map((node) => [node.id, 0]));
    const edges = graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    for (const edge of edges) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    const outgoing = new Map<string, VisualEdge[]>();
    for (const edge of edges) {
      const list = outgoing.get(edge.source);
      if (list) list.push(edge);
      else outgoing.set(edge.source, [edge]);
    }
    const queue = ordered.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
    for (const id of queue) levels.set(id, 0);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!;
      for (const edge of outgoing.get(id) ?? []) {
        levels.set(edge.target, Math.max(levels.get(edge.target) ?? 0, (levels.get(id) ?? 0) + 1));
        indegree.set(edge.target, (indegree.get(edge.target) ?? 1) - 1);
        if (indegree.get(edge.target) === 0) queue.push(edge.target);
      }
    }
    const rows = new Map<number, number>();
    const counts = new Map<number, number>();
    for (const node of ordered) {
      const level = levels.get(node.id) ?? 0;
      counts.set(level, (counts.get(level) ?? 0) + 1);
    }
    const offsets = new Map<number, number>();
    let offset = 130;
    for (const level of [...counts.keys()].sort((a, b) => a - b)) {
      offsets.set(level, offset);
      const count = counts.get(level)!;
      const height = count > 16 ? Math.ceil(Math.sqrt(count)) : count;
      offset += Math.max(1, Math.ceil(count / Math.max(1, height))) * 240 + 80;
    }
    return ordered.map((node) => {
      const level = levels.get(node.id) ?? 0,
        row = rows.get(level) ?? 0;
      rows.set(level, row + 1);
      const count = counts.get(level) ?? 1;
      const height = count > 16 ? Math.ceil(Math.sqrt(count)) : count;
      return {
        ...node,
        x: (offsets.get(level) ?? 130) + Math.floor(row / height) * 240,
        y: 90 + (row % height) * 130,
      };
    });
  }
  // Lookups stay linear: a full-scope map can hold tens of thousands of nodes.
  const groupIndexes = new Map(groups.map((group, index) => [group, index]));
  const placedInGroup = new Map<string, number>();
  const nodes = ordered.map((node, index) => {
    const groupIndex = groupIndexes.get(node.group) ?? 0;
    const peerIndex = placedInGroup.get(node.group) ?? 0;
    placedInGroup.set(node.group, peerIndex + 1);
    const theta = peerIndex * 2.399963;
    const radius = 65 + Math.sqrt(peerIndex) * 80;
    const groupAngle = (groupIndex / Math.max(1, groups.length)) * Math.PI * 2;
    return {
      ...node,
      x:
        550 +
        Math.cos(groupAngle) * (groups.length > 1 ? 260 : 0) +
        Math.cos(theta) * radius +
        (index % 3),
      y: 360 + Math.sin(groupAngle) * (groups.length > 1 ? 210 : 0) + Math.sin(theta) * radius,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // Large full-scope maps retain every node with deterministic cluster placement.
  // Bounded relaxation is reserved for smaller maps to avoid quadratic force work.
  if (nodes.length > 300) return nodes;
  for (let step = 0; step < 90; step++) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        const other = nodes[j]!;
        const dx = other.x - node.x || 0.1;
        const dy = other.y - node.y || 0.1;
        const distance = Math.max(1, Math.hypot(dx, dy));
        if (distance < 220) {
          const force = (220 - distance) * 0.045;
          node.x -= (dx / distance) * force;
          node.y -= (dy / distance) * force;
          other.x += (dx / distance) * force;
          other.y += (dy / distance) * force;
        }
      }
    }
    for (const edge of graph.edges) {
      const a = byId.get(edge.source);
      const b = byId.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const force = (distance - 245) * 0.008;
      a.x += (dx / distance) * force;
      a.y += (dy / distance) * force;
      b.x -= (dx / distance) * force;
      b.y -= (dy / distance) * force;
    }
  }
  return nodes;
}

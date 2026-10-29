import type { VisualGraph } from './graph-model';

const MAX_ROUNDS = 30;
export const UNCONNECTED = 'Unconnected';

/** True when the index stored a subsystem or package for at least one node. */
export function hasStoredGroups(graph: VisualGraph): boolean {
  return graph.nodes.some(
    (node) =>
      (typeof node.data['subsystem'] === 'string' && node.data['subsystem']) ||
      (typeof node.data['package'] === 'string' && node.data['package']),
  );
}

const folderOf = (path: string) => {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
};

/**
 * Groups nodes into communities found from the stored references alone (deterministic
 * weighted label propagation over the undirected reference graph). Nothing is linked that the
 * index did not store: a node without references lands in "Unconnected". Each community is
 * named after the folder most of its files share, else its highest-ranked member, and every
 * name is prefixed "Inferred" so it is never mistaken for a stored subsystem.
 */
export function inferCommunities(graph: VisualGraph): VisualGraph {
  const ids = graph.nodes.map((node) => node.id).sort();
  const neighbours = new Map<string, Map<string, number>>(ids.map((id) => [id, new Map()]));
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    const from = neighbours.get(edge.source),
      to = neighbours.get(edge.target);
    if (!from || !to) continue;
    const weight = Number.isFinite(edge.weight) && edge.weight > 0 ? edge.weight : 1;
    from.set(edge.target, (from.get(edge.target) ?? 0) + weight);
    to.set(edge.source, (to.get(edge.source) ?? 0) + weight);
  }
  const label = new Map(ids.map((id) => [id, id]));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false;
    for (const id of ids) {
      const scores = new Map<string, number>();
      for (const [peer, weight] of neighbours.get(id)!)
        scores.set(label.get(peer)!, (scores.get(label.get(peer)!) ?? 0) + weight);
      if (!scores.size) continue;
      let best = label.get(id)!,
        bestScore = scores.get(best) ?? 0;
      for (const [candidate, score] of [...scores].sort(([a], [b]) => a.localeCompare(b)))
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const members = new Map<string, VisualGraph['nodes']>();
  for (const node of graph.nodes) {
    const key = neighbours.get(node.id)!.size ? label.get(node.id)! : UNCONNECTED;
    members.set(key, [...(members.get(key) ?? []), node]);
  }
  const names = new Map<string, string>();
  const used = new Map<string, number>();
  for (const [key, nodes] of [...members].sort(([a], [b]) => a.localeCompare(b))) {
    if (key === UNCONNECTED) {
      names.set(key, UNCONNECTED);
      continue;
    }
    const folders = new Map<string, number>();
    for (const node of nodes) {
      const file = typeof node.data['file'] === 'string' ? node.data['file'] : '';
      const folder = folderOf(file || (node.data['kind'] === 'file' ? node.label : ''));
      if (folder) folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }
    const [folder, count] = [...folders].sort(
      ([a, x], [b, y]) => y - x || a.localeCompare(b),
    )[0] ?? ['', 0];
    const top = [...nodes].sort(
      (a, b) => b.weight - a.weight || a.label.localeCompare(b.label),
    )[0]!;
    const base = `Inferred: ${folder && count * 2 >= nodes.length ? folder : `around ${top.label}`}`;
    const seen = (used.get(base) ?? 0) + 1;
    used.set(base, seen);
    names.set(key, seen > 1 ? `${base} (${seen})` : base);
  }
  return {
    nodes: graph.nodes.map((node) => ({
      ...node,
      group: names.get(neighbours.get(node.id)!.size ? label.get(node.id)! : UNCONNECTED)!,
    })),
    edges: graph.edges,
  };
}

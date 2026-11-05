import type { VisualGraph, VisualNode } from './graph-model';

/** How a collapsed subsystem card is worded; the page supplies the display language. */
export interface BoundaryWords {
  group: string;
  detail: (members: number, internal: number) => string;
}

const englishWords: BoundaryWords = {
  group: 'Subsystem',
  detail: (members, internal) =>
    `${members} ${members === 1 ? 'node' : 'nodes'} · ${internal} internal ${internal === 1 ? 'reference' : 'references'}`,
};

/** Project only stored references; internal collapsed edges remain in group metrics. */
export function atlasBoundaries(
  graph: VisualGraph,
  expanded: ReadonlySet<string>,
  words: BoundaryWords = englishWords,
) {
  const members = new Map<string, VisualNode[]>();
  const groupOf = new Map<string, string>();
  for (const node of graph.nodes) {
    const list = members.get(node.group) ?? [];
    list.push(node);
    members.set(node.group, list);
    groupOf.set(node.id, node.group);
  }
  const internals = new Map<string, number>();
  for (const edge of graph.edges) {
    const group = groupOf.get(edge.source);
    if (group !== undefined && group === groupOf.get(edge.target))
      internals.set(group, (internals.get(group) ?? 0) + 1);
  }
  const owner = new Map<string, string>();
  const groups = new Map<string, string>();
  const nodes: VisualNode[] = [];
  for (const [name, entries] of members) {
    // Original and container identities occupy disjoint namespaces.
    const id = JSON.stringify(['group', name]);
    groups.set(id, name);
    if (expanded.has(name)) {
      for (const node of entries) {
        const projected = JSON.stringify(['node', node.id]);
        owner.set(node.id, projected);
        nodes.push({ ...node, id: projected, data: { ...node.data, originalId: node.id } });
      }
    } else {
      for (const node of entries) owner.set(node.id, id);
      const internal = internals.get(name) ?? 0;
      nodes.push({
        id,
        label: name,
        group: words.group,
        detail: words.detail(entries.length, internal),
        weight: Math.max(0, ...entries.map((node) => node.weight)),
        data: { kind: 'subsystem', memberCount: entries.length },
      });
    }
  }
  const links = new Map<
    string,
    { source: string; target: string; kind: string; count: number; weight: number }
  >();
  for (const edge of graph.edges) {
    const source = owner.get(edge.source),
      target = owner.get(edge.target);
    if (!source || !target || (source === target && groups.has(source))) continue;
    const key = JSON.stringify([source, target, edge.label]);
    const previous = links.get(key);
    links.set(key, {
      source,
      target,
      kind: edge.label,
      count: (previous?.count ?? 0) + 1,
      weight: (previous?.weight ?? 0) + edge.weight,
    });
  }
  return {
    groups,
    graph: {
      nodes,
      edges: [...links.values()].map(({ source, target, kind, count, weight }) => ({
        source,
        target,
        label: `${kind} · ${count} references`,
        weight,
      })),
    } satisfies VisualGraph,
  };
}

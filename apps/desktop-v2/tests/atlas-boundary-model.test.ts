import { describe, expect, it } from 'vitest';
import { atlasBoundaries } from '../src/atlas-boundary-model';
import type { VisualGraph, VisualNode } from '../src/graph-model';

const node = (id: string, group: string): VisualNode => ({
  id,
  group,
  label: id,
  detail: 'Code',
  weight: 1,
  data: { kind: 'file' },
});
const graph: VisualGraph = {
  nodes: [
    node('a', 'Client'),
    node('b', 'Client'),
    node('c', 'Engine'),
    node('["group","Client"]', 'Empty'),
  ],
  edges: [
    { source: 'a', target: 'b', label: 'imports', weight: 2 },
    { source: 'a', target: 'c', label: 'imports', weight: 3 },
    { source: 'b', target: 'c', label: 'imports', weight: 4 },
    { source: 'c', target: 'a', label: 'calls', weight: 5 },
    { source: 'a', target: 'c', label: 'calls', weight: 6 },
    { source: 'missing', target: 'c', label: 'imports', weight: 8 },
  ],
};
describe('Atlas boundary exploration', () => {
  it('keeps direction and relation kinds distinct, sums weights, and hides only closed internal edges', () => {
    const projected = atlasBoundaries(graph, new Set());
    expect(projected.graph.nodes).toHaveLength(3);
    expect(projected.graph.nodes.find((n) => n.label === 'Client')?.detail).toBe(
      '2 nodes · 1 internal reference',
    );
    expect(projected.graph.edges).toHaveLength(3);
    const client = JSON.stringify(['group', 'Client']),
      engine = JSON.stringify(['group', 'Engine']);
    expect(projected.graph.edges).toContainEqual({
      source: client,
      target: engine,
      label: 'imports · 2 references',
      weight: 7,
    });
    expect(projected.graph.edges).toContainEqual({
      source: engine,
      target: client,
      label: 'calls · 1 references',
      weight: 5,
    });
    expect(graph.edges).toHaveLength(6);
  });
  it('restores real members and internal references when expanded without identity collisions', () => {
    const expanded = atlasBoundaries(graph, new Set(['Client', 'Empty', 'stale-group']));
    expect(expanded.graph.nodes).toHaveLength(4);
    expect(new Set(expanded.graph.nodes.map((n) => n.id)).size).toBe(4);
    expect(expanded.graph.nodes.find((n) => n.data['originalId'] === 'a')?.id).toBe(
      JSON.stringify(['node', 'a']),
    );
    expect(expanded.graph.edges).toHaveLength(5);
    expect(
      expanded.graph.edges.some(
        (edge) =>
          edge.source === JSON.stringify(['node', 'a']) &&
          edge.target === JSON.stringify(['node', 'b']),
      ),
    ).toBe(true);
    expect(atlasBoundaries({ nodes: [], edges: [] }, new Set()).graph).toEqual({
      nodes: [],
      edges: [],
    });
  });
});

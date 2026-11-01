import { describe, expect, it } from 'vitest';
import { atlasGraph, graphScope, memoryGraph, placeGraph } from '../src/graph-model';

describe('project visual models', () => {
  it('places every supplied atlas node, including a dependency beyond the first 160 records', () => {
    const graph = atlasGraph({
      nodes: Array.from({ length: 181 }, (_, i) => ({
        id: `file-${i}`,
        label: `File ${i}`,
        kind: 'file',
      })),
      edges: [{ source: 'file-0', target: 'file-180' }],
    });
    const placed = placeGraph(graph, 'layers');
    expect(placed).toHaveLength(181);
    expect(placed.find((n) => n.id === 'file-180')).toBeDefined();
  });
  it('uses real topic, file, and stored memory relationships without inventing links', () => {
    const graph = memoryGraph(
      [
        {
          id: 'a',
          text: 'Use the encrypted vault.',
          kind: 'decision',
          tags: ['security'],
          anchors: [{ path: 'src/vault.ts' }],
        },
        { id: 'b', text: 'Keep keys out of logs.', kind: 'fact', tags: ['security'] },
      ],
      [
        { from: 'mem:a', to: 'mem:b', relation: 'supports' },
        { from: 'mem:a', to: 'mem:missing', relation: 'supports' },
      ],
    );
    expect(graph.nodes.map((node) => node.id)).toEqual([
      'mem:a',
      'tag:security',
      'file:src/vault.ts',
      'mem:b',
    ]);
    expect(graph.edges.map((edge) => edge.label)).toEqual([
      'tagged',
      'anchored to',
      'tagged',
      'supports',
    ]);
    expect(memoryGraph([{ id: 'a', text: 'Standalone' }]).edges).toEqual([]);
  });
  it('drops atlas edges whose endpoints are outside the returned graph', () => {
    const graph = atlasGraph({
      nodes: [
        { id: 'a', label: 'alpha', kind: 'package' },
        { id: 'b', label: 'beta', kind: 'package' },
        null,
        { label: 'invalid' },
      ],
      edges: [
        { source: 'a', target: 'b', refType: 'import', weight: 2 },
        { source: 'a', target: 'missing' },
      ],
    });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([{ source: 'a', target: 'b', label: 'import', weight: 2 }]);
    expect(atlasGraph(null)).toEqual({ nodes: [], edges: [] });
  });
  it('keeps layouts deterministic, finite, bounded, and usable for isolated nodes', () => {
    const graph = memoryGraph(
      Array.from({ length: 180 }, (_, index) => ({
        id: `memory-${index}`,
        text: `Decision ${index}`,
        kind: index % 2 ? 'fact' : 'decision',
        tags: [`topic-${index % 4}`],
      })),
    );
    const placed = placeGraph(graph);
    expect(placed).toHaveLength(graph.nodes.length);
    expect(placed).toEqual(placeGraph(graph));
    expect(placed.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(placeGraph({ nodes: [], edges: [] })).toEqual([]);
    expect(placeGraph(memoryGraph([{ id: 'one', text: 'One memory' }]))).toHaveLength(1);
  });
  it('keeps a selected node and traced path in Smart scope while All preserves the full graph', () => {
    const graph = atlasGraph({
      nodes: Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` })),
      edges: [
        { source: 'n199', target: 'n198' },
        { source: 'n198', target: 'n197' },
      ],
    });
    const smart = graphScope(graph, 'n199', ['n199', 'n198', 'n197'], 10);
    expect(smart.nodes).toHaveLength(10);
    expect(smart.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['n199', 'n198', 'n197']));
    expect(smart.edges).toEqual(graph.edges);
    expect(graphScope(graph, 'n199', [], null)).toBe(graph);
  });

  it('lays out a 20,000-node full-scope map without quadratic work', () => {
    const n = 20000;
    const graph = {
      nodes: Array.from({ length: n }, (_, i) => ({
        id: `n${i}`,
        label: `n${i}`,
        detail: '',
        group: `g${i % 20}`,
        weight: 1,
        data: {},
      })),
      // An import-like DAG: every edge points forward.
      edges: Array.from({ length: n * 3 }, (_, i) => ({
        source: `n${i % n}`,
        target: `n${Math.min(n - 1, (i % n) + 1 + (i % 50))}`,
        label: '',
        weight: 1,
      })),
    };
    // Quadratic placement took seconds here; linear placement takes tens of milliseconds.
    for (const layout of ['clusters', 'layers'] as const) {
      const start = performance.now();
      expect(placeGraph(graph, layout)).toHaveLength(n);
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });
});

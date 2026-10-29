import { describe, expect, it } from 'vitest';
import { hasStoredGroups, inferCommunities, UNCONNECTED } from '../src/atlas-communities';
import type { VisualGraph } from '../src/graph-model';

const file = (path: string, rank = 0) => ({
  id: path,
  label: path,
  detail: '',
  group: 'file',
  weight: rank,
  data: { kind: 'file', file: path },
});
const edge = (source: string, target: string, weight = 1) => ({
  source,
  target,
  label: 'import',
  weight,
});

describe('inferred Atlas communities', () => {
  const graph: VisualGraph = {
    nodes: [
      file('src/a/one.ts'),
      file('src/a/two.ts'),
      file('src/a/three.ts'),
      file('src/b/four.ts', 5),
      file('src/b/five.ts'),
      file('lib/six.ts'),
      file('README.ts'),
    ],
    edges: [
      edge('src/a/one.ts', 'src/a/two.ts'),
      edge('src/a/two.ts', 'src/a/three.ts'),
      edge('src/a/three.ts', 'src/a/one.ts'),
      edge('src/b/four.ts', 'src/b/five.ts', 3),
      edge('lib/six.ts', 'src/b/four.ts'),
      // A single weak bridge does not merge the two clusters.
      edge('src/a/one.ts', 'src/b/five.ts'),
    ],
  };

  it('finds clusters from stored references only and names them by their shared folder', () => {
    const inferred = inferCommunities(graph);
    const group = (id: string) => inferred.nodes.find((node) => node.id === id)!.group;
    expect(group('src/a/one.ts')).toBe('Inferred: src/a');
    expect(group('src/a/three.ts')).toBe('Inferred: src/a');
    expect(group('src/b/four.ts')).toBe('Inferred: src/b');
    expect(group('lib/six.ts')).toBe('Inferred: src/b');
    expect(group('README.ts')).toBe(UNCONNECTED);
    // Edges are kept exactly as stored.
    expect(inferred.edges).toBe(graph.edges);
  });

  it('is deterministic regardless of node and edge order', () => {
    const shuffled: VisualGraph = {
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    };
    const groups = (value: VisualGraph) =>
      Object.fromEntries(inferCommunities(value).nodes.map((node) => [node.id, node.group]));
    expect(groups(shuffled)).toEqual(groups(graph));
  });

  it('falls back to the top-ranked member when no folder is shared by most', () => {
    const scattered: VisualGraph = {
      nodes: [file('x/a.ts', 1), file('y/b.ts', 9), file('z/c.ts')],
      edges: [edge('x/a.ts', 'y/b.ts'), edge('y/b.ts', 'z/c.ts')],
    };
    expect(new Set(inferCommunities(scattered).nodes.map((node) => node.group))).toEqual(
      new Set(['Inferred: around y/b.ts']),
    );
  });

  it('detects stored subsystem or package grouping', () => {
    expect(hasStoredGroups(graph)).toBe(false);
    expect(
      hasStoredGroups({
        nodes: [{ ...file('a.ts'), data: { kind: 'file', subsystem: 'core' } }],
        edges: [],
      }),
    ).toBe(true);
  });
});

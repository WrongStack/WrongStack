import { describe, expect, it } from 'vitest';
import {
  _clearNormalizedPathCacheForTests,
  _normalizedPathCacheSizeForTests,
  buildDirectoryTree,
  type CodeMapGraphResponse,
  type GraphEdgeData,
  type GraphNodeData,
  layoutGraph,
  normalizedPath,
  SMART_CANVAS_EDGE_LIMIT,
  SMART_CANVAS_NODE_LIMIT,
  smartCanvasGraph,
} from '../../src/components/codemap-model';

function graphNode(index: number): GraphNodeData {
  return {
    id: `node:${index}`,
    label: `node-${index}`,
    kind: 'symbol',
  };
}

describe('codemap model', () => {
  it('bounds the module-level normalized path cache', () => {
    _clearNormalizedPathCacheForTests();
    for (let index = 0; index < 5_000; index++) {
      normalizedPath(`C:\\repo\\file-${index}.ts`);
    }
    expect(_normalizedPathCacheSizeForTests()).toBe(4_096);
  });

  it('lays out a dense graph with a linear number of edge-index reads', () => {
    const nodes = Array.from({ length: 120 }, (_, index) => graphNode(index));
    let endpointReads = 0;
    const edges: GraphEdgeData[] = [];
    for (let source = 0; source < nodes.length; source++) {
      for (let offset = 1; offset <= 4 && source + offset < nodes.length; offset++) {
        const sourceId = nodes[source]!.id;
        const targetId = nodes[source + offset]!.id;
        edges.push({
          get source() {
            endpointReads += 1;
            return sourceId;
          },
          get target() {
            endpointReads += 1;
            return targetId;
          },
          weight: offset,
          refType: 'call',
        });
      }
    }

    const positioned = layoutGraph({ nodes, edges }, 'layers');

    expect(positioned).toHaveLength(nodes.length);
    expect(new Set(positioned.map((entry) => entry.node.id)).size).toBe(nodes.length);
    expect(endpointReads).toBeLessThan(edges.length * 20);
  });

  it('keeps cyclic islands spread across multiple layers', () => {
    const nodes = Array.from({ length: 6 }, (_, index) => graphNode(index));
    const edges = nodes.map((node, index) => ({
      source: node.id,
      target: nodes[(index + 1) % nodes.length]!.id,
      weight: 1,
      refType: 'call' as const,
    }));

    const positioned = layoutGraph({ nodes, edges }, 'layers');

    expect(new Set(positioned.map((entry) => entry.position.x)).size).toBeGreaterThan(1);
    expect(new Set(positioned.map((entry) => `${entry.position.x}:${entry.position.y}`)).size).toBe(
      nodes.length,
    );
  });

  it('reuses an immutable directory tree for the same graph payload', () => {
    const nodes: CodeMapGraphResponse['nodes'] = [
      {
        id: 'file:a',
        label: 'a.ts',
        kind: 'file',
        package: '@wrongstack/core',
        file: '/workspace/packages/core/src/a.ts',
      },
      {
        id: 'file:b',
        label: 'b.ts',
        kind: 'file',
        package: '@wrongstack/core',
        file: '/workspace/packages/core/src/nested/b.ts',
      },
    ];

    const first = buildDirectoryTree(nodes);
    const second = buildDirectoryTree(nodes);

    expect(second).toBe(first);
    expect(first.directories[0]?.name).toBe('src');
    expect(first.directories[0]?.directories[0]?.name).toBe('nested');
  });

  it('anchors a non-npm package on the directory its files actually share', () => {
    // A Go package label is an import path, not a folder, so the npm anchor
    // cannot apply. Truncating to the last few segments used to merge distinct
    // directories; the shared prefix keeps them apart.
    const nodes: CodeMapGraphResponse['nodes'] = [
      {
        id: 'file:main',
        label: 'main.go',
        kind: 'file',
        package: 'example.com/demo/cmd',
        file: '/repo/go/cmd/app/main.go',
      },
      {
        id: 'file:util',
        label: 'util.go',
        kind: 'file',
        package: 'example.com/demo/cmd',
        file: '/repo/go/cmd/worker/util.go',
      },
    ];

    const tree = buildDirectoryTree(nodes);
    expect(tree.directories.map((entry) => entry.name).sort()).toEqual(['app', 'worker']);
    expect(tree.directories.find((entry) => entry.name === 'app')?.files[0]?.label).toBe('main.go');
  });

  it('smartCanvasGraph caps nodes and edges while preserving the selection neighbourhood', () => {
    const nodes = Array.from({ length: 200 }, (_, index) => graphNode(index));
    const edges: GraphEdgeData[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = 1; j <= 3 && i + j < nodes.length; j++) {
        edges.push({
          source: nodes[i]!.id,
          target: nodes[i + j]!.id,
          weight: 4 - j,
          refType: 'call',
        });
      }
    }
    // Dense hub around node 0 so selection neighbourhood is non-trivial.
    for (let i = 1; i < 40; i++) {
      edges.push({
        source: nodes[0]!.id,
        target: nodes[i]!.id,
        weight: 10,
        refType: 'import',
      });
    }

    const smart = smartCanvasGraph({ nodes, edges }, nodes[0]!.id, 'smart');
    expect(smart.nodes.length).toBeLessThanOrEqual(SMART_CANVAS_NODE_LIMIT);
    expect(smart.edges.length).toBeLessThanOrEqual(SMART_CANVAS_EDGE_LIMIT);
    expect(smart.nodes.some((node) => node.id === nodes[0]!.id)).toBe(true);
    // Focused edges for the selection should not be dropped by the edge budget.
    expect(
      smart.edges.some((edge) => edge.source === nodes[0]!.id || edge.target === nodes[0]!.id),
    ).toBe(true);

    const all = smartCanvasGraph({ nodes, edges }, nodes[0]!.id, 'all');
    expect(all.nodes).toHaveLength(nodes.length);
    expect(all.edges).toHaveLength(edges.length);
  });

  it('smartCanvasGraph culls edges even when node count is already under the limit', () => {
    const nodes = Array.from({ length: 20 }, (_, index) => graphNode(index));
    const edges: GraphEdgeData[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        edges.push({
          source: nodes[i]!.id,
          target: nodes[j]!.id,
          weight: (i + j) % 7,
          refType: 'call',
        });
      }
    }
    expect(edges.length).toBeGreaterThan(SMART_CANVAS_EDGE_LIMIT);

    const smart = smartCanvasGraph({ nodes, edges }, null, 'smart');
    expect(smart.nodes).toHaveLength(nodes.length);
    expect(smart.edges.length).toBeLessThanOrEqual(SMART_CANVAS_EDGE_LIMIT);
  });
});

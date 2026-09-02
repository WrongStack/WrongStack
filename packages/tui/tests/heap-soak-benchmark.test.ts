import { describe, expect, it } from 'vitest';
import { analyzeHeapSnapshot } from '../bench/heap-snapshot-dominators.js';
import {
  HEAP_SOAK_SEED,
  buildHeapSoakWorkload,
  heapSoakWorkloadFingerprint,
  workloadCharacterCount,
} from '../bench/heap-soak-workload.js';

function fixtureSnapshot(): unknown {
  // Root -> A -> B is strong; Root -weak-> C must not retain C.
  // V8 edge targets point to offsets in the flattened node array.
  return {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
        node_types: [['synthetic', 'object'], 'string', 'number', 'number', 'number'],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [['property', 'weak'], 'string_or_number', 'node'],
      },
      node_count: 4,
      edge_count: 3,
    },
    nodes: [
      0,
      0,
      1,
      0,
      2, // root; two edges
      1,
      1,
      2,
      10,
      1, // A; one edge
      1,
      2,
      3,
      20,
      0, // B
      1,
      3,
      4,
      40,
      0, // C; weak-only, unreachable
    ],
    edges: [
      0,
      4,
      5, // root --property--> A
      1,
      5,
      15, // root --weak--> C
      0,
      6,
      10, // A --property--> B
    ],
    strings: ['(root)', 'A', 'B', 'C', 'a', 'weakC', 'b'],
  };
}

describe('TUI heap-soak workload', () => {
  it('replays identical content for the same seed and entry count', () => {
    const first = buildHeapSoakWorkload({ entryCount: 137, seed: HEAP_SOAK_SEED });
    const second = buildHeapSoakWorkload({ entryCount: 137, seed: HEAP_SOAK_SEED });

    expect(second).toEqual(first);
    expect(first).toHaveLength(137);
    expect(first.map((entry) => entry.id)).toEqual(
      Array.from({ length: 137 }, (_, index) => index + 1),
    );
    expect(heapSoakWorkloadFingerprint(second)).toBe(heapSoakWorkloadFingerprint(first));
    expect(workloadCharacterCount(first)).toBeGreaterThan(10_000);
  });

  it('changes its fingerprint when the seed or requested size changes', () => {
    const baseline = buildHeapSoakWorkload({ entryCount: 40, seed: HEAP_SOAK_SEED });
    const otherSeed = buildHeapSoakWorkload({ entryCount: 40, seed: HEAP_SOAK_SEED + 1 });
    const otherSize = buildHeapSoakWorkload({ entryCount: 41, seed: HEAP_SOAK_SEED });

    expect(heapSoakWorkloadFingerprint(otherSeed)).not.toBe(heapSoakWorkloadFingerprint(baseline));
    expect(heapSoakWorkloadFingerprint(otherSize)).not.toBe(heapSoakWorkloadFingerprint(baseline));
  });

  it('rejects invalid sizes instead of producing a partial workload', () => {
    expect(() => buildHeapSoakWorkload({ entryCount: -1 })).toThrow(/entryCount/);
    expect(() => buildHeapSoakWorkload({ entryCount: 1.5 })).toThrow(/entryCount/);
  });
});

describe('heap snapshot dominators', () => {
  it('computes retained sizes and excludes weak-only reachability', () => {
    const report = analyzeHeapSnapshot(fixtureSnapshot(), 'fixture.heapsnapshot', 10);

    expect(report).toMatchObject({
      snapshotPath: 'fixture.heapsnapshot',
      nodeCount: 4,
      edgeCount: 3,
      reachableNodeCount: 3,
      reachableSelfSize: 30,
      ignoredWeakEdges: 1,
    });
    expect(report.dominators.slice(0, 2)).toEqual([
      expect.objectContaining({
        rank: 1,
        name: 'A',
        selfSize: 10,
        retainedSize: 30,
        dominatedNodes: 2,
      }),
      expect.objectContaining({
        rank: 2,
        name: 'B',
        selfSize: 20,
        retainedSize: 20,
        dominatedNodes: 1,
      }),
    ]);
    expect(report.dominators.some((entry) => entry.name === 'C')).toBe(false);
  });

  it('finds the root as the immediate dominator of a diamond join', () => {
    const snapshot = {
      snapshot: {
        meta: {
          node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
          node_types: [['synthetic', 'object'], 'string', 'number', 'number', 'number'],
          edge_fields: ['type', 'name_or_index', 'to_node'],
          edge_types: [['property', 'weak'], 'string_or_number', 'node'],
        },
        node_count: 4,
        edge_count: 4,
      },
      nodes: [
        0,
        0,
        1,
        0,
        2, // root -> left, right
        1,
        1,
        2,
        10,
        1, // left -> join
        1,
        2,
        3,
        20,
        1, // right -> join
        1,
        3,
        4,
        40,
        0, // join
      ],
      edges: [0, 4, 5, 0, 5, 10, 0, 6, 15, 0, 6, 15],
      strings: ['(root)', 'left', 'right', 'join', 'leftEdge', 'rightEdge', 'joinEdge'],
    };

    const report = analyzeHeapSnapshot(snapshot, 'diamond.heapsnapshot', 10);
    expect(report.dominators).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'join', retainedSize: 40, dominatedNodes: 1 }),
        expect.objectContaining({ name: 'right', retainedSize: 20, dominatedNodes: 1 }),
        expect.objectContaining({ name: 'left', retainedSize: 10, dominatedNodes: 1 }),
      ]),
    );
  });

  it('validates flattened node and edge lengths', () => {
    const fixture = fixtureSnapshot() as { nodes: number[] };
    fixture.nodes.pop();
    expect(() => analyzeHeapSnapshot(fixture)).toThrow(/node array length/);
  });
});

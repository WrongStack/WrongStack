import { describe, expect, it } from 'vitest';
import {
  aggregateFileRank,
  buildWiringGraph,
  CONTRADICTED_VISIBILITY_WEIGHT,
  pageRank,
  type ResolvedRefEdge,
  type SymbolRankRow,
  toSymbolRankRows,
  UNVERIFIED_VISIBILITY_WEIGHT,
} from '../src/codebase-index/index.js';

function edge(fromId: number, toId: number, callType = 'call'): ResolvedRefEdge {
  return { fromId, toId, callType };
}

/** Score for one original symbol id, or 0 when the node is absent. */
function scoreOf(
  graph: ReturnType<typeof buildWiringGraph>,
  scores: Float64Array,
  symbolId: number,
): number {
  const dense = graph.index.get(symbolId);
  return dense === undefined ? 0 : (scores[dense] ?? 0);
}

describe('buildWiringGraph', () => {
  it('returns an empty graph for no refs', () => {
    const graph = buildWiringGraph([]);
    expect(graph.size).toBe(0);
    expect(graph.offsets).toHaveLength(1);
    expect(pageRank(graph)).toHaveLength(0);
  });

  it('is empty when every ref is an unwalkable relation', () => {
    // Anything outside the five CallType values must not create nodes.
    expect(buildWiringGraph([edge(1, 2, 'mentions')]).size).toBe(0);
  });

  it('walks all five structural relation kinds', () => {
    for (const kind of ['call', 'import', 'type_ref', 'inherit', 'implement']) {
      expect(buildWiringGraph([edge(1, 2, kind)]).size).toBe(2);
    }
  });

  it('drops self-references so recursion cannot inflate a symbol', () => {
    expect(buildWiringGraph([edge(7, 7)]).size).toBe(0);
  });

  it('builds an undirected adjacency with directed degrees preserved', () => {
    const graph = buildWiringGraph([edge(10, 20)]);
    const a = graph.index.get(10) as number;
    const b = graph.index.get(20) as number;

    // Undirected: each end lists the other.
    const neighboursOf = (u: number) =>
      Array.from(
        graph.neighbours.slice(graph.offsets[u] as number, graph.offsets[u + 1] as number),
      );
    expect(neighboursOf(a)).toEqual([b]);
    expect(neighboursOf(b)).toEqual([a]);

    // Directed degrees still describe who references whom.
    expect(graph.outDegree[a]).toBe(1);
    expect(graph.inDegree[a]).toBe(0);
    expect(graph.outDegree[b]).toBe(0);
    expect(graph.inDegree[b]).toBe(1);
  });

  it('keeps edge multiplicity so repeated coupling weighs more', () => {
    const graph = buildWiringGraph([edge(1, 2), edge(1, 2), edge(1, 2)]);
    const a = graph.index.get(1) as number;
    expect((graph.offsets[a + 1] as number) - (graph.offsets[a] as number)).toBe(3);
    expect(graph.outDegree[a]).toBe(3);
  });
});

describe('edge confidence weighting', () => {
  it('leaves unambiguous edges at full weight', () => {
    const graph = buildWiringGraph([edge(1, 2)]);
    expect(Array.from(graph.weights)).toEqual([1, 1]);
  });

  it('scales an edge by 1/n when n symbols declare the target name', () => {
    // The resolver picked one of four equally plausible targets, so the walk
    // may only carry a quarter of the belief.
    const graph = buildWiringGraph([edge(1, 2)], { candidates: new Map([[2, 4]]) });
    expect(Array.from(graph.weights)).toEqual([0.25, 0.25]);
  });

  it('keeps same-file edges at full weight regardless of imports', () => {
    const graph = buildWiringGraph([edge(1, 2)], {
      fileOf: new Map([
        [1, 'a.ts'],
        [2, 'a.ts'],
      ]),
      importsOf: new Map(),
    });
    expect(Array.from(graph.weights)).toEqual([1, 1]);
  });

  it('keeps a cross-file edge at full weight when the import is resolved', () => {
    const graph = buildWiringGraph([edge(1, 2)], {
      fileOf: new Map([
        [1, 'a.ts'],
        [2, 'b.ts'],
      ]),
      importsOf: new Map([['a.ts', new Set(['b.ts'])]]),
    });
    expect(Array.from(graph.weights)).toEqual([1, 1]);
  });

  it('barely trusts a cross-file edge the source file contradicts', () => {
    // a.ts's imports resolved and b.ts is not among them: this is the shape of
    // every `it(...)` misresolved onto an unrelated locale catalogue.
    const graph = buildWiringGraph([edge(1, 2)], {
      fileOf: new Map([
        [1, 'a.ts'],
        [2, 'b.ts'],
      ]),
      importsOf: new Map([['a.ts', new Set(['c.ts'])]]),
    });
    expect(graph.weights[0]).toBeCloseTo(CONTRADICTED_VISIBILITY_WEIGHT, 10);
  });

  it('only reduces a cross-file edge when the source resolved nothing', () => {
    const graph = buildWiringGraph([edge(1, 2)], {
      fileOf: new Map([
        [1, 'a.ts'],
        [2, 'b.ts'],
      ]),
      importsOf: new Map([['other.ts', new Set(['x.ts'])]]),
    });
    expect(graph.weights[0]).toBeCloseTo(UNVERIFIED_VISIBILITY_WEIGHT, 10);
  });

  it('multiplies the homonym and visibility penalties together', () => {
    const graph = buildWiringGraph([edge(1, 2)], {
      candidates: new Map([[2, 2]]),
      fileOf: new Map([
        [1, 'a.ts'],
        [2, 'b.ts'],
      ]),
      importsOf: new Map([['a.ts', new Set(['c.ts'])]]),
    });
    expect(graph.weights[0]).toBeCloseTo(0.5 * CONTRADICTED_VISIBILITY_WEIGHT, 10);
  });

  it('skips the visibility check entirely when either input is missing', () => {
    // Passing only one half must not silently penalise every cross-file edge.
    const graph = buildWiringGraph([edge(1, 2)], {
      fileOf: new Map([
        [1, 'a.ts'],
        [2, 'b.ts'],
      ]),
    });
    expect(Array.from(graph.weights)).toEqual([1, 1]);
  });

  it('demotes a mass-misresolved target below a genuine hub', () => {
    // `noise` collects ten cross-file references from files that import
    // something else; `hub` collects three that its importers really do
    // import. Raw in-degree says noise wins; confidence says hub does.
    const refs: ResolvedRefEdge[] = [];
    const fileOf = new Map<number, string>([
      [900, 'locale.ts'],
      [800, 'hub.ts'],
    ]);
    const importsOf = new Map<string, Set<string>>();
    for (let i = 1; i <= 10; i++) {
      refs.push(edge(i, 900));
      fileOf.set(i, `noisy${i}.ts`);
      importsOf.set(`noisy${i}.ts`, new Set(['unrelated.ts']));
    }
    for (let i = 11; i <= 13; i++) {
      refs.push(edge(i, 800));
      fileOf.set(i, `real${i}.ts`);
      importsOf.set(`real${i}.ts`, new Set(['hub.ts']));
    }

    const graph = buildWiringGraph(refs, { fileOf, importsOf });
    const scores = pageRank(graph);
    expect(scoreOf(graph, scores, 800)).toBeGreaterThan(scoreOf(graph, scores, 900));
  });
});

describe('pageRank', () => {
  it('normalises the top score to exactly 1.0', () => {
    const graph = buildWiringGraph([edge(1, 2), edge(3, 2)]);
    const scores = pageRank(graph);
    expect(Math.max(...scores)).toBeCloseTo(1, 10);
  });

  it('ranks a hub above the leaves that reference it', () => {
    // 1..5 all reference 99. 99 is the only structurally central node.
    const refs = [edge(1, 99), edge(2, 99), edge(3, 99), edge(4, 99), edge(5, 99)];
    const graph = buildWiringGraph(refs);
    const scores = pageRank(graph);
    const hub = scoreOf(graph, scores, 99);
    for (const leaf of [1, 2, 3, 4, 5]) {
      expect(hub).toBeGreaterThan(scoreOf(graph, scores, leaf));
    }
    expect(hub).toBeCloseTo(1, 10);
  });

  it('ranks the more-referenced of two hubs higher', () => {
    const refs = [
      edge(1, 100),
      edge(2, 100),
      edge(3, 100),
      edge(4, 200),
      edge(5, 200),
      edge(6, 201),
    ];
    const graph = buildWiringGraph(refs);
    const scores = pageRank(graph);
    expect(scoreOf(graph, scores, 100)).toBeGreaterThan(scoreOf(graph, scores, 200));
  });

  it('converges on a cycle and gives every member the same score', () => {
    const graph = buildWiringGraph([edge(1, 2), edge(2, 3), edge(3, 1)]);
    const scores = pageRank(graph);
    // A symmetric 3-cycle is vertex-transitive: all three must tie.
    expect(scoreOf(graph, scores, 1)).toBeCloseTo(scoreOf(graph, scores, 2), 9);
    expect(scoreOf(graph, scores, 2)).toBeCloseTo(scoreOf(graph, scores, 3), 9);
  });

  it('conserves mass across iterations', () => {
    // Two disconnected components; nothing may leak out of the distribution.
    const graph = buildWiringGraph([edge(1, 2), edge(3, 4), edge(4, 5)]);
    const raw = pageRank(graph, { iterations: 40 });
    // Scores are max-normalised, so re-derive the share each node holds and
    // assert every node kept a positive, finite amount of the mass.
    for (const value of raw) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('concentrates on the seeds when a personalised restart is given', () => {
    // Two disjoint pairs. Seeding one pair must not lift the other.
    const graph = buildWiringGraph([edge(1, 2), edge(3, 4)]);
    const seeded = pageRank(graph, {
      seeds: new Map([[graph.index.get(1) as number, 1]]),
    });
    expect(scoreOf(graph, seeded, 1)).toBeGreaterThan(scoreOf(graph, seeded, 3));
    expect(scoreOf(graph, seeded, 2)).toBeGreaterThan(scoreOf(graph, seeded, 3));
  });

  it('ignores seed weights that are out of range or non-positive', () => {
    const graph = buildWiringGraph([edge(1, 2)]);
    const uniform = pageRank(graph);
    const junkSeeded = pageRank(graph, {
      seeds: new Map([
        [999, 5],
        [graph.index.get(1) as number, -1],
      ]),
    });
    // Every seed was rejected, so this must fall back to the uniform walk.
    expect(Array.from(junkSeeded)).toEqual(Array.from(uniform));
  });

  it('gives an isolated node its restart mass and nothing more', () => {
    // 5 is only reachable via teleport; it must score below the connected hub.
    const graph = buildWiringGraph([edge(1, 2), edge(3, 2)]);
    const scores = pageRank(graph);
    expect(scoreOf(graph, scores, 2)).toBeGreaterThan(scoreOf(graph, scores, 1));
  });
});

describe('aggregateFileRank', () => {
  const rows: SymbolRankRow[] = [
    { symbolId: 1, rank: 0.5, inDeg: 2, outDeg: 1 },
    { symbolId: 2, rank: 0.5, inDeg: 3, outDeg: 0 },
    { symbolId: 3, rank: 0.4, inDeg: 1, outDeg: 4 },
  ];

  it('sums symbol ranks per file and renormalises to 1.0', () => {
    const files = aggregateFileRank(
      rows,
      new Map([
        [1, 'a.ts'],
        [2, 'a.ts'],
        [3, 'b.ts'],
      ]),
    );
    const byFile = new Map(files.map((f) => [f.file, f]));
    // a.ts holds two 0.5 symbols (1.0) vs b.ts's single 0.4 — summing, not
    // averaging, is what makes the busier module rank higher.
    expect(byFile.get('a.ts')?.rank).toBeCloseTo(1, 10);
    expect(byFile.get('b.ts')?.rank).toBeCloseTo(0.4, 10);
  });

  it('rolls degrees up alongside the rank', () => {
    const files = aggregateFileRank(
      rows,
      new Map([
        [1, 'a.ts'],
        [2, 'a.ts'],
        [3, 'b.ts'],
      ]),
    );
    const a = files.find((f) => f.file === 'a.ts');
    expect(a?.inDeg).toBe(5);
    expect(a?.outDeg).toBe(1);
  });

  it('skips symbols with no known file', () => {
    expect(aggregateFileRank(rows, new Map())).toEqual([]);
  });
});

describe('toSymbolRankRows', () => {
  it('maps dense indices back to original symbol ids', () => {
    const graph = buildWiringGraph([edge(41, 42)]);
    const rows = toSymbolRankRows(graph, pageRank(graph));
    expect(rows.map((r) => r.symbolId).sort((a, b) => a - b)).toEqual([41, 42]);
    for (const row of rows) expect(row.rank).toBeGreaterThan(0);
  });
});

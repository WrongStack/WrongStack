/**
 * Graph centrality over the symbol wiring graph.
 *
 * Two modes share one implementation:
 *
 *  - **Global** — computed once per index run with a uniform restart
 *    distribution, persisted to `symbol_rank` / `file_rank`. Answers "what is
 *    architecturally central in this repo", and drives the repo map, the
 *    CodeMap node sizing and the atlas projection.
 *  - **Personalised** — computed per query with the lexical (BM25) hit scores
 *    as the restart distribution. Answers "what is central *to this query*".
 *    Lexical search proposes the seeds; the graph decides the ordering.
 *
 * The walk runs over an **undirected** view of the graph: a caller and its
 * callee are mutually relevant when you are trying to understand either one,
 * and a directed walk starves leaf utilities that everything depends on.
 * Directed in/out degrees are still reported separately, because they are
 * what a human reads as "blast radius" vs "coupling".
 *
 * Only refs that resolved to a real symbol id participate. At the time of
 * writing roughly a third of this repo's refs stay unresolved (stdlib and
 * third-party targets that were never indexed); including them would mean
 * walking to nodes that carry no code.
 *
 * Edge multiplicity is deliberately preserved. Five calls from A to B produce
 * five edges, so B receives five shares of A's mass: repeated coupling is
 * stronger coupling. Self-references are dropped — recursion should not make
 * a symbol important on its own account.
 *
 * ## Why edges carry a confidence weight
 *
 * The index resolves a ref by matching `to_name` to the lowest symbol id in
 * the same language family — it is not file- or import-aware, which
 * `findIncomingCallsByName` already documents as an ambiguity source. For a
 * per-query answer that is a caveat; for a global ranking it is fatal. On this
 * repo roughly half of all resolved refs point at a name that several symbols
 * declare, and the worst offenders are test globals and single-letter locals:
 * every `it(...)` in the suite lands on whichever `it` happens to hold the
 * lowest id, handing that one symbol thousands of incoming edges it never had.
 *
 * So an edge into a name that `n` symbols declare carries weight `1 / n`: the
 * resolver guessed one of `n` equally plausible targets, and the walk spreads
 * exactly that much belief. Unique names — the half we can actually trust —
 * keep full weight.
 *
 * Homonym counting alone is not enough, because the worst misresolutions are
 * to names that really are unique. Every `it(...)` in the test suite resolves
 * to the one `const it: Catalog` in the desktop app's i18n file — the Italian
 * locale — handing a translation table 5,500 incoming edges. Nothing declares
 * a competing `it`, so no homonym penalty applies.
 *
 * The second weight is therefore visibility, in three tiers. An edge is fully
 * trusted when the two symbols share a file, or when the source file actually
 * imports the target's file — the module resolver already recorded those pairs
 * in `refs.to_file`. Otherwise the question is whether we can believe the
 * absence of that import:
 *
 *  - The source file has resolved imports, and the target's file is not among
 *    them. The resolver worked here and still did not connect these two files,
 *    so the reference almost certainly is not to this symbol
 *    ({@link CONTRADICTED_VISIBILITY_WEIGHT}).
 *  - The source file has no resolved imports at all. Resolution failed
 *    wholesale for it, so its silence is not evidence either way, and the edge
 *    keeps a reduced but meaningful weight
 *    ({@link UNVERIFIED_VISIBILITY_WEIGHT}).
 *
 * These stay penalties rather than filters: module resolution only resolves
 * about three fifths of this repo's import specifiers, and dropping the rest
 * outright would gut the graph.
 *
 * Both of these are ranking-quality fixes, not resolver fixes; making ref
 * resolution import-aware would remove the need for either.
 */

/** Ref shape as returned by `IndexStore.getAllResolvedRefs()`. */
export interface ResolvedRefEdge {
  fromId: number;
  toId: number;
  callType: string;
}

/**
 * Compressed sparse row adjacency over a dense node numbering.
 *
 * `neighbours[offsets[u] .. offsets[u + 1]]` are the dense indices adjacent to
 * dense node `u`. `ids[u]` maps back to the original symbol id.
 */
export interface WiringGraph {
  /** Number of nodes. */
  size: number;
  /** Original symbol id for each dense index. */
  ids: Int32Array;
  /** Dense index for each original symbol id. */
  index: Map<number, number>;
  /** CSR row offsets, length `size + 1`. */
  offsets: Int32Array;
  /** CSR adjacency entries, length `offsets[size]`. */
  neighbours: Int32Array;
  /**
   * Confidence per adjacency entry, parallel to `neighbours`, in `(0, 1]`.
   *
   * This attenuates rather than redistributes: an edge with confidence `c`
   * carries `c` of the mass it would otherwise carry, and the remaining
   * `1 - c` returns to the restart distribution as belief the walk declined
   * to place. Normalising these away — dividing each node's split by the sum
   * of its weights — would make them inert, because a node with a single
   * low-confidence edge would still hand over all of its mass.
   */
  weights: Float64Array;
  /** Directed in-degree per dense node (how many symbols reference it). */
  inDegree: Int32Array;
  /** Directed out-degree per dense node (how many symbols it references). */
  outDegree: Int32Array;
}

export interface PageRankOptions {
  /**
   * Restart (teleport) probability — the share of mass that returns to the
   * restart distribution each iteration. Higher keeps the walk closer to its
   * seeds. 0.25 is the value Graft settled on for code graphs; the classic
   * web-PageRank 0.15 wanders too far for personalised queries.
   */
  restart?: number;
  /** Power iterations. 25 converges comfortably at this graph size. */
  iterations?: number;
  /**
   * Seed weights by **dense index**, for a personalised walk. Weights need not
   * be normalised. Omitted (or empty) means a uniform restart distribution.
   */
  seeds?: ReadonlyMap<number, number> | undefined;
}

export const DEFAULT_RESTART = 0.25;
export const DEFAULT_ITERATIONS = 25;

/**
 * Weight for a cross-file edge from a file whose imports never resolved. We
 * cannot corroborate the edge, but we cannot contradict it either.
 */
export const UNVERIFIED_VISIBILITY_WEIGHT = 0.25;

/**
 * Weight for a cross-file edge from a file whose imports DID resolve, to a
 * file it does not import. Near-zero rather than zero so a single resolver
 * miss degrades one edge instead of erasing it.
 */
export const CONTRADICTED_VISIBILITY_WEIGHT = 0.02;

/**
 * Ref kinds that count as a structural connection. All five of the index's
 * `CallType` values qualify: an `import` couples two modules just as an
 * `inherit` couples two classes.
 */
const WALK_RELATIONS: ReadonlySet<string> = new Set([
  'call',
  'import',
  'type_ref',
  'inherit',
  'implement',
]);

/**
 * Build the undirected CSR wiring graph from the resolved ref list.
 *
 * Two passes over the edge list (count, then fill) so the adjacency lands in
 * flat typed arrays with no intermediate per-node arrays — at 180k edges the
 * array-of-arrays shape costs more in allocation than the walk itself.
 */
export interface WiringGraphOptions {
  /**
   * How many symbols declare the name each target symbol carries, keyed by
   * target symbol id. Absent ids are treated as unambiguous (weight 1).
   */
  candidates?: ReadonlyMap<number, number> | undefined;
  /** Declaring file per symbol id, used for the visibility check. */
  fileOf?: ReadonlyMap<number, string> | undefined;
  /** Files each source file imports, as resolved by the module resolver. */
  importsOf?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
}

export function buildWiringGraph(
  refs: readonly ResolvedRefEdge[],
  options: WiringGraphOptions = {},
): WiringGraph {
  const index = new Map<number, number>();
  const idList: number[] = [];

  const intern = (id: number): number => {
    const existing = index.get(id);
    if (existing !== undefined) return existing;
    const dense = idList.length;
    index.set(id, dense);
    idList.push(id);
    return dense;
  };

  // Pass 1 — intern endpoints and record the kept edges densely.
  const candidates = options.candidates;
  const fileOf = options.fileOf;
  const importsOf = options.importsOf;
  const checkVisibility = fileOf !== undefined && importsOf !== undefined;
  const from: number[] = [];
  const to: number[] = [];
  const weight: number[] = [];
  for (const ref of refs) {
    if (!WALK_RELATIONS.has(ref.callType)) continue;
    if (ref.fromId === ref.toId) continue;
    from.push(intern(ref.fromId));
    to.push(intern(ref.toId));

    const homonyms = candidates?.get(ref.toId) ?? 1;
    let w = homonyms > 1 ? 1 / homonyms : 1;

    if (checkVisibility) {
      const sourceFile = fileOf.get(ref.fromId);
      const targetFile = fileOf.get(ref.toId);
      // Unknown files are left at full weight: absence of evidence about a
      // symbol we did not index is not evidence the edge is wrong.
      if (sourceFile !== undefined && targetFile !== undefined && sourceFile !== targetFile) {
        const imports = importsOf.get(sourceFile);
        if (imports === undefined) {
          w *= UNVERIFIED_VISIBILITY_WEIGHT;
        } else if (!imports.has(targetFile)) {
          w *= CONTRADICTED_VISIBILITY_WEIGHT;
        }
      }
    }
    weight.push(w);
  }

  const size = idList.length;
  const ids = Int32Array.from(idList);
  const offsets = new Int32Array(size + 1);
  const inDegree = new Int32Array(size);
  const outDegree = new Int32Array(size);

  if (size === 0) {
    return {
      size: 0,
      ids,
      index,
      offsets,
      neighbours: new Int32Array(0),
      weights: new Float64Array(0),
      inDegree,
      outDegree,
    };
  }

  // Pass 2 — undirected degree counts (each edge contributes to both ends).
  const counts = new Int32Array(size);
  for (let e = 0; e < from.length; e++) {
    const u = from[e] as number;
    const v = to[e] as number;
    counts[u] = (counts[u] as number) + 1;
    counts[v] = (counts[v] as number) + 1;
    outDegree[u] = (outDegree[u] as number) + 1;
    inDegree[v] = (inDegree[v] as number) + 1;
  }

  let running = 0;
  for (let u = 0; u < size; u++) {
    offsets[u] = running;
    running += counts[u] as number;
  }
  offsets[size] = running;

  // Pass 3 — fill, using a moving cursor per row. Both directions of an edge
  // carry the same confidence: the uncertainty is in the resolution, not in
  // which way you read it.
  const cursor = offsets.slice(0, size);
  const neighbours = new Int32Array(running);
  const weights = new Float64Array(running);
  for (let e = 0; e < from.length; e++) {
    const u = from[e] as number;
    const v = to[e] as number;
    const w = weight[e] as number;
    const cu = cursor[u] as number;
    neighbours[cu] = v;
    weights[cu] = w;
    cursor[u] = cu + 1;
    const cv = cursor[v] as number;
    neighbours[cv] = u;
    weights[cv] = w;
    cursor[v] = cv + 1;
  }

  return { size, ids, index, offsets, neighbours, weights, inDegree, outDegree };
}

/**
 * Power-iterate PageRank over `graph`, returning scores normalised so the
 * highest is exactly 1.0. Nodes the walk never reaches score 0.
 *
 * Mass is conserved exactly: every node hands `restart` of its mass back to
 * the restart distribution, spreads the rest over its neighbours, and a node
 * with no neighbours hands everything back. Low-confidence edges return their
 * unspent share to the same pool. Without it the total would leak downwards
 * and the final normalisation would hide the leak.
 */
export function pageRank(graph: WiringGraph, options: PageRankOptions = {}): Float64Array {
  const { size, offsets, neighbours, weights } = graph;
  const scores = new Float64Array(size);
  if (size === 0) return scores;

  const restart = options.restart ?? DEFAULT_RESTART;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const walk = 1 - restart;

  // Restart distribution: seeded when given, uniform otherwise.
  const restartDist = new Float64Array(size);
  const seeds = options.seeds;
  let seedTotal = 0;
  if (seeds && seeds.size > 0) {
    for (const [node, weight] of seeds) {
      if (node < 0 || node >= size) continue;
      if (!(weight > 0)) continue;
      restartDist[node] = (restartDist[node] as number) + weight;
      seedTotal += weight;
    }
  }
  if (seedTotal > 0) {
    for (let u = 0; u < size; u++) restartDist[u] = (restartDist[u] as number) / seedTotal;
  } else {
    restartDist.fill(1 / size);
  }

  let current = Float64Array.from(restartDist);
  let next = new Float64Array(size);

  for (let iter = 0; iter < iterations; iter++) {
    next.fill(0);
    let teleport = 0;
    for (let u = 0; u < size; u++) {
      const mass = current[u] as number;
      if (mass === 0) continue;
      teleport += restart * mass;
      const start = offsets[u] as number;
      const end = offsets[u + 1] as number;
      const degree = end - start;
      if (degree === 0) {
        teleport += walk * mass;
        continue;
      }
      // Split evenly across neighbours, then attenuate each transfer by its
      // confidence. Whatever confidence declined to carry is not silently
      // dropped — it teleports, so the distribution still sums to one.
      const outgoing = walk * mass;
      const share = outgoing / degree;
      let moved = 0;
      for (let e = start; e < end; e++) {
        const target = neighbours[e] as number;
        const transfer = share * (weights[e] as number);
        next[target] = (next[target] as number) + transfer;
        moved += transfer;
      }
      teleport += outgoing - moved;
    }
    if (teleport > 0) {
      for (let u = 0; u < size; u++) {
        next[u] = (next[u] as number) + teleport * (restartDist[u] as number);
      }
    }
    const swap = current;
    current = next;
    next = swap;
  }

  let max = 0;
  for (let u = 0; u < size; u++) {
    const value = current[u] as number;
    if (value > max) max = value;
  }
  if (max > 0) {
    for (let u = 0; u < size; u++) scores[u] = (current[u] as number) / max;
  }
  return scores;
}

/** One persisted `symbol_rank` row. */
export interface SymbolRankRow {
  symbolId: number;
  rank: number;
  inDeg: number;
  outDeg: number;
}

/** One persisted `file_rank` row. */
export interface FileRankRow {
  file: string;
  rank: number;
  inDeg: number;
  outDeg: number;
}

/** Materialise the score vector as persistable symbol rows. */
export function toSymbolRankRows(graph: WiringGraph, scores: Float64Array): SymbolRankRow[] {
  const rows: SymbolRankRow[] = new Array(graph.size);
  for (let u = 0; u < graph.size; u++) {
    rows[u] = {
      symbolId: graph.ids[u] as number,
      rank: scores[u] as number,
      inDeg: graph.inDegree[u] as number,
      outDeg: graph.outDegree[u] as number,
    };
  }
  return rows;
}

/**
 * Roll symbol scores up to files.
 *
 * A file's rank is the **sum** of its symbols' ranks, not the mean: a module
 * that exports twenty things everyone uses is more central than one that
 * exports a single equally-used thing, and averaging erases exactly that.
 * Degrees roll up the same way. The result is re-normalised to max 1.0 so
 * file and symbol ranks share a scale.
 */
export function aggregateFileRank(
  rows: readonly SymbolRankRow[],
  fileOf: ReadonlyMap<number, string>,
): FileRankRow[] {
  const byFile = new Map<string, FileRankRow>();
  for (const row of rows) {
    const file = fileOf.get(row.symbolId);
    if (file === undefined) continue;
    const existing = byFile.get(file);
    if (existing === undefined) {
      byFile.set(file, {
        file,
        rank: row.rank,
        inDeg: row.inDeg,
        outDeg: row.outDeg,
      });
      continue;
    }
    existing.rank += row.rank;
    existing.inDeg += row.inDeg;
    existing.outDeg += row.outDeg;
  }

  let max = 0;
  for (const row of byFile.values()) {
    if (row.rank > max) max = row.rank;
  }
  const out = [...byFile.values()];
  if (max > 0) {
    for (const row of out) row.rank /= max;
  }
  return out;
}

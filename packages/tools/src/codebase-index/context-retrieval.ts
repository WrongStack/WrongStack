/**
 * Personalised retrieval — "which files does this task touch?"
 *
 * Lexical search proposes, the graph disposes. A BM25/FTS query produces a set
 * of seed symbols with scores; those scores become the restart distribution of
 * a personalised PageRank walk over the wiring graph. The walk then surfaces
 * what the seeds are structurally attached to: the interface a matched
 * function implements, the module every matched call site imports, the store
 * behind the handler that matched by name.
 *
 * This is the piece that turns the index from a set of primitives an agent has
 * to compose by hand — search, then skeleton, then incoming-calls, then read —
 * into one answer. The composition was previously re-derived by the model on
 * every task, at the cost of several round trips and a great deal of judgement
 * spent on plumbing rather than on the problem.
 *
 * What comes back is declarations, not source: file, relevance, and the
 * matching symbols with their signatures and line numbers. Reading the actual
 * code stays a deliberate `read` — the point is to make that read land in the
 * right place the first time.
 */

import { getWiringSnapshot } from './graph-adjacency-cache.js';
import { pageRank } from './graph-rank.js';
import type { SearchResult, SymbolKind, SymbolLang } from './schema.js';
import type { IndexStore } from './writer.js';
import { posixIndexPath } from './writer-helpers.js';

/** One symbol worth showing inside a returned file. */
export interface ContextSymbol {
  name: string;
  kind: string;
  line: number;
  signature: string;
  /** True when lexical search matched this symbol directly. */
  seed: boolean;
}

/** One file in the answer, most relevant first. */
export interface ContextEntry {
  /** Project-relative POSIX path. */
  file: string;
  /** Relevance to this query, normalised so the top entry is 1.0. */
  relevance: number;
  /** Whether any symbol here matched the query lexically. */
  matched: boolean;
  symbols: ContextSymbol[];
}

export interface ContextResult {
  query: string;
  entries: ContextEntry[];
  /** Lexical hits that seeded the walk. Zero means nothing matched. */
  seedCount: number;
  /** Semantic hits that also seeded it. */
  semanticSeedCount: number;
  /** Files the walk reached before truncation to `limit`. */
  totalCandidates: number;
  indexStatus: 'ok' | 'no-index' | 'no-matches' | 'unranked';
}

export interface ContextOptions {
  query: string;
  /**
   * Files a semantic search already matched, with their cosine scores.
   *
   * Supplied by the caller rather than computed here because the embedding
   * model lives host-side — functions cannot cross the daemon's IPC boundary,
   * so only the resulting file scores travel. These become additional restart
   * mass, letting a query phrased in the problem's vocabulary reach code whose
   * identifiers never use those words.
   */
  vectorFiles?: ReadonlyArray<{ file: string; score: number }> | undefined;
  /** Files to return. */
  limit?: number | undefined;
  /** Symbols to show per file. */
  symbolsPerFile?: number | undefined;
  /** Restrict results to files under this project-relative prefix. */
  pathPrefix?: string | undefined;
}

/**
 * Lexical hits used as restart mass. More seeds make the walk broader and
 * blunter; this is enough to cover a multi-word query's separate senses
 * without letting a common token dominate.
 */
export const SEED_LIMIT = 40;

export const DEFAULT_LIMIT = 12;
export const DEFAULT_SYMBOLS_PER_FILE = 4;

/**
 * Nodes to pull off the walk before grouping into files. Generous relative to
 * `limit` because many top nodes share a file, and because the path filter is
 * applied after the walk.
 */
const NODE_HYDRATION_LIMIT = 400;

/** Declarations per semantically matched file that become restart mass. */
const SEMANTIC_SYMBOLS_PER_FILE = 3;

/**
 * How much restart mass the semantic side carries relative to the lexical
 * side.
 *
 * Well under half because an exact name match is much stronger evidence than
 * a paraphrase, and because the semantic mass lands concentrated on a handful
 * of files while the lexical mass is spread over up to forty hits. Well above
 * zero because the paraphrase is the only thing that reaches code the query
 * never names.
 */
const SEMANTIC_SEED_SHARE = 0.35;

function normalisePrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined) return undefined;
  const trimmed = posixIndexPath(prefix.trim()).replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Run the personalised walk and group the winners into files.
 *
 * Returns an empty result rather than throwing whenever the index cannot
 * answer — an unbuilt index and a query nobody matches are ordinary states,
 * and `indexStatus` says which one happened.
 */
export function retrieveContext(
  store: IndexStore,
  projectRoot: string,
  indexDir: string | undefined,
  options: ContextOptions,
  relativeOf: (file: string) => string,
): ContextResult {
  const query = options.query.trim();
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 50));
  const symbolsPerFile = Math.max(
    1,
    Math.min(options.symbolsPerFile ?? DEFAULT_SYMBOLS_PER_FILE, 20),
  );
  const prefix = normalisePrefix(options.pathPrefix);
  const vectorFiles = options.vectorFiles ?? [];
  const empty = (indexStatus: ContextResult['indexStatus']): ContextResult => ({
    query,
    entries: [],
    seedCount: 0,
    semanticSeedCount: 0,
    totalCandidates: 0,
    indexStatus,
  });

  if (query.length === 0) return empty('no-matches');

  const search = store.searchRanked(query, undefined, SEED_LIMIT);
  // A semantic hit alone is enough to answer: the whole point of embeddings is
  // reaching code whose identifiers never use the query's words.
  if (search.results.length === 0 && vectorFiles.length === 0) {
    return empty(store.getIndexSummary().totalFiles === 0 ? 'no-index' : 'no-matches');
  }

  const { graph, fileOf } = getWiringSnapshot(store, projectRoot, indexDir);
  if (graph.size === 0) {
    // Symbols exist but nothing resolved into edges — a first run still
    // resolving refs, or a language the resolver cannot wire. Fall back to the
    // lexical hits alone rather than returning nothing.
    return {
      ...groupIntoEntries(
        search.results,
        new Map(),
        fileOf,
        limit,
        symbolsPerFile,
        prefix,
        relativeOf,
      ),
      query,
      seedCount: search.results.length,
      semanticSeedCount: vectorFiles.length,
      indexStatus: 'unranked',
    };
  }

  // Seed the restart distribution with the lexical scores. Symbols the graph
  // never wired (no resolved ref touches them) simply do not appear as nodes;
  // they still reach the answer through `search.results` below.
  const seeds = new Map<number, number>();
  let lexicalMass = 0;
  for (const hit of search.results) {
    const dense = graph.index.get(hit.id);
    if (dense === undefined) continue;
    const weight = hit.score > 0 ? hit.score : 1;
    lexicalMass += weight;
    seeds.set(dense, (seeds.get(dense) ?? 0) + weight);
  }

  // Semantic seeds enter through each matched file's most central declarations.
  // Their mass is scaled to the lexical mass rather than used raw: cosine
  // similarity and BM25 are different scales, and letting one dominate the
  // other by accident of units would make the blend arbitrary.
  const semanticSeeds = new Map<number, number>();
  for (const hit of vectorFiles) {
    if (!(hit.score > 0)) continue;
    for (const symbol of store.getFileSymbols(hit.file, SEMANTIC_SYMBOLS_PER_FILE)) {
      const dense = graph.index.get(symbol.id);
      if (dense === undefined) continue;
      semanticSeeds.set(dense, (semanticSeeds.get(dense) ?? 0) + hit.score);
    }
  }
  if (semanticSeeds.size > 0) {
    let semanticMass = 0;
    for (const weight of semanticSeeds.values()) semanticMass += weight;
    // With no lexical hits at all the semantic side simply owns the walk.
    const scale =
      semanticMass > 0 && lexicalMass > 0 ? (lexicalMass * SEMANTIC_SEED_SHARE) / semanticMass : 1;
    for (const [dense, weight] of semanticSeeds) {
      seeds.set(dense, (seeds.get(dense) ?? 0) + weight * scale);
    }
  }
  if (seeds.size === 0) {
    return {
      ...groupIntoEntries(
        search.results,
        new Map(),
        fileOf,
        limit,
        symbolsPerFile,
        prefix,
        relativeOf,
      ),
      query,
      seedCount: search.results.length,
      semanticSeedCount: vectorFiles.length,
      indexStatus: 'unranked',
    };
  }

  const scores = pageRank(graph, { seeds });

  // Take the highest-scoring nodes. A full sort of 66k entries per query is
  // wasteful when only a few hundred are wanted, but it is also ~5 ms and the
  // walk itself dominates, so clarity wins over a partial-selection algorithm.
  const ordered: Array<{ dense: number; score: number }> = [];
  for (let u = 0; u < graph.size; u++) {
    const score = scores[u] as number;
    if (score > 0) ordered.push({ dense: u, score });
  }
  ordered.sort((a, b) => b.score - a.score);
  const top = ordered.slice(0, NODE_HYDRATION_LIMIT);

  const scoreBySymbolId = new Map<number, number>();
  for (const node of top) scoreBySymbolId.set(graph.ids[node.dense] as number, node.score);

  const hydrated = store.getSymbolsByIds([...scoreBySymbolId.keys()]);
  const seedIds = new Set(search.results.map((hit) => hit.id));
  const walked: SearchResult[] = hydrated.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind as SymbolKind,
    lang: row.lang as SymbolLang,
    file: row.file,
    line: row.line,
    col: 0,
    signature: row.signature,
    docComment: '',
    score: scoreBySymbolId.get(row.id) ?? 0,
    snippet: '',
  }));

  const grouped = groupIntoEntries(
    walked,
    scoreBySymbolId,
    fileOf,
    limit,
    symbolsPerFile,
    prefix,
    relativeOf,
    seedIds,
  );
  return {
    ...grouped,
    query,
    seedCount: search.results.length,
    semanticSeedCount: vectorFiles.length,
    indexStatus: 'ok',
  };
}

/**
 * Collapse scored symbols into per-file entries.
 *
 * A file's relevance is the score of its best symbol, not the sum: a module
 * that happens to declare fifty things should not outrank the one module that
 * declares the thing the query is actually about. (File *centrality* sums, in
 * `aggregateFileRank`, because that question is about weight in the graph;
 * this question is about proximity to the query.)
 */
function groupIntoEntries(
  symbols: readonly SearchResult[],
  scoreBySymbolId: ReadonlyMap<number, number>,
  fileOf: ReadonlyMap<number, string>,
  limit: number,
  symbolsPerFile: number,
  prefix: string | undefined,
  relativeOf: (file: string) => string,
  seedIds: ReadonlySet<number> = new Set(),
): Pick<ContextResult, 'entries' | 'totalCandidates'> {
  interface Bucket {
    file: string;
    best: number;
    matched: boolean;
    symbols: Array<ContextSymbol & { score: number }>;
  }
  const byFile = new Map<string, Bucket>();

  for (const symbol of symbols) {
    const storedFile = symbol.file || fileOf.get(symbol.id) || '';
    if (!storedFile) continue;
    const relative = relativeOf(storedFile);
    if (prefix !== undefined && relative !== prefix && !relative.startsWith(`${prefix}/`)) continue;

    const score = scoreBySymbolId.get(symbol.id) ?? symbol.score;
    const seed = seedIds.has(symbol.id);
    const entry: ContextSymbol & { score: number } = {
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      signature: symbol.signature,
      seed,
      score,
    };

    const bucket = byFile.get(relative);
    if (bucket === undefined) {
      byFile.set(relative, { file: relative, best: score, matched: seed, symbols: [entry] });
      continue;
    }
    bucket.symbols.push(entry);
    if (score > bucket.best) bucket.best = score;
    if (seed) bucket.matched = true;
  }

  const buckets = [...byFile.values()].sort(
    (a, b) => b.best - a.best || a.file.localeCompare(b.file),
  );
  const totalCandidates = buckets.length;
  const top = buckets.slice(0, limit);

  // Normalise after truncation so the caller always sees a 1.0 at the head.
  const max = top[0]?.best ?? 0;
  const entries: ContextEntry[] = top.map((bucket) => ({
    file: bucket.file,
    relevance: max > 0 ? bucket.best / max : 0,
    matched: bucket.matched,
    symbols: bucket.symbols
      // Directly matched symbols lead: they are what the user asked about.
      .sort((a, b) => Number(b.seed) - Number(a.seed) || b.score - a.score || a.line - b.line)
      .slice(0, symbolsPerFile)
      .map(({ score: _score, ...rest }) => rest),
  }));

  return { entries, totalCandidates };
}

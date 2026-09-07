/**
 * Process-local cache of the wiring graph.
 *
 * Building the graph means pulling ~180k resolved refs, ~66k symbol→file
 * pairs, the homonym counts and the import-visibility map, then laying the
 * whole thing out as CSR — around half a second on this repo. That is fine
 * once per index generation and unacceptable once per query, and the
 * personalised retrieval walk is a per-query operation.
 *
 * The cache holds one graph. In the detached project server that is exactly
 * right: one daemon serves one project. A caller for a different project (or
 * a different index directory) simply replaces the entry rather than growing
 * a map that would keep tens of megabytes alive for a project nobody is
 * querying any more.
 *
 * Freshness is decided by the index's own `last_indexed` stamp plus the row
 * counts, read fresh on every request. That costs three trivial queries and
 * makes the cache self-invalidating from any path — daemon, worker, or
 * inline — without having to be wired into the server's generation plumbing.
 */

import { buildWiringGraph, type WiringGraph } from './graph-rank.js';
import type { IndexStore } from './writer.js';

/** Everything the walk needs, built together and invalidated together. */
export interface WiringSnapshot {
  graph: WiringGraph;
  /** Declaring file per symbol id — the walk reports files, not just nodes. */
  fileOf: ReadonlyMap<number, string>;
}

interface CacheEntry extends WiringSnapshot {
  key: string;
  stamp: string;
}

let cached: CacheEntry | null = null;

function cacheKey(projectRoot: string, indexDir: string | undefined): string {
  return `${projectRoot}\u0000${indexDir ?? ''}`;
}

/**
 * A cheap fingerprint of the index's current content. `last_indexed` alone
 * would miss a run that changed nothing's timestamp, and the counts alone
 * would miss an edit that replaced one symbol with another.
 */
function contentStamp(store: IndexStore): string {
  const counts = store.getRankCounts();
  return [
    store.getMetadata('last_indexed') ?? '',
    store.getMetadata('relation_graph_version') ?? '',
    counts.symbols,
    counts.files,
  ].join('|');
}

/**
 * Return the wiring graph for this store, building it only when the index has
 * changed since the last call.
 */
export function getWiringSnapshot(
  store: IndexStore,
  projectRoot: string,
  indexDir: string | undefined,
): WiringSnapshot {
  const key = cacheKey(projectRoot, indexDir);
  const stamp = contentStamp(store);
  if (cached !== null && cached.key === key && cached.stamp === stamp) {
    return { graph: cached.graph, fileOf: cached.fileOf };
  }

  const fileOf = new Map<number, string>();
  for (const symbol of store.getAllSymbols()) fileOf.set(symbol.id, symbol.file);
  const graph = buildWiringGraph(store.getAllResolvedRefs(), {
    candidates: store.getSymbolNameCandidates(),
    fileOf,
    importsOf: store.getImportVisibility(),
  });

  cached = { key, stamp, graph, fileOf };
  return { graph, fileOf };
}

/** Drop the cached graph. Tests and shutdown paths only. */
export function clearWiringSnapshot(): void {
  cached = null;
}

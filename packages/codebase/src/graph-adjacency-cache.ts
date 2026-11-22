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
 * Freshness is decided by the index's own `graph_stamp` plus the row
 * counts, read fresh on every request. That costs three trivial queries and
 * makes the cache self-invalidating from any path — daemon, worker, or
 * inline — without having to be wired into the server's generation plumbing.
 */

import type { WiringGraph } from './graph-rank.js';
import { loadWiringGraph } from './graph-rank-pass.js';
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
/** When a caller last asked for the graph; 0 = never in this process. */
let lastUsedAt = 0;

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
    // `graph_stamp` moves only when a run changed rows or edges; a full scan
    // over an unchanged checkout still bumps `last_indexed`, and rebuilding
    // the graph for it cost the next query ~0.5 s. Older databases have no
    // graph stamp yet and fall back to `last_indexed`.
    store.getMetadata('graph_stamp') ?? store.getMetadata('last_indexed') ?? '',
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
  lastUsedAt = Date.now();
  return ensureSnapshot(store, projectRoot, indexDir);
}

/** When `getWiringSnapshot` was last called; 0 when never. */
export function wiringSnapshotLastUsedAt(): number {
  return lastUsedAt;
}

/**
 * Build the graph ahead of the next query, without counting as a use.
 *
 * Every content change moves the stamp, so the first `codebase-context`
 * after an edit paid the whole build (~0.5 s here). The project server calls
 * this once the write stream goes quiet — and only while retrieval is in
 * recent use — so that query finds the graph ready. Returns whether a build
 * was needed.
 */
export function prewarmWiringSnapshot(
  store: IndexStore,
  projectRoot: string,
  indexDir: string | undefined,
): boolean {
  const stale = !isCurrent(store, projectRoot, indexDir);
  if (stale) ensureSnapshot(store, projectRoot, indexDir);
  return stale;
}

function isCurrent(store: IndexStore, projectRoot: string, indexDir: string | undefined): boolean {
  return (
    cached !== null &&
    cached.key === cacheKey(projectRoot, indexDir) &&
    cached.stamp === contentStamp(store)
  );
}

function ensureSnapshot(
  store: IndexStore,
  projectRoot: string,
  indexDir: string | undefined,
): WiringSnapshot {
  const key = cacheKey(projectRoot, indexDir);
  const stamp = contentStamp(store);
  if (cached !== null && cached.key === key && cached.stamp === stamp) {
    return { graph: cached.graph, fileOf: cached.fileOf };
  }

  // Same loader as the index-time rank pass: the personalised walk must weigh
  // every edge exactly as the global rank does.
  const { graph, fileOf } = loadWiringGraph(store);

  cached = { key, stamp, graph, fileOf };
  return { graph, fileOf };
}

/** Drop the cached graph. Tests and shutdown paths only. */
export function clearWiringSnapshot(): void {
  cached = null;
  lastUsedAt = 0;
}

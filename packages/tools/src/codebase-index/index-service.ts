/**
 * Execution-location-agnostic index operations.
 *
 * One implementation, two callers: the index worker thread (production —
 * synchronous SQLite and the TypeScript parser can never block the main
 * thread / terminal UI there) and the inline fallback inside the host (tests,
 * `WRONGSTACK_INDEX_INLINE=1`, or runtimes where the worker file is missing).
 *
 * Operations share one warm IndexStore per resolved project/index directory.
 * The detached server owns write serialization, while worker/inline fallbacks
 * run on one event loop, so a pooled connection is both safe and substantially
 * cheaper than re-running schema/FTS drift checks for every edited file.
 */

import { runIndexerWithStore } from './indexer.js';
import type {
  CodeMapGraph,
  IndexResult,
  IndexStats,
  SymbolKind,
  SymbolLang,
} from './schema.js';
import type {
  CallRefsOpArgs,
  IndexOpArgs,
  SearchOpArgs,
  SearchOpResult,
  StatsOpArgs,
} from './worker-protocol.js';
import { indexStorePool } from './writer.js';

export interface ServiceHooks {
  signal?: AbortSignal | undefined;
  onProgress?: ((current: number, total: number) => void) | undefined;
}

/** Full or per-file index run. */
export async function indexService(
  args: IndexOpArgs,
  hooks: ServiceHooks = {},
): Promise<IndexResult> {
  const store = indexStorePool.acquire(args.projectRoot, { indexDir: args.indexDir });
  try {
    return await runIndexerWithStore(store, {
      projectRoot: args.projectRoot,
      indexDir: args.indexDir,
      files: args.files,
      force: args.force,
      langs: args.langs,
      ignore: args.ignore,
      signal: hooks.signal,
      onProgress: hooks.onProgress,
    });
  } finally {
    indexStorePool.release(store);
  }
}

/** Ranked symbol search (FTS5 inside SQLite; BM25 fallback without FTS5). */
export function searchService(args: SearchOpArgs): SearchOpResult {
  const store = indexStorePool.acquire(args.projectRoot, { indexDir: args.indexDir });
  try {
    const result = store.searchRanked(
      args.query,
      {
        kind: args.kind as SymbolKind | undefined,
        lang: args.lang as SymbolLang | undefined,
        file: args.file,
        lspKind: args.lspKind,
      },
      args.limit,
    );
    // P2.5: piggyback the minimal index summary on zero-hit responses so the
    // search tool can answer "is there a persisted index?" without a second
    // stats IPC round trip. Hit responses omit it — they already prove the
    // index exists and the extra payload would ride every search.
    if (result.total === 0) {
      return { ...result, indexSummary: store.getIndexSummary() };
    }
    return result;
  } finally {
    indexStorePool.release(store);
  }
}

/** Index health and statistics. */
export function statsService(args: StatsOpArgs): IndexStats {
  const store = indexStorePool.acquire(args.projectRoot, { indexDir: args.indexDir });
  try {
    return store.getStats();
  } finally {
    indexStorePool.release(store);
  }
}

// ─── CodeMap graph services ──────────────────────────────────────────────────

/** Package-level dependency graph. */
export function packageGraphService(args: StatsOpArgs): CodeMapGraph {
  const store = indexStorePool.acquire(args.projectRoot, { indexDir: args.indexDir });
  try {
    return store.getPackageGraph();
  } finally {
    indexStorePool.release(store);
  }
}

/** File-level dependency graph for a single package. */
export function fileGraphService(args: StatsOpArgs & { packageFilter: string }): CodeMapGraph {
  const store = indexStorePool.acquire(args.projectRoot, { indexDir: args.indexDir });
  try {
    return store.getFileGraph(args.packageFilter);
  } finally {
    indexStorePool.release(store);
  }
}

/** Symbol-level dependency graph for a single file. */
export function symbolGraphService(args: StatsOpArgs & { fileFilter: string }): CodeMapGraph {
  const store = indexStorePool.acquire(args.projectRoot, { indexDir: args.indexDir });
  try {
    return store.getSymbolGraph(args.fileFilter);
  } finally {
    indexStorePool.release(store);
  }
}

import type { IncomingCallsResult, OutgoingCallsResult } from './worker-protocol/contracts.js';
export type { IncomingCallsResult, OutgoingCallsResult };

/** Incoming call sites for a named symbol (who calls/uses this symbol?). */
export function incomingCallsService(args: CallRefsOpArgs): IncomingCallsResult {
  const store = indexStorePool.acquire(args.projectRoot, { indexDir: args.indexDir });
  try {
    if (args.transitive) {
      return store.findTransitiveIncomingCallsByName(args.symbol, args.file, args.limit ?? 100);
    }
    return store.findIncomingCallsByName(args.symbol, args.file, args.limit ?? 100);
  } finally {
    indexStorePool.release(store);
  }
}

/** Outgoing call sites for a named symbol (what does this symbol call/use?). */
export function outgoingCallsService(args: CallRefsOpArgs): OutgoingCallsResult {
  const store = indexStorePool.acquire(args.projectRoot, { indexDir: args.indexDir });
  try {
    if (args.transitive) {
      return store.findTransitiveOutgoingCallsByName(args.symbol, args.file, args.limit ?? 100);
    }
    return store.findOutgoingCallsByName(args.symbol, args.file, args.limit ?? 100);
  } finally {
    indexStorePool.release(store);
  }
}

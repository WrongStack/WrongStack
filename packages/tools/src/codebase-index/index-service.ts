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
import type { CallSite, CodeMapGraph, IndexResult, IndexStats, SymbolKind, SymbolLang } from './schema.js';
import type { CallRefsOpArgs, IndexOpArgs, SearchOpArgs, SearchOpResult, StatsOpArgs } from './worker-protocol.js';
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
    return store.searchRanked(
      args.query,
      {
        kind: args.kind as SymbolKind | undefined,
        lang: args.lang as SymbolLang | undefined,
        file: args.file,
        lspKind: args.lspKind,
      },
      args.limit,
    );
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

/** Result of an incoming calls query. */
export interface IncomingCallsResult {
  calls: CallSite[];
  symbolFound: boolean;
  /** True when `file` was scoped but the name is ambiguous (other files define it too). */
  ambiguous: boolean;
}

/** Result of an outgoing calls query. */
export interface OutgoingCallsResult {
  calls: CallSite[];
  symbolFound: boolean;
  /** Number of refs whose target could not be resolved (to_id IS NULL). */
  unresolvedCount: number;
}

/** Incoming call sites for a named symbol (who calls/uses this symbol?). */
export function incomingCallsService(args: CallRefsOpArgs): IncomingCallsResult {
  const store = indexStorePool.acquire(args.projectRoot, { indexDir: args.indexDir });
  try {
    return store.findIncomingCallsByName(args.symbol, args.file, args.limit ?? 100);
  } finally {
    indexStorePool.release(store);
  }
}

/** Outgoing call sites for a named symbol (what does this symbol call/use?). */
export function outgoingCallsService(args: CallRefsOpArgs): OutgoingCallsResult {
  const store = indexStorePool.acquire(args.projectRoot, { indexDir: args.indexDir });
  try {
    return store.findOutgoingCallsByName(args.symbol, args.file, args.limit ?? 100);
  } finally {
    indexStorePool.release(store);
  }
}

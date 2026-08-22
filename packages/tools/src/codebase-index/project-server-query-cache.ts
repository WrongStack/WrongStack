/**
 * Read/completion policy for the detached project server's query caches.
 *
 * The server used to refuse every read for the duration of an index refresh
 * and wipe all query caches on every completion (including single-file
 * incremental runs). Together that made search/graph/stats unavailable both
 * during a refresh and on the first reads after each incremental edit.
 *
 * The policy here instead:
 *
 * - **During a refresh** a cache HIT from any generation is served with a
 *   `stale: true` marker. A miss still refuses: read ops share the server's
 *   single pooled SQLite connection with the in-flight write transaction, so
 *   loading fresh mid-run would be a dirty read of uncommitted rows, not a
 *   merely-outdated read.
 * - **On completion of an incremental run** the caches are kept. Entries are
 *   re-tagged with the new generation as they are recomputed; surviving
 *   previous-generation entries are what the next refresh's stale-serve
 *   window hits. `stats` still refuses during a refresh — it is the progress
 *   poll, and a cached pre-run answer would read as "finished with old
 *   numbers".
 * - **On completion of a full/forced run** (or a failed run whose
 *   transaction may have rolled back the visible generation) all caches are
 *   cleared.
 */

import type { IncomingCallsResult, OutgoingCallsResult } from './index-service.js';
import { GenerationLruCache } from './project-server-cache.js';
import type { CodeMapGraph, IndexStats, SearchResult } from './schema.js';

/** A cached answer with the stale marker the server may attach. */
export type WithStale<T> = T & { stale?: boolean | undefined };

/** The error the server answers a read it cannot serve with. */
export function indexRefreshInProgressError(currentFile: number, totalFiles: number): Error {
  const error = new Error(
    `Codebase index refresh in progress (${currentFile}/${totalFiles} files); ` +
      'retry after the completed generation is published.',
  );
  error.name = 'IndexRefreshInProgressError';
  return error;
}

/**
 * The slice of index activity a read decision needs. Structurally compatible
 * with the server's `ProjectIndexServerActivity`, so the live activity object
 * can be passed directly.
 */
export interface RefreshState {
  generation: number;
  indexing: boolean;
  currentFile: number;
  totalFiles: number;
}

/**
 * How many completed generations a preserved cache entry may lag the
 * publishing one and still be served stale during a refresh.
 *
 * Targeted runs preserve caches across completions, and generation only
 * grows — an entry that survives many runs without being recomputed gets
 * progressively older (a search answer from before several edits). Beyond
 * this bound the entry is treated as too old to be useful and the read
 * falls back to the refresh refusal, exactly like a cache miss.
 */
export const MAX_STALE_GENERATION_LAG = 2;

/**
 * One read against a generation cache under the stale-serve policy.
 *
 * - Refreshing + hit within {@link MAX_STALE_GENERATION_LAG} generations →
 *   `{ value, stale: true }` from `peekEntry`.
 * - Refreshing + miss (or entry older than the bound) → throws
 *   `IndexRefreshInProgressError` (a fresh load would read uncommitted rows
 *   through the shared pooled connection).
 * - Idle + hit → `{ value, stale: false }`; idle + miss → `load()` and cache.
 */
export function staleAwareRead<T>(
  cache: GenerationLruCache<T>,
  key: string,
  refresh: RefreshState,
  load: () => T,
): { value: T; stale: boolean } {
  if (refresh.indexing) {
    const entry = cache.peekEntry(key);
    if (entry !== undefined && refresh.generation - entry.generation <= MAX_STALE_GENERATION_LAG) {
      return { value: entry.value, stale: true };
    }
    throw indexRefreshInProgressError(refresh.currentFile, refresh.totalFiles);
  }
  const cached = cache.get(key, refresh.generation);
  if (cached !== undefined) return { value: cached, stale: false };
  const value = load();
  cache.set(key, refresh.generation, value);
  return { value, stale: false };
}

/** The project server's generation-scoped read caches, as a unit. */
export class ServerQueryCaches {
  /**
   * Search answer (rows + total) keyed by the serialized query args. Rows and
   * count are cached as ONE value: separate caches would let one half hit and
   * the other miss, and a mid-refresh miss load would be a dirty read.
   */
  readonly searchCache = new GenerationLruCache<{ results: SearchResult[]; total: number }>(128);
  readonly statsCache = new GenerationLruCache<IndexStats>(1);
  readonly packageGraphCache = new GenerationLruCache<CodeMapGraph>(1);
  readonly fileGraphCache = new GenerationLruCache<CodeMapGraph>(32);
  readonly symbolGraphCache = new GenerationLruCache<CodeMapGraph>(64);
  readonly incomingCallsCache = new GenerationLruCache<IncomingCallsResult>(128);
  readonly outgoingCallsCache = new GenerationLruCache<OutgoingCallsResult>(128);

  clear(): void {
    this.searchCache.clear();
    this.statsCache.clear();
    this.packageGraphCache.clear();
    this.fileGraphCache.clear();
    this.symbolGraphCache.clear();
    this.incomingCallsCache.clear();
    this.outgoingCallsCache.clear();
  }

  /** Cache sizes for the health snapshot. */
  sizes(): Record<string, number> {
    return {
      searchCache: this.searchCache.size,
      statsCache: this.statsCache.size,
      packageGraphCache: this.packageGraphCache.size,
      fileGraphCache: this.fileGraphCache.size,
      symbolGraphCache: this.symbolGraphCache.size,
      incomingCallsCache: this.incomingCallsCache.size,
      outgoingCallsCache: this.outgoingCallsCache.size,
    };
  }
}

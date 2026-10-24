import type { SessionSummary } from '@wrongstack/contracts/types/session';
import type { SessionCatalogProjectClient } from '../session-catalog/client.js';
import { withFileLock } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/index.js';
import type { EventBus } from './event-bus-port.js';
import { emitSessionStoreWrite } from './session-store/events.js';
import { executeRebuildIndex } from './session-store/rebuild-index.js';
import {
  appendToIndexStrict,
  COMPACT_EVERY,
  compactIndexInner,
  readIndexFile,
  writeTombstone,
} from './session-store/session-store-index.js';
import { locateTranscript } from './session-store/transcript-location.js';
import type { IndexCacheEntry } from './session-store/types.js';
export interface SessionStoreIndexHost {
  dir: string;
  indexFile: string;
  invalidateShardManifestBySessionId(id: string): Promise<void>;
  _indexCache: IndexCacheEntry | null;
  indexAppendCount: number;
  compactIndexInner(): Promise<void>;
  catalogClient: SessionCatalogProjectClient | undefined;
  appendToIndex(summary: SessionSummary): Promise<void>;
  _manualTombstones: Set<string>;
  _indexDeletedIds: Set<string>;
  compactIndex(): Promise<void>;
  events: EventBus | undefined;
  readIndex(): Promise<readonly SessionSummary[]>;
  _indexFileDeletedIds: ReadonlySet<string>;
  collectSessionIds(dir: string, prefix?: string, depth?: number): Promise<string[]>;
  summaryFor(id: string): Promise<SessionSummary>;
}

export async function appendToIndexStrictFromState(
  host: SessionStoreIndexHost,
  summary: SessionSummary,
): Promise<void> {
  await appendToIndexStrict(
    host.dir,
    host.indexFile,
    summary,
    (id) => host.invalidateShardManifestBySessionId(id),
    () => {
      host._indexCache = null;
      host.indexAppendCount++;
      const shouldCompact = host.indexAppendCount >= COMPACT_EVERY;
      if (shouldCompact) host.indexAppendCount = 0;
      return { shouldCompact };
    },
    () => host.compactIndexInner(),
  );
}

export async function persistCatalogSummary(
  host: SessionStoreIndexHost,
  summary: SessionSummary,
): Promise<void> {
  if (!host.catalogClient) {
    await host.appendToIndex(summary);
    return;
  }
  const located = await locateTranscript(host.dir, summary.id);
  await host.catalogClient.call('upsert_summary', {
    summary,
    transcriptRelativePath: located?.relativePath ?? `${summary.id}.jsonl`,
    summaryRelativePath: `${summary.id}.summary.json`,
    ...(located?.state === 'cold'
      ? {
          storageState: 'cold' as const,
          codec: 'gzip' as const,
          compressedSize: located.size,
        }
      : located
        ? { storageState: 'hot' as const, uncompressedSize: located.size }
        : {}),
  });
}

export async function writeTombstoneFromState(
  host: SessionStoreIndexHost,
  id: string,
): Promise<void> {
  let shouldCompact = false;
  await writeTombstone(
    host.dir,
    host.indexFile,
    id,
    (sid) => host.invalidateShardManifestBySessionId(sid),
    () => {
      // Immediate in-memory adds: belt-and-braces so a concurrent
      // incremental cache rebuild cannot resurrect the deleted id even if
      // it rebuilds from a base snapshot that predates this tombstone.
      // _manualTombstones survives readIndex() snapshot merges until the
      // parsed file itself carries the row.
      host._manualTombstones.add(id);
      host._indexDeletedIds.add(id);
      host._indexCache = null;
      host.indexAppendCount++;
      // Deletes share the append counter. Compaction runs after this
      // callback returns: writeTombstone still holds the index lock, and
      // that lock is not reentrant.
      if (host.indexAppendCount >= COMPACT_EVERY) {
        host.indexAppendCount = 0;
        shouldCompact = true;
      }
    },
  );
  if (shouldCompact) await host.compactIndex();
}

export async function compactIndex(host: SessionStoreIndexHost): Promise<void> {
  const t0 = Date.now();
  let outcome: 'success' | 'failure' = 'success';
  let errorMsg: string | undefined;
  try {
    await withFileLock(host.indexFile, () => host.compactIndexInner());
  } catch (err) {
    outcome = 'failure';
    errorMsg = toErrorMessage(err);
  } finally {
    emitSessionStoreWrite(
      host.events,
      '~compact~',
      host.indexFile,
      'compact',
      outcome,
      Date.now() - t0,
      undefined,
      errorMsg,
    );
  }
}

export async function compactIndexInnerFromState(host: SessionStoreIndexHost): Promise<void> {
  const entries = await host.readIndex();
  // Persist the FILE-TRUTH tombstone snapshot (not the post-merge view):
  // tombstones that landed after our last parse belong to writeTombstone's
  // own durable path and must not be written prematurely by compaction.
  await compactIndexInner(host.indexFile, entries, host._indexFileDeletedIds);
  host._indexCache = null;
}

export async function readIndex(host: SessionStoreIndexHost): Promise<readonly SessionSummary[]> {
  const { summaries, deletedIds, cache } = await readIndexFile(host.indexFile, host._indexCache);
  host._indexCache = cache;
  // Merge manual tombstones so a read whose snapshot predates a concurrent
  // writeTombstone cannot erase the in-flight deletion; prune entries the
  // parsed file already carries (prune-source = file snapshot, never the
  // set being mutated).
  const merged = new Set(deletedIds);
  for (const manual of host._manualTombstones) {
    merged.add(manual);
    if (deletedIds.has(manual)) host._manualTombstones.delete(manual);
  }
  host._indexFileDeletedIds = deletedIds;
  host._indexDeletedIds = merged;
  return summaries;
}

export async function rebuildIndex(host: SessionStoreIndexHost): Promise<number> {
  return executeRebuildIndex({
    catalogClient: host.catalogClient,
    indexFile: host.indexFile,
    dir: host.dir,
    readIndex: () => host.readIndex(),
    collectSessionIds: (dir) => host.collectSessionIds(dir),
    summaryFor: (id) => host.summaryFor(id),
    getIndexDeletedIds: () => host._indexDeletedIds,
    clearIndexCache: () => {
      host._indexCache = null;
    },
  });
}

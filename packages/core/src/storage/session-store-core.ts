/**
 * State, path helpers, the session index and summary lookups of the
 * {@link DefaultSessionStore} (session-store.ts). The public store API —
 * create / resume / load / search / list / delete / move / archive — lives in
 * DefaultSessionStore.
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
import type {
  SessionArchiveIdleResult,
  SessionEvent,
  SessionStoragePolicy,
  SessionSummary,
} from '@wrongstack/contracts/types/session';
import { isStandaloneBinary } from '@wrongstack/persistence';
import { DefaultSecretScrubber } from '../security/secret-scrubber.js';
import {
  resolveSessionCatalogProjectServerUrl,
  SessionCatalogProjectClient,
} from '../session-catalog/client.js';
import { withFileLock } from '../utils/atomic-write.js';
import type { EventBus } from './event-bus-port.js';
import { SessionCheckpointCas } from './session-checkpoint-cas.js';
import { resolveSessionId, sessionIdResolutionError } from './session-id-resolver.js';
import { scrubPersistedSessionSummary } from './session-read-scrubber.js';
import { deleteSessionArtifacts } from './session-store/delete-session-artifacts.js';
import { collectSessionIds as collectSessionIdsFromDirectory } from './session-store/directory-session-files.js';
import { SessionLoadCache } from './session-store/load-cache.js';
import {
  ensureShardDir as ensureSessionShardDir,
  sessionPath as sessionStorePath,
  shardKeyForSessionId,
  shardManifestPath,
} from './session-store/paths.js';
import {
  type CachedShardManifest,
  listFromDirectoryScan,
  type ShardScanHost,
} from './session-store/shard-scan.js';
import { summarizeSessionFile } from './session-store/summary-builder.js';
import { readSessionSummaryHeader } from './session-store/summary-header.js';
import {
  executeSummaryFor,
  readSummaryManifestFile,
  type SummaryManifestHost,
} from './session-store/summary-manifest.js';
import { locateTranscript } from './session-store/transcript-location.js';
import type {
  IndexCacheEntry,
  SessionFileRef,
  SessionStoreOptions,
} from './session-store/types.js';
import {
  appendToIndexStrictFromState as appendToIndexStrictFromHost,
  compactIndex as compactIndexFromHost,
  compactIndexInnerFromState as compactIndexInnerFromHost,
  persistCatalogSummary as persistCatalogSummaryFromHost,
  readIndex as readIndexFromHost,
  rebuildIndex as rebuildIndexFromHost,
  type SessionStoreIndexHost,
  writeTombstoneFromState as writeTombstoneFromHost,
} from './session-store-index.js';

export abstract class SessionStoreCore {
  protected readonly dir: string;
  protected readonly events?: EventBus | undefined;
  protected readonly secretScrubber: SecretScrubber;
  protected readonly projectRoot?: string | undefined;
  protected readonly checkpointCas?: SessionCheckpointCas | undefined;
  protected readonly isSessionInUse?: ((sessionId: string) => Promise<string | null>) | undefined;
  protected readonly logger: Logger | undefined;
  protected readonly onAppend?: ((event: SessionEvent) => void) | undefined;
  protected readonly onAppendBatch?: ((events: SessionEvent[]) => void) | undefined;
  protected readonly catalogClient: SessionCatalogProjectClient | undefined;
  protected readonly maintenanceHolderId = randomUUID();
  protected readonly storagePolicy: SessionStoragePolicy;
  protected readonly autoArchive: boolean;
  /**
   * One idle-archive pass at a time. A second caller with the same policy
   * shares it; a different policy waits, then runs on its own. The promise
   * here is the inner pass, not the async wrapper, so a later policy cannot
   * be cleared by the earlier pass's `finally`.
   */
  protected archiveIdleInFlight: {
    key: string;
    promise: Promise<SessionArchiveIdleResult>;
  } | null = null;

  protected readonly _loadCache = new Map<
    string,
    import('./session-store/types.js').LoadCacheEntry
  >();
  protected readonly loadCache = new SessionLoadCache(this._loadCache);
  protected _indexCache: IndexCacheEntry | null = null;
  /**
   * Tombstoned ids — hidden even if their JSONL remains on disk.
   * Convention: readIndex() REASSIGNS this set from the parsed index file
   * MERGED with _manualTombstones; writeTombstone() adds in-place immediately
   * so an incremental cache rebuild can never resurrect a just-deleted
   * session.
   */
  protected _indexDeletedIds = new Set<string>();
  /**
   * Tombstones added by THIS store between reads. Merged into every fresh
   * snapshot so a read racing writeTombstone cannot drop an in-flight
   * deletion; entries are pruned once the parsed index file itself carries
   * them.
   */
  protected readonly _manualTombstones = new Set<string>();
  /**
   * File-truth tombstones from the last readIndex() parse (EXCLUDES
   * _manualTombstones additions). compactIndexInner persists THIS snapshot so
   * concurrent writeTombstones that landed after the parse are not written
   * prematurely — they persist through their own append path instead.
   */
  protected _indexFileDeletedIds: ReadonlySet<string> = new Set<string>();
  protected readonly shardManifestCache = new Map<string, CachedShardManifest>();
  protected indexAppendCount = 0;

  constructor(opts: SessionStoreOptions) {
    this.dir = opts.dir;
    this.projectRoot = opts.projectRoot ? path.resolve(opts.projectRoot) : undefined;
    this.checkpointCas = this.projectRoot
      ? new SessionCheckpointCas({
          rootDir: path.join(this.dir, '_cas'),
          projectRoot: this.projectRoot,
        })
      : undefined;
    this.events = opts.events;
    this.secretScrubber = opts.secretScrubber ?? new DefaultSecretScrubber();
    this.isSessionInUse = opts.isSessionInUse;
    this.logger = opts.logger;
    this.onAppend = opts.onAppend;
    this.onAppendBatch = opts.onAppendBatch;
    this.storagePolicy = {
      hotKeepSessions: Math.min(
        10_000,
        Math.max(1, Math.floor(opts.storage?.hotKeepSessions ?? 20)),
      ),
      archiveAfterDays: Math.min(
        3_650,
        Math.max(0, Math.floor(opts.storage?.archiveAfterDays ?? 7)),
      ),
      includeSubagents: opts.storage?.includeSubagents !== false,
    };
    this.autoArchive = opts.storage?.autoArchive === true;
    // The standalone binary is a built runtime too, but its modules live at the
    // executable's virtual URL (no `/dist/`). Missing it here silently ran the
    // binary without the catalog daemon — and `/clear` then rewrote a session
    // file still open elsewhere, which Windows refuses (EPERM).
    const builtRuntime = isStandaloneBinary() || import.meta.url.includes('/dist/');
    this.catalogClient =
      this.projectRoot &&
      (builtRuntime || process.env['WRONGSTACK_SESSION_CATALOG_FORCE'] === '1') &&
      resolveSessionCatalogProjectServerUrl()
        ? new SessionCatalogProjectClient({
            projectDir: path.dirname(this.dir),
            projectRoot: this.projectRoot,
          })
        : undefined;
  }

  protected logWarn(msg: string, ctx?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger.warn(msg, ctx);
    } else {
      console.warn(JSON.stringify({ ...ctx, message: msg, timestamp: new Date().toISOString() }));
    }
  }

  protected scrubSummaries(summaries: readonly SessionSummary[]): SessionSummary[] {
    return summaries.map((summary) => scrubPersistedSessionSummary(summary, this.secretScrubber));
  }

  clearLoadCache(sessionId?: string): void {
    this.loadCache.clear(sessionId);
  }

  async dispose(): Promise<void> {
    await this.catalogClient?.close();
    this.clearLoadCache();
  }

  protected get indexFile(): string {
    return path.join(this.dir, '_index.jsonl');
  }

  protected sessionPath(id: string, ext: '.jsonl' | '.jsonl.gz' | '.summary.json'): string {
    return sessionStorePath(this.dir, id, ext);
  }

  protected async requireTranscript(id: string) {
    const located = await locateTranscript(this.dir, id);
    if (!located) throw new Error(`Session not found: ${id}`);
    return located;
  }

  protected shardManifestPath(shardKey: string): string {
    return shardManifestPath(this.dir, shardKey);
  }

  protected shardKeyForSessionId(id: string): string {
    return shardKeyForSessionId(id);
  }

  protected async invalidateShardManifestBySessionId(id: string): Promise<void> {
    const shardKey = this.shardKeyForSessionId(id);
    const manifestPath = this.shardManifestPath(shardKey);
    await withFileLock(manifestPath, async () => {
      this.shardManifestCache.delete(shardKey);
      try {
        await fsp.unlink(manifestPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    });
  }

  protected async ensureShardDir(id: string): Promise<string> {
    return ensureSessionShardDir(this.dir, id);
  }
  async resolveId(query: string): Promise<string> {
    return this.resolveQuery(query, 'throw');
  }

  /**
   * Canonical id for a user-facing reference.
   *
   * `passthrough` keeps delete() idempotent for an unknown id: a missing
   * query is returned unchanged so the tombstone path can no-op, while an
   * ambiguous query still throws instead of picking a session.
   */
  protected async resolveQuery(query: string, onMissing: 'throw' | 'passthrough'): Promise<string> {
    if (this.catalogClient) {
      try {
        return await this.catalogClient.call('resolve_id', { query });
      } catch (error) {
        if (onMissing === 'passthrough' && isMissingSessionError(error)) return query;
        throw error;
      }
    }
    const normalized = query.trim();
    if (!normalized) {
      if (onMissing === 'passthrough') return query;
      throw new Error('Session not found: (empty query)');
    }
    try {
      const located = await locateTranscript(this.dir, normalized);
      if (located) return normalized;
    } catch {
      // Fall through to exact-leaf / unique-prefix resolution.
    }
    const ids = await this.collectSessionIds(this.dir);
    const resolution = resolveSessionId(normalized, ids);
    if (resolution.status === 'resolved') return resolution.id;
    if (resolution.status === 'ambiguous' || onMissing === 'throw') {
      throw sessionIdResolutionError(
        resolution.status === 'ambiguous' ? resolution : { status: 'missing', query: normalized },
      );
    }
    return query;
  }
  protected async appendToIndexStrict(summary: SessionSummary): Promise<void> {
    return appendToIndexStrictFromHost(this.sessionStoreIndexHost(), summary);
  }

  protected async appendToIndex(summary: SessionSummary): Promise<void> {
    await this.appendToIndexStrict(summary).catch(() => undefined);
  }

  protected async persistCatalogSummary(summary: SessionSummary): Promise<void> {
    return persistCatalogSummaryFromHost(this.sessionStoreIndexHost(), summary);
  }

  protected async writeTombstone(id: string): Promise<void> {
    return writeTombstoneFromHost(this.sessionStoreIndexHost(), id);
  }

  protected async compactIndex(): Promise<void> {
    return compactIndexFromHost(this.sessionStoreIndexHost());
  }

  /**
   * Compact the local index in place.
   *
   * Contract carried into the shared compactIndexInner helper
   * (session-store-index.ts): `entries` MUST already exclude tombstoned ids,
   * and the deleted-set argument is persisted VERBATIM — neither the helper
   * nor its callers may resurrect filtered rows or invent deletions.
   * Locking: callers MUST already hold the indexFile lock (both do:
   * compactIndex() below and the appendToIndexStrict compaction hook);
   * readIndex() inside reads that same locked file, so no second lock may
   * be taken here (non-reentrant → deadlock).
   *
   * That same lock is what makes the _indexFileDeletedIds snapshot safe to
   * pass across the await below: writeTombstone() appends under the identical
   * non-reentrant indexFile lock, so no tombstone can land between our
   * readIndex() and the snapshot handed to the helper. Compaction would
   * otherwise be racing a delete it cannot see.
   */
  protected async compactIndexInner(): Promise<void> {
    return compactIndexInnerFromHost(this.sessionStoreIndexHost());
  }

  protected async readIndex(): Promise<readonly SessionSummary[]> {
    return readIndexFromHost(this.sessionStoreIndexHost());
  }

  /**
   * Merge close-time index rows with directory-scan results, keyed by id.
   * Scanned entries win — their metadata is re-derived from the transcript,
   * so it reflects mid-session activity that index rows (written on close)
   * cannot know about. Indexed-only ids fill gaps; duplicates within the
   * index resolve last-wins, matching append order.
   */
  async rebuildIndex(): Promise<number> {
    return rebuildIndexFromHost(this.sessionStoreIndexHost());
  }

  protected asShardScanHost(): ShardScanHost {
    return {
      dir: this.dir,
      shardManifestCache: this.shardManifestCache,
      shardManifestPath: (...args) => this.shardManifestPath(...args),
      readSummaryManifest: (...args) => this.readSummaryManifest(...args),
      summaryHeaderFor: (...args) => this.summaryHeaderFor(...args),
      summaryFor: (...args) => this.summaryFor(...args),
    };
  }

  protected async listFromDirectoryScan(limit: number): Promise<SessionSummary[]> {
    return listFromDirectoryScan(this.asShardScanHost(), limit);
  }

  protected async collectSessionIds(dir: string, prefix = '', depth = 0): Promise<string[]> {
    return collectSessionIdsFromDirectory(dir, prefix, depth);
  }

  protected asSummaryManifestHost(): SummaryManifestHost {
    return {
      events: this.events,
      sessionPath: (...args) => this.sessionPath(...args),
      requireTranscript: (...args) => this.requireTranscript(...args),
      summarize: (...args) => this.summarize(...args),
      logWarn: (...args) => this.logWarn(...args),
    };
  }

  protected async summaryFor(id: string): Promise<SessionSummary> {
    return executeSummaryFor(this.asSummaryManifestHost(), id);
  }

  protected async readSummaryManifest(
    id: string,
    startTime = Date.now(),
    strict = false,
  ): Promise<SessionSummary | null> {
    const manifest = this.sessionPath(id, '.summary.json');
    return readSummaryManifestFile(manifest, this.events, id, startTime, strict);
  }

  protected async summaryHeaderFor(ref: SessionFileRef): Promise<SessionSummary | null> {
    return readSessionSummaryHeader(ref, this.secretScrubber);
  }

  protected async deleteSession(id: string): Promise<void> {
    const located = await locateTranscript(this.dir, id);
    const jsonlPath = located?.filePath ?? this.sessionPath(id, '.jsonl');
    await deleteSessionArtifacts({ rootDir: this.dir, id, jsonlPath });
    await this.writeTombstone(id);
  }
  protected async summarize(id: string, mtime: string): Promise<SessionSummary> {
    const located = await locateTranscript(this.dir, id);
    return summarizeSessionFile({
      id,
      file: located?.filePath ?? this.sessionPath(id, '.jsonl'),
      mtime,
      secretScrubber: this.secretScrubber,
    });
  }
  protected sessionStoreIndexHost(): SessionStoreIndexHost {
    // Check the complete helper contract while preserving the owner's identity and receivers.
    void ({
      dir: this.dir,
      indexFile: this.indexFile,
      invalidateShardManifestBySessionId: this.invalidateShardManifestBySessionId,
      _indexCache: this._indexCache,
      indexAppendCount: this.indexAppendCount,
      compactIndexInner: this.compactIndexInner,
      catalogClient: this.catalogClient,
      appendToIndex: this.appendToIndex,
      _manualTombstones: this._manualTombstones,
      _indexDeletedIds: this._indexDeletedIds,
      compactIndex: this.compactIndex,
      events: this.events,
      readIndex: this.readIndex,
      _indexFileDeletedIds: this._indexFileDeletedIds,
      collectSessionIds: this.collectSessionIds,
      summaryFor: this.summaryFor,
    } satisfies SessionStoreIndexHost);
    return this as unknown as SessionStoreIndexHost;
  }
}

export function stripSessionTranscriptQuery(query: string): string {
  const lower = query.toLowerCase();
  if (lower.endsWith('.jsonl.gz')) return query.slice(0, -'.jsonl.gz'.length);
  if (lower.endsWith('.jsonl')) return query.slice(0, -'.jsonl'.length);
  return query;
}

function isMissingSessionError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Session not found:');
}

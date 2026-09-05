import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DefaultSecretScrubber } from '../security/secret-scrubber.js';
import {
  resolveSessionCatalogProjectServerUrl,
  SessionCatalogProjectClient,
} from '../session-catalog/client.js';
import type { Logger } from '../types/logger.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type {
  ForkedSession,
  ResumedSession,
  SessionArchiveIdleResult,
  SessionArchiveResult,
  SessionData,
  SessionEvent,
  SessionForkOptions,
  SessionLoadProgress,
  SessionMetadata,
  SessionStoragePolicy,
  SessionStore,
  SessionSummary,
  SessionWriter,
  WorkspaceCheckpointRef,
} from '../types/session.js';
import { withFileLock } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/index.js';
import type { EventBus } from './event-bus-port.js';
import { SessionCheckpointCas } from './session-checkpoint-cas.js';
import { captureCheckpoint, materializeCheckpoint, sessionContentText } from './session-helpers.js';
import { resolveSessionId, sessionIdResolutionError } from './session-id-resolver.js';
import { scrubPersistedSessionSummary } from './session-read-scrubber.js';
import { type CreateSessionHost, executeCreateSession } from './session-store/create-session.js';
import { deleteSessionArtifacts } from './session-store/delete-session-artifacts.js';
import { assertSessionCanBeDeleted } from './session-store/delete-session-guards.js';
import { collectSessionIds as collectSessionIdsFromDirectory } from './session-store/directory-session-files.js';
import { emitSessionStoreWrite } from './session-store/events.js';
import { forkSession } from './session-store/fork-session.js';
import {
  executeListFilteredSessions,
  executeListSessions,
  type ListSessionsHost,
} from './session-store/list-sessions.js';
import { SessionLoadCache } from './session-store/load-cache.js';
import { executeLoadSession } from './session-store/load-session.js';
import {
  ensureShardDir as ensureSessionShardDir,
  sessionPath as sessionStorePath,
  shardKeyForSessionId,
  shardManifestPath,
} from './session-store/paths.js';
import { pruneSessionFiles } from './session-store/prune-helpers.js';
import { executeRebuildIndex } from './session-store/rebuild-index.js';
import { executeRenameSession } from './session-store/rename-session.js';
import { executeResumeSession } from './session-store/resume-session.js';
import { searchSessionEvents } from './session-store/search-events.js';
import {
  executeArchive,
  executeArchiveIdle,
  executeEnsureHot,
  executeRehydrate,
  type SessionArchiveHost,
} from './session-store/session-archive.js';
import { executeClearSessionHistory } from './session-store/session-store-clear.js';
import {
  appendToIndexStrict,
  COMPACT_EVERY,
  compactIndexInner,
  readIndexFile,
  writeTombstone,
} from './session-store/session-store-index.js';
import {
  type CachedShardManifest,
  listFromDirectoryScan,
  type ShardScanHost,
} from './session-store/shard-scan.js';
import { isStrictlyEmptySessionFile } from './session-store/strict-empty-check.js';
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

export type { SessionStoreOptions } from './session-store/types.js';

export class DefaultSessionStore implements SessionStore {
  private readonly dir: string;
  private readonly events?: EventBus | undefined;
  private readonly secretScrubber: SecretScrubber;
  private readonly projectRoot?: string | undefined;
  private readonly checkpointCas?: SessionCheckpointCas | undefined;
  private readonly isSessionInUse?: ((sessionId: string) => Promise<string | null>) | undefined;
  private readonly logger: Logger | undefined;
  private readonly onAppend?: ((event: SessionEvent) => void) | undefined;
  private readonly onAppendBatch?: ((events: SessionEvent[]) => void) | undefined;
  private readonly catalogClient: SessionCatalogProjectClient | undefined;
  private readonly maintenanceHolderId = randomUUID();
  private readonly storagePolicy: SessionStoragePolicy;
  private readonly autoArchive: boolean;
  private archiveIdleInFlight: Promise<SessionArchiveIdleResult> | null = null;

  private readonly _loadCache = new Map<
    string,
    import('./session-store/types.js').LoadCacheEntry
  >();
  private readonly loadCache = new SessionLoadCache(this._loadCache);
  private _indexCache: IndexCacheEntry | null = null;
  /**
   * Tombstoned ids — hidden even if their JSONL remains on disk.
   * Convention: readIndex() REASSIGNS this set from the parsed index file
   * MERGED with _manualTombstones; writeTombstone() adds in-place immediately
   * so an incremental cache rebuild can never resurrect a just-deleted
   * session.
   */
  private _indexDeletedIds = new Set<string>();
  /**
   * Tombstones added by THIS store between reads. Merged into every fresh
   * snapshot so a read racing writeTombstone cannot drop an in-flight
   * deletion; entries are pruned once the parsed index file itself carries
   * them.
   */
  private readonly _manualTombstones = new Set<string>();
  /**
   * File-truth tombstones from the last readIndex() parse (EXCLUDES
   * _manualTombstones additions). compactIndexInner persists THIS snapshot so
   * concurrent writeTombstones that landed after the parse are not written
   * prematurely — they persist through their own append path instead.
   */
  private _indexFileDeletedIds: ReadonlySet<string> = new Set<string>();
  private readonly shardManifestCache = new Map<string, CachedShardManifest>();
  private indexAppendCount = 0;

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
    const builtRuntime = import.meta.url.includes('/dist/');
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

  private logWarn(msg: string, ctx?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger.warn(msg, ctx);
    } else {
      console.warn(JSON.stringify({ ...ctx, message: msg, timestamp: new Date().toISOString() }));
    }
  }

  private scrubSummaries(summaries: readonly SessionSummary[]): SessionSummary[] {
    return summaries.map((summary) => scrubPersistedSessionSummary(summary, this.secretScrubber));
  }

  clearLoadCache(sessionId?: string): void {
    this.loadCache.clear(sessionId);
  }

  async dispose(): Promise<void> {
    await this.catalogClient?.close();
    this.clearLoadCache();
  }

  private get indexFile(): string {
    return path.join(this.dir, '_index.jsonl');
  }

  private sessionPath(id: string, ext: '.jsonl' | '.jsonl.gz' | '.summary.json'): string {
    return sessionStorePath(this.dir, id, ext);
  }

  private async requireTranscript(id: string) {
    const located = await locateTranscript(this.dir, id);
    if (!located) throw new Error(`Session not found: ${id}`);
    return located;
  }

  private shardManifestPath(shardKey: string): string {
    return shardManifestPath(this.dir, shardKey);
  }

  private shardKeyForSessionId(id: string): string {
    return shardKeyForSessionId(id);
  }

  private async invalidateShardManifestBySessionId(id: string): Promise<void> {
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

  private async ensureShardDir(id: string): Promise<string> {
    return ensureSessionShardDir(this.dir, id);
  }

  /**
   * Create a fresh session writer.
   *
   * @threadSafety Failure-prone steps (manifest invalidation, sidecar
   * removal, catalog upsert, the durable `{action:'create'}` index row)
   * run BEFORE the truncating `'w'` open, so no rejection path can destroy
   * prior bytes. Ordinary index summary rows never undelete a tombstone
   * (the parser only honors `{action:'create'}`), so a swallowed create-row
   * would leave a live writer whose id stays hidden forever — that append
   * is therefore required, not best-effort.
   */

  private asCreateHost(): CreateSessionHost {
    return {
      dir: this.dir,
      events: this.events,
      secretScrubber: this.secretScrubber,
      checkpointCas: this.checkpointCas,
      isSessionInUse: this.isSessionInUse,
      catalogClient: this.catalogClient,
      indexFile: this.indexFile,
      onAppend: this.onAppend,
      onAppendBatch: this.onAppendBatch,
      storagePolicy: this.storagePolicy,
      autoArchive: this.autoArchive,
      logWarn: (msg, ctx) => this.logWarn(msg, ctx),
      ensureShardDir: (id) => this.ensureShardDir(id),
      sessionPath: (id, ext) => this.sessionPath(id, ext),
      invalidateShardManifestBySessionId: (id) => this.invalidateShardManifestBySessionId(id),
      readSummaryManifest: (id) => this.readSummaryManifest(id),
      persistCatalogSummary: (summary) => this.persistCatalogSummary(summary),
      archiveIdle: (policy) => this.archiveIdle(policy),
      onIndexAppendCreate: (id) => {
        this._manualTombstones.delete(id);
        this._indexDeletedIds.delete(id);
      },
      clearIndexCache: () => {
        this._indexCache = null;
      },
    };
  }

  private asArchiveHost(): SessionArchiveHost {
    return {
      dir: this.dir,
      storagePolicy: this.storagePolicy,
      isSessionInUse: this.isSessionInUse,
      catalogClient: this.catalogClient,
      maintenanceHolderId: this.maintenanceHolderId,
      secretScrubber: this.secretScrubber,
      clearLoadCache: (sessionId) => this.clearLoadCache(sessionId),
      sessionPath: (id, ext) => this.sessionPath(id, ext),
      summaryFor: (id) => this.summaryFor(id),
      readSummaryManifest: (id) => this.readSummaryManifest(id),
      invalidateShardManifestBySessionId: (id) => this.invalidateShardManifestBySessionId(id),
      appendToIndex: (summary) => this.appendToIndex(summary),
    };
  }

  async create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter> {
    return executeCreateSession(this.asCreateHost(), meta);
  }

  async fork(id: string, opts: SessionForkOptions = {}): Promise<ForkedSession> {
    return forkSession(this, id, opts);
  }

  async readRawEvents(id: string): Promise<SessionEvent[]> {
    const hits = await this.searchEvents(id, () => true);
    return hits.map((hit) => hit.event);
  }

  async captureWorkspaceCheckpoint(sessionId: string, promptIndex: number) {
    return captureCheckpoint(this.checkpointCas, sessionId, promptIndex);
  }

  async materializeWorkspaceCheckpoint(checkpoint: WorkspaceCheckpointRef, targetRoot: string) {
    return materializeCheckpoint(this.checkpointCas, checkpoint, targetRoot);
  }

  async resolveId(query: string): Promise<string> {
    if (this.catalogClient) {
      return this.catalogClient.call('resolve_id', { query });
    }
    const normalized = query.trim();
    if (!normalized) throw new Error('Session not found: (empty query)');
    if (normalized) {
      try {
        const located = await locateTranscript(this.dir, normalized);
        if (located) return normalized;
      } catch {
        // Fall through to exact-leaf / unique-prefix resolution.
      }
    }
    const ids = await this.collectSessionIds(this.dir);
    const resolution = resolveSessionId(normalized, ids);
    if (resolution.status === 'resolved') return resolution.id;
    throw sessionIdResolutionError(resolution);
  }

  async resume(
    id: string,
    onLoadProgress?: (progress: SessionLoadProgress) => void,
  ): Promise<ResumedSession> {
    const canonicalId = await this.resolveId(id);
    await executeEnsureHot(this.asArchiveHost(), canonicalId, false);
    const file = this.sessionPath(canonicalId, '.jsonl');
    return executeResumeSession({
      id,
      canonicalId,
      file,
      projectRoot: this.projectRoot,
      events: this.events,
      secretScrubber: this.secretScrubber,
      checkpointCas: this.checkpointCas,
      onAppend: this.onAppend,
      onAppendBatch: this.onAppendBatch,
      load: (loadId) => this.load(loadId, onLoadProgress),
      readSummaryManifest: (summaryId) => this.readSummaryManifest(summaryId),
      searchEvents: (searchId, pred) => this.searchEvents(searchId, pred),
      persistCatalogSummary: (sum) => this.persistCatalogSummary(sum),
      logWarn: (msg, ctx) => this.logWarn(msg, ctx),
      sessionsDir: this.dir,
    });
  }

  async load(
    id: string,
    onLoadProgress?: (progress: SessionLoadProgress) => void,
  ): Promise<SessionData> {
    return this.loadInternal(id, { full: true }, onLoadProgress);
  }

  async loadEventsOnly(id: string): Promise<SessionData> {
    return this.loadInternal(id, { full: false });
  }

  private async loadInternal(
    id: string,
    mode: { full: true } | { full: false },
    onLoadProgress?: (progress: SessionLoadProgress) => void,
  ): Promise<SessionData> {
    const located = await this.requireTranscript(id);
    return executeLoadSession({
      id,
      file: located.filePath,
      full: mode.full,
      loadCache: this.loadCache,
      events: this.events,
      secretScrubber: this.secretScrubber,
      onLoadProgress,
    });
  }

  async searchEvents(
    id: string,
    predicate: (event: SessionEvent, eventIndex: number, ts: string) => boolean,
    opts?: { limit?: number | undefined; signal?: AbortSignal | undefined },
  ): Promise<Array<{ event: SessionEvent; eventIndex: number; ts: string }>> {
    const located = await locateTranscript(this.dir, id);
    if (!located) return [];
    return searchSessionEvents({
      file: located.filePath,
      secretScrubber: this.secretScrubber,
      predicate,
      limit: opts?.limit,
      signal: opts?.signal,
    });
  }

  private asListSessionsHost(): ListSessionsHost {
    return {
      catalogClient: this.catalogClient,
      readIndex: () => this.readIndex(),
      listFromDirectoryScan: (limit) => this.listFromDirectoryScan(limit),
      scrubSummaries: (summaries) => this.scrubSummaries(summaries),
      getIndexDeletedIds: () => this._indexDeletedIds,
    };
  }

  async list(limit = 20): Promise<SessionSummary[]> {
    return executeListSessions(this.asListSessionsHost(), limit);
  }

  async listFiltered(criteria: {
    since?: string | undefined;
    until?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    minTokens?: number | undefined;
    titleContains?: string | undefined;
    limit?: number | undefined;
  }): Promise<SessionSummary[]> {
    return executeListFilteredSessions(this.asListSessionsHost(), criteria);
  }

  private async appendToIndexStrict(summary: SessionSummary): Promise<void> {
    await appendToIndexStrict(
      this.dir,
      this.indexFile,
      summary,
      (id) => this.invalidateShardManifestBySessionId(id),
      () => {
        this._indexCache = null;
        this.indexAppendCount++;
        const shouldCompact = this.indexAppendCount >= COMPACT_EVERY;
        if (shouldCompact) this.indexAppendCount = 0;
        return { shouldCompact };
      },
      () => this.compactIndexInner(),
    );
  }

  private async appendToIndex(summary: SessionSummary): Promise<void> {
    await this.appendToIndexStrict(summary).catch(() => undefined);
  }

  private async persistCatalogSummary(summary: SessionSummary): Promise<void> {
    if (!this.catalogClient) {
      await this.appendToIndex(summary);
      return;
    }
    const located = await locateTranscript(this.dir, summary.id);
    await this.catalogClient.call('upsert_summary', {
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

  private async writeTombstone(id: string): Promise<void> {
    await writeTombstone(
      this.dir,
      this.indexFile,
      id,
      (sid) => this.invalidateShardManifestBySessionId(sid),
      () => {
        // Immediate in-memory adds: belt-and-braces so a concurrent
        // incremental cache rebuild cannot resurrect the deleted id even if
        // it rebuilds from a base snapshot that predates this tombstone.
        // _manualTombstones survives readIndex() snapshot merges until the
        // parsed file itself carries the row.
        this._manualTombstones.add(id);
        this._indexDeletedIds.add(id);
        this._indexCache = null;
        this.indexAppendCount++;
      },
    );
  }

  private async compactIndex(): Promise<void> {
    const t0 = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    let errorMsg: string | undefined;
    try {
      await withFileLock(this.indexFile, () => this.compactIndexInner());
    } catch (err) {
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
    } finally {
      emitSessionStoreWrite(
        this.events,
        '~compact~',
        this.indexFile,
        'compact',
        outcome,
        Date.now() - t0,
        undefined,
        errorMsg,
      );
    }
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
  private async compactIndexInner(): Promise<void> {
    const entries = await this.readIndex();
    // Persist the FILE-TRUTH tombstone snapshot (not the post-merge view):
    // tombstones that landed after our last parse belong to writeTombstone's
    // own durable path and must not be written prematurely by compaction.
    await compactIndexInner(this.indexFile, entries, this._indexFileDeletedIds);
    this._indexCache = null;
  }

  private async readIndex(): Promise<readonly SessionSummary[]> {
    const { summaries, deletedIds, cache } = await readIndexFile(this.indexFile, this._indexCache);
    this._indexCache = cache;
    // Merge manual tombstones so a read whose snapshot predates a concurrent
    // writeTombstone cannot erase the in-flight deletion; prune entries the
    // parsed file already carries (prune-source = file snapshot, never the
    // set being mutated).
    const merged = new Set(deletedIds);
    for (const manual of this._manualTombstones) {
      merged.add(manual);
      if (deletedIds.has(manual)) this._manualTombstones.delete(manual);
    }
    this._indexFileDeletedIds = deletedIds;
    this._indexDeletedIds = merged;
    return summaries;
  }

  /**
   * Merge close-time index rows with directory-scan results, keyed by id.
   * Scanned entries win — their metadata is re-derived from the transcript,
   * so it reflects mid-session activity that index rows (written on close)
   * cannot know about. Indexed-only ids fill gaps; duplicates within the
   * index resolve last-wins, matching append order.
   */
  async rebuildIndex(): Promise<number> {
    return executeRebuildIndex({
      catalogClient: this.catalogClient,
      indexFile: this.indexFile,
      dir: this.dir,
      readIndex: () => this.readIndex(),
      collectSessionIds: (dir) => this.collectSessionIds(dir),
      summaryFor: (id) => this.summaryFor(id),
      getIndexDeletedIds: () => this._indexDeletedIds,
      clearIndexCache: () => {
        this._indexCache = null;
      },
    });
  }

  private asShardScanHost(): ShardScanHost {
    return {
      dir: this.dir,
      shardManifestCache: this.shardManifestCache,
      shardManifestPath: (shardKey) => this.shardManifestPath(shardKey),
      readSummaryManifest: (id) => this.readSummaryManifest(id),
      summaryHeaderFor: (ref) => this.summaryHeaderFor(ref),
      summaryFor: (id) => this.summaryFor(id),
    };
  }

  private async listFromDirectoryScan(limit: number): Promise<SessionSummary[]> {
    return listFromDirectoryScan(this.asShardScanHost(), limit);
  }

  private async collectSessionIds(dir: string, prefix = '', depth = 0): Promise<string[]> {
    return collectSessionIdsFromDirectory(dir, prefix, depth);
  }

  private asSummaryManifestHost(): SummaryManifestHost {
    return {
      events: this.events,
      sessionPath: (id, ext) => this.sessionPath(id, ext),
      requireTranscript: (id) => this.requireTranscript(id),
      summarize: (id, mtime) => this.summarize(id, mtime),
      logWarn: (msg, ctx) => this.logWarn(msg, ctx),
    };
  }

  private async summaryFor(id: string): Promise<SessionSummary> {
    return executeSummaryFor(this.asSummaryManifestHost(), id);
  }

  private async readSummaryManifest(
    id: string,
    startTime = Date.now(),
  ): Promise<SessionSummary | null> {
    const manifest = this.sessionPath(id, '.summary.json');
    return readSummaryManifestFile(manifest, this.events, id, startTime);
  }

  private async summaryHeaderFor(ref: SessionFileRef): Promise<SessionSummary | null> {
    return readSessionSummaryHeader(ref, this.secretScrubber);
  }

  private async deleteSession(id: string): Promise<void> {
    const located = await locateTranscript(this.dir, id);
    const jsonlPath = located?.filePath ?? this.sessionPath(id, '.jsonl');
    await deleteSessionArtifacts({ rootDir: this.dir, id, jsonlPath });
    await this.writeTombstone(id);
  }

  async isEmpty(id: string): Promise<boolean> {
    const canonicalId = await this.resolveId(id);
    const located = await locateTranscript(this.dir, canonicalId);
    if (!located) return false;
    return isStrictlyEmptySessionFile(located.filePath);
  }

  async delete(id: string): Promise<void> {
    if (this.catalogClient) {
      const canonical = await this.resolveId(id);
      const lease = await this.catalogClient.call('acquire_maintenance', {
        sessionId: canonical,
        operation: 'delete',
        holderId: this.maintenanceHolderId,
      });
      try {
        await this.catalogClient.call('delete', { sessionId: canonical, lease });
      } catch (error) {
        await this.catalogClient.call('release_maintenance', { lease }).catch(() => undefined);
        throw error;
      }
      this.clearLoadCache(canonical);
      return;
    }
    await assertSessionCanBeDeleted(id, this.isSessionInUse);
    await this.deleteSession(id);
  }

  async rename(id: string, name: string): Promise<SessionSummary> {
    if (this.catalogClient) {
      const canonical = await this.resolveId(id);
      const summary = await this.catalogClient.call('rename', {
        sessionId: canonical,
        name: sessionContentText(this.secretScrubber.scrub(name)),
      });
      this.clearLoadCache(canonical);
      return summary;
    }
    const manifest = this.sessionPath(id, '.summary.json');
    const located = await locateTranscript(this.dir, id);
    const jsonlPath = located?.filePath ?? this.sessionPath(id, '.jsonl');
    const updated = await executeRenameSession({
      id,
      name,
      manifest,
      jsonlPath,
      events: this.events,
      secretScrubber: this.secretScrubber,
      readSummaryManifest: (sid) => this.readSummaryManifest(sid),
      summaryFor: (sid) => this.summaryFor(sid),
      appendToIndexStrict: (sum) => this.appendToIndexStrict(sum),
    });
    this.clearLoadCache(id);
    return updated;
  }

  async prune(maxAgeDays = 30): Promise<number> {
    if (this.catalogClient) {
      return this.catalogClient.call('prune', {
        maxAgeDays,
        holderId: this.maintenanceHolderId,
      });
    }
    const deleted = await pruneSessionFiles(
      this.dir,
      maxAgeDays,
      (id) => this.deleteSession(id),
      this.isSessionInUse,
    );
    if (deleted > 0) {
      await this.compactIndex().catch(() => undefined);
    }
    return deleted;
  }

  async clearHistory(id: string): Promise<void> {
    const canonical = this.catalogClient ? await this.resolveId(id) : id;
    await executeClearSessionHistory({
      id,
      canonical,
      catalogClient: this.catalogClient,
      maintenanceHolderId: this.maintenanceHolderId,
      ensureShardDir: (sid) => this.ensureShardDir(sid),
      sessionPath: (sid, ext) => this.sessionPath(sid, ext),
    });
    if (!this.catalogClient) {
      await this.appendToIndexStrict(await this.summaryFor(canonical));
    }
    this.clearLoadCache(canonical);
    // loadInternal() caches under the id it was called with, so a session
    // previously loaded via an alias would keep a raw-keyed entry after a
    // canonical-only clear. Delete both keys; Map.delete no-ops on a miss.
    if (id !== canonical) this.clearLoadCache(id);
    await fsp.unlink(this.sessionPath(canonical, '.jsonl.gz')).catch(() => undefined);
  }

  async archive(id: string): Promise<SessionArchiveResult> {
    const canonical = await this.resolveId(id);
    return executeArchive(this.asArchiveHost(), canonical);
  }

  async rehydrate(id: string): Promise<SessionArchiveResult> {
    const canonical = await this.resolveId(id);
    return executeRehydrate(this.asArchiveHost(), canonical);
  }

  async archiveIdle(policy?: Partial<SessionStoragePolicy>): Promise<SessionArchiveIdleResult> {
    if (this.archiveIdleInFlight) return this.archiveIdleInFlight;
    this.archiveIdleInFlight = executeArchiveIdle(this.asArchiveHost(), {
      ...this.storagePolicy,
      ...policy,
    }).finally(() => {
      this.archiveIdleInFlight = null;
    });
    return this.archiveIdleInFlight;
  }

  private async summarize(id: string, mtime: string): Promise<SessionSummary> {
    const located = await locateTranscript(this.dir, id);
    return summarizeSessionFile({
      id,
      file: located?.filePath ?? this.sessionPath(id, '.jsonl'),
      mtime,
      secretScrubber: this.secretScrubber,
    });
  }
}

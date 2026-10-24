import * as path from 'node:path';
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
  SessionMoveResult,
  SessionMoveTarget,
  SessionStoragePolicy,
  SessionStore,
  SessionSummary,
  SessionWriter,
  WorkspaceCheckpointRef,
} from '@wrongstack/contracts/types/session';
import {
  type CheckpointGcResult,
  collectReachableManifestHashes,
  sweepCheckpointCas,
} from './session-checkpoint-gc.js';
import { captureCheckpoint, materializeCheckpoint } from './session-helpers.js';
import { type CreateSessionHost, executeCreateSession } from './session-store/create-session.js';
import { assertSessionCanBeDeleted } from './session-store/delete-session-guards.js';
import { forkSession } from './session-store/fork-session.js';
import {
  executeListFilteredSessions,
  executeListSessions,
  type ListSessionsHost,
} from './session-store/list-sessions.js';
import { executeLoadSession } from './session-store/load-session.js';
import { executeAdoptMovedSession } from './session-store/move-session.js';
import { executeResumeSession } from './session-store/resume-session.js';
import { searchSessionEvents } from './session-store/search-events.js';
import {
  executeArchive,
  executeEnsureHot,
  executeRehydrate,
  type SessionArchiveHost,
} from './session-store/session-archive.js';
import { isStrictlyEmptySessionFile } from './session-store/strict-empty-check.js';
import { locateTranscript, type TranscriptLocation } from './session-store/transcript-location.js';
import { SessionStoreCore, stripSessionTranscriptQuery } from './session-store-core.js';
import type { SessionStoreRetentionHost } from './session-store-retention.js';
import {
  archiveIdle as archiveIdleFromHost,
  clearHistory as clearHistoryFromHost,
  move as moveFromHost,
  prune as pruneFromHost,
  rename as renameFromHost,
} from './session-store-retention.js';
import { assertRetentionDays } from './session-store-retention-support.js';

export type { SessionStoreOptions } from './session-store/types.js';
export class DefaultSessionStore extends SessionStoreCore implements SessionStore {
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
      logWarn: (...args) => this.logWarn(...args),
      ensureShardDir: (...args) => this.ensureShardDir(...args),
      sessionPath: (...args) => this.sessionPath(...args),
      invalidateShardManifestBySessionId: (...args) =>
        this.invalidateShardManifestBySessionId(...args),
      readSummaryManifest: (...args) => this.readSummaryManifest(...args),
      persistCatalogSummary: (...args) => this.persistCatalogSummary(...args),
      archiveIdle: (...args) => this.archiveIdle(...args),
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
      clearLoadCache: (...args) => this.clearLoadCache(...args),
      sessionPath: (...args) => this.sessionPath(...args),
      summaryFor: (...args) => this.summaryFor(...args),
      readSummaryManifest: (...args) => this.readSummaryManifest(...args),
      invalidateShardManifestBySessionId: (...args) =>
        this.invalidateShardManifestBySessionId(...args),
      appendToIndex: (...args) => this.appendToIndex(...args),
    };
  }

  async create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter> {
    const checkout = meta.checkout ?? this.projectRoot;
    return executeCreateSession(this.asCreateHost(), checkout ? { ...meta, checkout } : meta);
  }

  async fork(id: string, opts: SessionForkOptions = {}): Promise<ForkedSession> {
    // The child records this string as its parent. A leaf or prefix must be
    // the canonical id, or the fork tree cannot find the parent session.
    return forkSession(this, await this.resolveId(id), opts);
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

  /**
   * Reclaim workspace checkpoints no surviving transcript references.
   *
   * Deleting a session removed its transcript but never the manifest and blobs
   * that transcript pointed at, so the CAS only ever grew. This is explicit and
   * user-initiated (`/prune --checkpoints`) rather than part of boot: a full
   * reachability scan on a real store took 101 seconds.
   *
   * `maxAgeDays` is an age floor for the sweep, not a filter for what counts as
   * garbage — anything younger survives, so a mid-sweep capture is safe; an
   * unreadable transcript makes the sweep throw instead of guessing its refs.
   * A non-finite or negative age throws too: `mtime >= NaN` is never true, so
   * the floor would otherwise delete a checkpoint written moments ago.
   */
  async collectCheckpointGarbage(maxAgeDays = 30): Promise<CheckpointGcResult> {
    const ageDays = assertRetentionDays(maxAgeDays);
    const casRoot = path.join(this.dir, '_cas');
    const reachableManifestHashes = await collectReachableManifestHashes(this.dir);
    return sweepCheckpointCas({
      casRoot,
      reachableManifestHashes,
      keepNewerThanMs: Date.now() - ageDays * 86_400_000,
    });
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
      readSummaryManifest: (...args) => this.readSummaryManifest(...args),
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
    // Same reference rules as resume: a unique leaf or prefix names the
    // canonical transcript. An ambiguous or unknown reference throws.
    const canonical = await this.resolveId(id);
    const located = await this.requireTranscript(canonical);
    return executeLoadSession({
      id: canonical,
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
    // Missing stays an empty result. A unique leaf or prefix searches the
    // canonical transcript; an ambiguous reference still throws. The public
    // contract also accepts the id with a `.jsonl` / `.jsonl.gz` suffix.
    // Resolve before the limit cap: a non-positive limit is an empty hit
    // list, not a reason to hide an ambiguous id. The walker checks the cap
    // only after a push, so 0 and -1 used to return the first hit.
    const located = await this.locateSearchTranscript(id);
    if (!located) return [];
    const limit = opts?.limit;
    if (limit !== undefined && Number.isFinite(limit) && limit <= 0) return [];
    return searchSessionEvents({
      file: located.filePath,
      secretScrubber: this.secretScrubber,
      predicate,
      limit,
      signal: opts?.signal,
    });
  }

  /**
   * Resolve a search id, then the same id with one transcript suffix removed
   * when that file is not itself a session. An id that already ends in
   * `.jsonl` keeps the exact file.
   */
  private async locateSearchTranscript(id: string): Promise<TranscriptLocation | null> {
    const direct = await this.resolveQuery(id, 'passthrough');
    const located = await this.locateIfPossible(direct);
    if (located) return located;
    const stripped = stripSessionTranscriptQuery(id.trim());
    if (stripped === id.trim()) return null;
    const canonical = await this.resolveQuery(stripped, 'passthrough');
    return this.locateIfPossible(canonical);
  }

  private async locateIfPossible(id: string): Promise<TranscriptLocation | null> {
    try {
      return await locateTranscript(this.dir, id);
    } catch {
      return null;
    }
  }

  private asListSessionsHost(): ListSessionsHost {
    return {
      catalogClient: this.catalogClient,
      readIndex: (...args) => this.readIndex(...args),
      listFromDirectoryScan: (...args) => this.listFromDirectoryScan(...args),
      scrubSummaries: (...args) => this.scrubSummaries(...args),
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
      if (id !== canonical) this.clearLoadCache(id);
      return;
    }
    // Unknown ids stay idempotent. A unique leaf or prefix must delete the
    // canonical transcript — tombstoning the query itself leaves the session
    // on disk and still listed.
    const canonical = await this.resolveQuery(id, 'passthrough');
    await assertSessionCanBeDeleted(canonical, this.isSessionInUse);
    await this.deleteSession(canonical);
    if (id !== canonical) this.clearLoadCache(id);
  }

  get sessionsDir(): string {
    return this.dir;
  }

  async move(id: string, target: SessionMoveTarget): Promise<SessionMoveResult> {
    return moveFromHost.call(this.sessionStoreRetentionHost(), id, target);
  }

  adoptMovedSession(id: string, name: string | undefined): Promise<SessionSummary> {
    return executeAdoptMovedSession(this.asArchiveHost(), id, name);
  }

  async rename(id: string, name: string): Promise<SessionSummary> {
    return renameFromHost.call(this.sessionStoreRetentionHost(), id, name);
  }

  async prune(maxAgeDays = 30): Promise<number> {
    return pruneFromHost.call(this.sessionStoreRetentionHost(), maxAgeDays);
  }

  async clearHistory(id: string): Promise<void> {
    return clearHistoryFromHost.call(this.sessionStoreRetentionHost(), id);
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
    return archiveIdleFromHost.call(this.sessionStoreRetentionHost(), policy);
  }
  private sessionStoreRetentionHost(): SessionStoreRetentionHost {
    // Preserve the owner's instance and check each member against the helper contract.
    void (this.asArchiveHost satisfies SessionStoreRetentionHost['asArchiveHost']);
    void (this.projectRoot satisfies SessionStoreRetentionHost['projectRoot']);
    void (this.deleteSession satisfies SessionStoreRetentionHost['deleteSession']);
    void (this.resolveId satisfies SessionStoreRetentionHost['resolveId']);
    void (this._indexCache satisfies SessionStoreRetentionHost['_indexCache']);
    void (this.catalogClient satisfies SessionStoreRetentionHost['catalogClient']);
    void (this.secretScrubber satisfies SessionStoreRetentionHost['secretScrubber']);
    void (this.clearLoadCache satisfies SessionStoreRetentionHost['clearLoadCache']);
    void (this.sessionPath satisfies SessionStoreRetentionHost['sessionPath']);
    void (this.dir satisfies SessionStoreRetentionHost['dir']);
    void (this.events satisfies SessionStoreRetentionHost['events']);
    void (this.readSummaryManifest satisfies SessionStoreRetentionHost['readSummaryManifest']);
    void (this.summaryFor satisfies SessionStoreRetentionHost['summaryFor']);
    void (this.appendToIndexStrict satisfies SessionStoreRetentionHost['appendToIndexStrict']);
    void (this.isSessionInUse satisfies SessionStoreRetentionHost['isSessionInUse']);
    void (this.maintenanceHolderId satisfies SessionStoreRetentionHost['maintenanceHolderId']);
    void (this.compactIndex satisfies SessionStoreRetentionHost['compactIndex']);
    void (this.ensureShardDir satisfies SessionStoreRetentionHost['ensureShardDir']);
    void (this.storagePolicy satisfies SessionStoreRetentionHost['storagePolicy']);
    void (this.archiveIdleInFlight satisfies SessionStoreRetentionHost['archiveIdleInFlight']);
    void (this.archiveIdle satisfies SessionStoreRetentionHost['archiveIdle']);
    return this as unknown as SessionStoreRetentionHost;
  }
}

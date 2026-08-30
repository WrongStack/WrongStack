import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from './event-bus-port.js';
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
  SessionData,
  SessionEvent,
  SessionForkOptions,
  SessionLoadProgress,
  SessionMetadata,
  SessionStore,
  SessionSummary,
  SessionWriter,
  WorkspaceCheckpointRef,
} from '../types/session.js';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/index.js';
import { FileSessionWriter } from './file-session-writer.js';
import { SessionCheckpointCas } from './session-checkpoint-cas.js';
import { captureCheckpoint, materializeCheckpoint, sessionContentText } from './session-helpers.js';
import { generateSessionId } from './session-id.js';
import { resolveSessionId, sessionIdResolutionError } from './session-id-resolver.js';
import { scrubPersistedSessionSummary } from './session-read-scrubber.js';
import { deleteSessionArtifacts } from './session-store/delete-session-artifacts.js';
import { assertSessionCanBeDeleted } from './session-store/delete-session-guards.js';
import { shouldSkipSessionDirectoryEntry } from './session-store/directory-scan.js';
import {
  collectSessionFiles as collectSessionFilesFromDirectory,
  collectSessionIds as collectSessionIdsFromDirectory,
} from './session-store/directory-session-files.js';
import {
  emitSessionStoreError,
  emitSessionStoreRead,
  emitSessionStoreWrite,
} from './session-store/events.js';
import { forkSession } from './session-store/fork-session.js';
import { SessionLoadCache } from './session-store/load-cache.js';
import { loadSessionDataFromFile } from './session-store/load-session-data.js';
import {
  ensureShardDir as ensureSessionShardDir,
  sessionPath as sessionStorePath,
  shardKeyForSessionId,
  shardManifestPath,
} from './session-store/paths.js';
import { pruneSessionFiles } from './session-store/prune-helpers.js';
import { executeRenameSession } from './session-store/rename-session.js';
import { executeResumeSession } from './session-store/resume-session.js';
import { searchSessionEvents } from './session-store/search-events.js';
import { executeClearSessionHistory } from './session-store/session-store-clear.js';
import {
  appendToIndexStrict,
  COMPACT_EVERY,
  compactIndexInner,
  readIndexFile,
  writeTombstone,
} from './session-store/session-store-index.js';
import { readOrBuildShardManifestEntry } from './session-store/shard-manifest.js';
import { isStrictlyEmptySessionFile } from './session-store/strict-empty-check.js';
import { summarizeSessionFile } from './session-store/summary-builder.js';
import { readSessionSummaryHeader } from './session-store/summary-header.js';
import type {
  DirectorySummaryCandidate,
  IndexCacheEntry,
  SessionFileRef,
  SessionStoreOptions,
  ShardManifestEntry,
} from './session-store/types.js';
import { compareSessionSummaries, matchesSessionFilter } from './session-summary.js';
import { mapWithConcurrency } from './storage-concurrency.js';

/** Upper bound for filtered-listing candidate pools (bounds pathological dirs). */
const SESSION_FILTER_POOL_LIMIT = 10_000;

export type { SessionStoreOptions } from './session-store/types.js';

interface CachedShardManifest {
  entry: ShardManifestEntry;
  mtimeMs: number;
  size: number;
  ino: number;
}

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
  private static readonly LIST_SCAN_CONCURRENCY = 32;
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

  private sessionPath(id: string, ext: '.jsonl' | '.summary.json'): string {
    return sessionStorePath(this.dir, id, ext);
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
  async create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter> {
    const startedAt = new Date().toISOString();
    const id = meta.id && meta.id.length > 0 ? meta.id : generateSessionId(startedAt);
    const shardDir = await this.ensureShardDir(id);
    const file = this.sessionPath(id, '.jsonl');
    // Refuse creation over an ID another process still holds live BEFORE any
    // destructive step (registry/lease check mirrors the delete-path guard).
    const inUseBy = this.isSessionInUse ? await this.isSessionInUse(id) : null;
    // Truthiness, deliberately matching assertSessionCanBeDeleted
    // (session-store/delete-session-guards.ts): both gates read the same
    // callback, so they must agree on what counts as a reason. An
    // empty-string reason means "no reason" on BOTH paths —
    // diverging here would let an id be deleted but not recreated.
    if (inUseBy) {
      throw new Error(`Refusing to create session ${id}: in use (${inUseBy}).`);
    }
    const t0 = Date.now();
    // Failure-prone steps run BEFORE the truncating 'w' open below: once the
    // transcript is created/truncated, a later rejection could never restore
    // a prior session's bytes. Manifest invalidation therefore aborts
    // creation up-front (nothing has been destroyed yet); after the open it
    // degrades to best-effort because staleness self-heals via stat mismatch.
    try {
      await this.invalidateShardManifestBySessionId(id);
    } catch (cause) {
      throw new Error(
        `Failed to invalidate stale shard manifest for ${id}: ${toErrorMessage(cause)}`,
        { cause },
      );
    }
    // Fresh-session hygiene: drop any stale sidecar from a prior session
    // under this id so list() cannot publish old metadata before the first
    // checkpoint/close. Transcript cleanliness is guaranteed by the 'w'
    // open below (create-or-truncate).
    const sidecar = path.join(shardDir, `${path.basename(id)}.summary.json`);
    try {
      await fsp.rm(sidecar, { force: true });
    } catch (cause) {
      emitSessionStoreError(this.events, id, sidecar, 'create', toErrorMessage(cause), true);
      // A surviving sidecar would be published as THIS session's summary
      // after the transcript is truncated. Only continue when the file is
      // actually gone (ENOENT after a racing unlink).
      try {
        await fsp.access(sidecar);
        throw new Error(
          `Failed to remove stale session sidecar for ${id}: ${toErrorMessage(cause)}`,
          { cause },
        );
      } catch (accessErr) {
        // ENOENT: the racing unlink finished — the file is gone, continue.
        // ENAMETOOLONG: the sidecar path is unrepresentable on this
        // filesystem (Linux NAME_MAX=255), which PROVES the file cannot
        // exist — absence is already established, so continuing is
        // correct. Without this branch the raw errno escapes create()
        // unwrapped on Linux while the transcript-open failure on the
        // same unrepresentable path wraps as `Failed to open session
        // file` below (the documented error contract this path follows).
        const code = (accessErr as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENAMETOOLONG') throw accessErr;
      }
    }
    // Catalog stub upsert BEFORE the truncating 'w' open below: fallible
    // remote IO must reject while prior bytes are still intact rather than
    // destroying a transcript and then failing.
    if (this.catalogClient) {
      await this.catalogClient.call('upsert_summary', {
        summary: {
          id,
          title: meta.title ?? '',
          startedAt,
          model: meta.model ?? '',
          provider: meta.provider ?? '',
          tokenTotal: 0,
          lastActivityAt: startedAt,
        },
        transcriptRelativePath: `${id}.jsonl`,
        summaryRelativePath: `${id}.summary.json`,
      });
    }
    // A deliberate new session with a reused id overrides any prior
    // tombstone — durably, and BEFORE the truncating open: the parser only
    // undeletes on `{action:'create'}`, so a failed row would otherwise
    // hide a live writer forever. In-memory eviction happens only after
    // the control row lands CONFIRMED.
    try {
      await withFileLock(this.indexFile, async () => {
        try {
          await fsp.appendFile(this.indexFile, `${JSON.stringify({ action: 'create', id })}\n`, {
            encoding: 'utf8',
            mode: 0o600,
          });
        } finally {
          // Drop the parsed snapshot whether or not the append reported
          // success. A rejection does not prove nothing landed (a short write,
          // or an error raised while closing after the bytes were already
          // durable), and a cache predating a create row would keep serving a
          // view in which this id is still tombstoned. Invalidation only costs
          // a re-parse, so it is unconditional.
          this._indexCache = null;
        }
        // The in-memory undelete stays on the SUCCESS path only: evicting the
        // tombstone without a durable {action:'create'} row would make the id
        // look live to this process while every other reader — and this one
        // after a restart — still sees it deleted.
        this._manualTombstones.delete(id);
        this._indexDeletedIds.delete(id);
      });
    } catch (cause) {
      throw new Error(
        `Failed to record session create in the index for ${id}: ${toErrorMessage(cause)}`,
        { cause },
      );
    }
    let handle: fsp.FileHandle;
    try {
      // 'w' (create-or-truncate): fresh sessions must never inherit bytes
      // from a surviving transcript under a reused id. Append-mode ('a')
      // would preserve them AND cannot be truncated later on Windows
      // (EPERM — append handles lack FILE_WRITE_DATA).
      handle = await fsp.open(file, 'w', 0o600);
    } catch (err) {
      emitSessionStoreError(this.events, id, file, 'create', toErrorMessage(err), false);
      throw new Error(`Failed to open session file: ${toErrorMessage(err)}`, { cause: err });
    }
    // Re-invalidate AFTER the open/hygiene: a concurrent list() between the
    // first invalidation and here could have rebuilt the manifest from the
    // prior session's artifacts.
    await this.invalidateShardManifestBySessionId(id).catch(() => undefined);
    try {
      const writer = new FileSessionWriter(id, handle, startedAt, meta, this.events, {
        dir: shardDir,
        filePath: file,
        secretScrubber: this.secretScrubber,
        checkpointCas: this.checkpointCas,
        onAppend: this.onAppend,
        onAppendBatch: this.onAppendBatch,
        resolveName: async () => {
          const current = await this.readSummaryManifest(id);
          if (!current) return null;
          return current.name === undefined
            ? {}
            : { name: sessionContentText(this.secretScrubber.scrub(current.name)) };
        },
        onClose: (s) => this.persistCatalogSummary(s),
        // Mid-session metadata checkpoints reuse the same sink as close so
        // killed sessions leave accurate index rows / catalog entries behind.
        onMetadataCheckpoint: (s) => this.persistCatalogSummary(s),
      });
      emitSessionStoreWrite(this.events, id, file, 'create', 'success', Date.now() - t0);
      return writer;
    } catch (err) {
      await handle.close().catch((e) =>
        this.logWarn('Session handle close failed', {
          event: 'session_store.handle_close_failed',
          message: e instanceof Error ? e.message : String(e),
        }),
      );
      emitSessionStoreError(this.events, id, file, 'create', toErrorMessage(err), true);
      throw err;
    }
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
        const stat = await fsp.stat(this.sessionPath(normalized, '.jsonl'));
        if (stat.isFile()) return normalized;
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
    const file = this.sessionPath(id, '.jsonl');
    const t0 = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    let errorMsg: string | undefined;
    let cacheHit = false;
    try {
      const s = await fsp.stat(file);
      const stat: { mtimeMs: number; size: number } = { mtimeMs: s.mtimeMs, size: s.size };
      const cached = this.loadCache.getFresh(id, stat, mode.full);
      if (cached) {
        cacheHit = true;
        // A warm cache parses nothing — report a single completed event so a
        // progress consumer still sees the load reach 100%.
        onLoadProgress?.({ loadedBytes: stat.size, totalBytes: stat.size });
        return cached;
      }

      const data = await loadSessionDataFromFile({
        id,
        file,
        full: mode.full,
        events: this.events,
        secretScrubber: this.secretScrubber,
        onLoadProgress,
      });

      if (mode.full) {
        this.loadCache.set(id, stat, data);
      }

      return data;
    } catch (err) {
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
      throw err;
    } finally {
      emitSessionStoreRead(
        this.events,
        id,
        file,
        mode.full ? 'load' : 'load_events_only',
        outcome,
        Date.now() - t0,
        errorMsg,
      );
      if (cacheHit) {
        this.events?.emit('storage.cache_hit', {
          sessionId: id,
          store: 'session',
          filePath: file,
          operation: mode.full ? 'load' : 'load_events_only',
          durationMs: Date.now() - t0,
        });
      }
    }
  }

  async searchEvents(
    id: string,
    predicate: (event: SessionEvent, eventIndex: number, ts: string) => boolean,
    opts?: { limit?: number | undefined; signal?: AbortSignal | undefined },
  ): Promise<Array<{ event: SessionEvent; eventIndex: number; ts: string }>> {
    return searchSessionEvents({
      file: this.sessionPath(id, '.jsonl'),
      secretScrubber: this.secretScrubber,
      predicate,
      limit: opts?.limit,
      signal: opts?.signal,
    });
  }

  async list(limit = 20): Promise<SessionSummary[]> {
    if (this.catalogClient) {
      const records = await this.catalogClient.call('list_catalog', { limit });
      return this.scrubSummaries(records);
    }
    try {
      // Union of close-time index rows and live JSONL transcripts. A process
      // killed before close() never gets an index row, so an index-only read
      // made killed sessions invisible (or left them as create-time stubs) in
      // /resume whenever any older session had closed cleanly. Scanned
      // metadata wins per id — it is derived from the transcript itself.
      const [indexed, scanned] = await Promise.all([
        this.readIndex(),
        // Wide scan bound: mergeIndexWithScan slices to `limit`, so killed
        // sessions deep in history stay visible instead of being dropped by
        // the user-facing page size before the union runs.
        this.listFromDirectoryScan(SESSION_FILTER_POOL_LIMIT).catch(() => [] as SessionSummary[]),
      ]);
      return this.scrubSummaries(this.mergeIndexWithScan(indexed, scanned, limit));
    } catch {
      return [];
    }
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
    const limit = criteria.limit ?? 100;
    if (this.catalogClient) {
      const records = await this.catalogClient.call('list_catalog', {
        limit,
        ...criteria,
      });
      return this.scrubSummaries(records);
    }
    try {
      // Filter BEFORE slicing over a wide merged pool: capping the pool at
      // `limit` would silently drop matches older than the window (the old
      // index-only path filtered the entire index). The 10k bound covers any
      // realistic history while bounding pathological directories.
      const [indexed, scanned] = await Promise.all([
        this.readIndex(),
        // Same best-effort contract as list(): scan failures enrich nothing
        // but must not blank the filtered result set.
        this.listFromDirectoryScan(SESSION_FILTER_POOL_LIMIT).catch(() => [] as SessionSummary[]),
      ]);
      const pool = this.mergeIndexWithScan(indexed, scanned, SESSION_FILTER_POOL_LIMIT);
      // Scrub BEFORE filtering: matchesSessionFilter compares raw titles,
      // while callers display scrubbed ones — filtering first leaked secrets
      // into match decisions (match-oracle) and desynced hit highlighting.
      return this.scrubSummaries(pool)
        .filter((s) => matchesSessionFilter(s, criteria))
        .slice(0, limit);
    } catch {
      return [];
    }
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
    await this.catalogClient.call('upsert_summary', {
      summary,
      transcriptRelativePath: `${summary.id}.jsonl`,
      summaryRelativePath: `${summary.id}.summary.json`,
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
  private mergeIndexWithScan(
    indexed: readonly SessionSummary[],
    scanned: readonly SessionSummary[],
    limit: number,
  ): SessionSummary[] {
    const byId = new Map<string, SessionSummary>();
    for (const row of indexed) byId.set(row.id, row);
    // Scanned entries fill gaps and refresh known ids with live metadata;
    // tombstone filtering happens ONCE against the merged map below so a
    // stale close-time row cannot survive a concurrent deletion either
    // (asymmetric filtering would leak it).
    for (const row of scanned) byId.set(row.id, row);
    return [...byId.values()]
      .filter((row) => !this._indexDeletedIds.has(row.id))
      .sort(compareSessionSummaries)
      .slice(0, limit);
  }

  /**
   * Rebuild the index from what is actually on disk.
   *
   * @returns the number of healthy, live entries in the rebuilt index. Both
   * backends report that same quantity: ids whose summary could not be derived
   * are excluded (the catalog counts them as `damaged`; the local scan drops
   * them when `summaryFor` rejects), and ids carrying a surviving tombstone are
   * excluded (the catalog rebuilds only from live files; the local branch skips
   * them explicitly). It is NOT a count of rows written to the file — tombstone
   * rows are persisted but never counted.
   */
  async rebuildIndex(): Promise<number> {
    if (this.catalogClient) {
      const result = await this.catalogClient.call('rebuild_catalog', {}, { timeoutMs: 120_000 });
      return result.indexed;
    }
    // Snapshot + write under the same lock so a concurrent writeTombstone
    // or create-row cannot land between the read and the atomic replace
    // (that hole resurrected deleted ids or dropped a just-created row).
    return withFileLock(this.indexFile, async () => {
      await this.readIndex();
      const ids = await this.collectSessionIds(this.dir);
      const summaries = await Promise.all(ids.map((id) => this.summaryFor(id).catch(() => null)));
      const valid = summaries.filter((s): s is SessionSummary => s !== null);
      const parts: string[] = [];
      // Scanned-but-tombstoned ids: their files still exist so the scan finds
      // them, but writing a summary row would undelete them. Counted only to
      // subtract from the documented return value.
      let tombstoned = 0;
      for (const s of valid) {
        if (this._indexDeletedIds.has(s.id)) {
          tombstoned++;
          continue;
        }
        parts.push(JSON.stringify(s));
      }
      for (const id of this._indexDeletedIds) {
        parts.push(JSON.stringify({ action: 'delete', id }));
      }
      const lines = parts.join('\n') + '\n';
      await atomicWrite(this.indexFile, lines, { mode: 0o600 });
      this._indexCache = null;
      return valid.length - tombstoned;
    });
  }

  private async listFromDirectoryScan(limit: number): Promise<SessionSummary[]> {
    const shardKeys = await this.collectShardKeys();
    const shardEntries = await mapWithConcurrency(
      shardKeys,
      DefaultSessionStore.LIST_SCAN_CONCURRENCY,
      async (shardKey) => await this.readOrBuildShardManifest(shardKey),
    );

    const out: DirectorySummaryCandidate[] = [];
    for (const entry of shardEntries) {
      for (const summary of entry.summaries) {
        out.push({ summary, needsBackfill: false });
      }
    }
    out.sort((a, b) => compareSessionSummaries(a.summary, b.summary));

    const selected = out.slice(0, limit);
    const summaries = await mapWithConcurrency(
      selected,
      Math.min(DefaultSessionStore.LIST_SCAN_CONCURRENCY, Math.max(1, limit)),
      async (candidate): Promise<SessionSummary | null> => candidate.summary,
    );
    return summaries.filter((s): s is SessionSummary => s !== null);
  }

  private async collectShardKeys(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch {
      return [''];
    }

    const shardKeys = [''];
    for (const entry of entries) {
      if (shouldSkipSessionDirectoryEntry(entry.name)) continue;
      if (entry.isDirectory()) shardKeys.push(entry.name);
    }
    return shardKeys;
  }

  private async readOrBuildShardManifest(shardKey: string): Promise<ShardManifestEntry> {
    const manifestPath = this.shardManifestPath(shardKey);
    const cached = await this.freshShardManifestCacheEntry(shardKey, manifestPath);
    if (cached) return cached;

    return withFileLock(manifestPath, async () => {
      const lockedCached = await this.freshShardManifestCacheEntry(shardKey, manifestPath);
      if (lockedCached) return lockedCached;
      const entry = await readOrBuildShardManifestEntry({
        shardKey,
        manifestPath,
        concurrency: DefaultSessionStore.LIST_SCAN_CONCURRENCY,
        collectSessionFilesInShard: (key) => this.collectSessionFilesInShard(key),
        readSummaryManifest: (id) => this.readSummaryManifest(id),
        summaryHeaderFor: (ref) => this.summaryHeaderFor(ref),
        summaryFor: (id) => this.summaryFor(id),
      });
      try {
        const stat = await fsp.stat(manifestPath);
        this.shardManifestCache.set(shardKey, {
          entry,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          ino: stat.ino,
        });
      } catch {
        this.shardManifestCache.delete(shardKey);
      }
      return entry;
    });
  }

  private async freshShardManifestCacheEntry(
    shardKey: string,
    manifestPath: string,
  ): Promise<ShardManifestEntry | undefined> {
    const cached = this.shardManifestCache.get(shardKey);
    if (!cached) return undefined;
    try {
      const stat = await fsp.stat(manifestPath);
      if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size && stat.ino === cached.ino) {
        return cached.entry;
      }
    } catch {
      // Invalidate
    }
    this.shardManifestCache.delete(shardKey);
    return undefined;
  }

  private async collectSessionFilesInShard(shardKey: string): Promise<SessionFileRef[]> {
    const dir = shardKey ? path.join(this.dir, shardKey) : this.dir;
    const entries = await this.collectSessionFiles(dir, shardKey);
    return shardKey
      ? entries.filter((entry) => entry.id.startsWith(`${shardKey}/`))
      : entries.filter((entry) => !entry.id.includes('/'));
  }

  private async collectSessionFiles(
    dir: string,
    prefix = '',
    depth = 0,
  ): Promise<SessionFileRef[]> {
    return collectSessionFilesFromDirectory(dir, prefix, depth);
  }

  private async collectSessionIds(dir: string, prefix = '', depth = 0): Promise<string[]> {
    return collectSessionIdsFromDirectory(dir, prefix, depth);
  }

  private async summaryFor(id: string): Promise<SessionSummary> {
    const manifest = this.sessionPath(id, '.summary.json');
    const t0 = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    let errorMsg: string | undefined;
    const fromManifest = await this.readSummaryManifest(id, t0);
    if (fromManifest) return fromManifest;

    try {
      const full = this.sessionPath(id, '.jsonl');
      const stat = await fsp.stat(full);
      const summary = await this.summarize(id, stat.mtime.toISOString());
      await atomicWrite(manifest, JSON.stringify(summary), { mode: 0o600 }).catch((err) => {
        const msg = toErrorMessage(err);
        emitSessionStoreError(this.events, id, manifest, 'summary_fallback', msg, true);
        this.logWarn('Session manifest write failed', {
          event: 'session_store.manifest_write_failed',
          sessionId: id,
          message: msg,
        });
      });
      outcome = 'failure';
      errorMsg = 'summary fallback — manifest rebuilt';
      emitSessionStoreRead(
        this.events,
        id,
        manifest,
        'summary',
        outcome,
        Date.now() - t0,
        errorMsg,
      );
      return summary;
    } catch (err) {
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
      emitSessionStoreRead(
        this.events,
        id,
        manifest,
        'summary',
        outcome,
        Date.now() - t0,
        errorMsg,
      );
      return {
        id,
        title: '(damaged)',
        startedAt: new Date().toISOString(),
        model: 'unknown',
        provider: 'unknown',
        tokenTotal: 0,
      };
    }
  }

  private async readSummaryManifest(
    id: string,
    startTime = Date.now(),
  ): Promise<SessionSummary | null> {
    const manifest = this.sessionPath(id, '.summary.json');
    try {
      const raw = await fsp.readFile(manifest, 'utf8');
      emitSessionStoreRead(this.events, id, manifest, 'summary', 'success', Date.now() - startTime);
      return JSON.parse(raw) as SessionSummary;
    } catch {
      return null;
    }
  }

  private async summaryHeaderFor(ref: SessionFileRef): Promise<SessionSummary | null> {
    return readSessionSummaryHeader(ref, this.secretScrubber);
  }

  private async deleteSession(id: string): Promise<void> {
    const jsonlPath = this.sessionPath(id, '.jsonl');
    await deleteSessionArtifacts({ rootDir: this.dir, id, jsonlPath });
    await this.writeTombstone(id);
  }

  async isEmpty(id: string): Promise<boolean> {
    const canonicalId = await this.resolveId(id);
    return isStrictlyEmptySessionFile(this.sessionPath(canonicalId, '.jsonl'));
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
    const jsonlPath = this.sessionPath(id, '.jsonl');
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
  }

  private async summarize(id: string, mtime: string): Promise<SessionSummary> {
    return summarizeSessionFile({
      id,
      file: this.sessionPath(id, '.jsonl'),
      mtime,
      secretScrubber: this.secretScrubber,
    });
  }
}

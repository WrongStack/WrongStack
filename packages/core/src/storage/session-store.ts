import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from '../kernel/events.js';
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

  async create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter> {
    const startedAt = new Date().toISOString();
    const id = meta.id && meta.id.length > 0 ? meta.id : generateSessionId(startedAt);
    const shardDir = await this.ensureShardDir(id);
    const file = this.sessionPath(id, '.jsonl');
    const t0 = Date.now();
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(file, 'a', 0o600);
    } catch (err) {
      emitSessionStoreError(this.events, id, file, 'create', toErrorMessage(err), false);
      throw new Error(`Failed to open session file: ${toErrorMessage(err)}`, { cause: err });
    }
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
      });
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

  async resume(id: string): Promise<ResumedSession> {
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
      load: (loadId) => this.load(loadId),
      readSummaryManifest: (summaryId) => this.readSummaryManifest(summaryId),
      searchEvents: (searchId, pred) => this.searchEvents(searchId, pred),
      persistCatalogSummary: (sum) => this.persistCatalogSummary(sum),
      logWarn: (msg, ctx) => this.logWarn(msg, ctx),
    });
  }

  async load(id: string): Promise<SessionData> {
    return this.loadInternal(id, { full: true });
  }

  async loadEventsOnly(id: string): Promise<SessionData> {
    return this.loadInternal(id, { full: false });
  }

  private async loadInternal(
    id: string,
    mode: { full: true } | { full: false },
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
        return cached;
      }

      const data = await loadSessionDataFromFile({
        id,
        file,
        full: mode.full,
        events: this.events,
        secretScrubber: this.secretScrubber,
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
      const indexed = await this.readIndex();
      if (indexed.length > 0) {
        return this.scrubSummaries(indexed.slice(0, limit));
      }
      return this.scrubSummaries(await this.listFromDirectoryScan(limit));
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
      const indexed = await this.readIndex();
      if (indexed.length === 0) {
        const raw = await this.list(Math.max(limit, 100));
        return raw.filter((s) => matchesSessionFilter(s, criteria)).slice(0, limit);
      }
      const filtered = this.scrubSummaries(indexed).filter((s) =>
        matchesSessionFilter(s, criteria),
      );
      return filtered.slice(0, limit);
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

  private async compactIndexInner(): Promise<void> {
    const entries = await this.readIndex();
    if (entries.length === 0) return;
    const lines = entries.map((s) => JSON.stringify(s)).join('\n') + '\n';
    await atomicWrite(this.indexFile, lines, { mode: 0o600 });
    this._indexCache = null;
  }

  private async readIndex(): Promise<readonly SessionSummary[]> {
    const { summaries, cache } = await readIndexFile(this.indexFile, this._indexCache);
    this._indexCache = cache;
    return summaries;
  }

  async rebuildIndex(): Promise<number> {
    if (this.catalogClient) {
      const result = await this.catalogClient.call('rebuild_catalog', {}, { timeoutMs: 120_000 });
      return result.indexed;
    }
    const ids = await this.collectSessionIds(this.dir);
    const summaries = await Promise.all(
      ids.map((id) => this.summaryFor(id).catch(() => null)),
    );
    const valid = summaries.filter((s): s is SessionSummary => s !== null);
    const lines = valid.map((s) => JSON.stringify(s)).join('\n') + '\n';
    await withFileLock(this.indexFile, async () => {
      await atomicWrite(this.indexFile, lines, { mode: 0o600 });
      this._indexCache = null;
    });
    return valid.length;
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
    const deleted = await pruneSessionFiles(this.dir, maxAgeDays, (id) => this.deleteSession(id));
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
    this.clearLoadCache(canonical);
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

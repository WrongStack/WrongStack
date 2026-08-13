import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from '../kernel/events.js';
import { SECRET_FILE_MODE } from '../security/file-permissions.js';
import { DefaultSecretScrubber } from '../security/secret-scrubber.js';
import {
  resolveSessionCatalogProjectServerUrl,
  SessionCatalogProjectClient,
} from '../session-catalog/client.js';
import type { Logger } from '../types/logger.js';
import type { Message } from '../types/messages.js';
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
import { atomicWrite, ensureDir, withFileLock } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/index.js';
import { FileSessionWriter } from './file-session-writer.js';
import { SessionCheckpointCas } from './session-checkpoint-cas.js';
import { captureCheckpoint, materializeCheckpoint, sessionContentText } from './session-helpers.js';
import { generateSessionId } from './session-id.js';
import { resolveSessionId, sessionIdResolutionError } from './session-id-resolver.js';
import { scrubPersistedSessionSummary } from './session-read-scrubber.js';
import {
  formatInterruptedToolNotice,
  formatResumeValidationNotice,
  isResumeNoticeMessage,
  validateResumeFileObservations,
} from './session-resume-validation.js';
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
import { applySessionIndexLines, readFileRange } from './session-store/index-reader.js';
import { SessionLoadCache } from './session-store/load-cache.js';
import { loadSessionDataFromFile } from './session-store/load-session-data.js';
import {
  ensureShardDir as ensureSessionShardDir,
  sessionPath as sessionStorePath,
  shardKeyForSessionId,
  shardManifestPath,
} from './session-store/paths.js';
import { pruneSessionFiles } from './session-store/prune-helpers.js';
import { searchSessionEvents } from './session-store/search-events.js';
import { readOrBuildShardManifestEntry } from './session-store/shard-manifest.js';
import { isStrictlyEmptySessionFile } from './session-store/strict-empty-check.js';
import { summarizeSessionEvents, summarizeSessionFile } from './session-store/summary-builder.js';
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
  /** Present in built production output; source-only tests retain the local compatibility path. */
  private readonly catalogClient: SessionCatalogProjectClient | undefined;
  private readonly maintenanceHolderId = randomUUID();

  /**
   * In-memory cache for load() results, keyed by session ID. The cache is
   * invalidated when the file's mtimeMs or size changes (indicating the
   * file was written to). This eliminates redundant full-file reads and
   * JSON parses when the same session is loaded multiple times within the
   * store's lifetime (e.g., webui session detail views, list() fallbacks).
   *
   * Max size is capped to prevent unbounded memory growth in long-running
   * processes. When the limit is reached, the oldest entry is evicted.
   */
  private readonly _loadCache = new Map<
    string,
    import('./session-store/types.js').LoadCacheEntry
  >();
  private readonly loadCache = new SessionLoadCache(this._loadCache);
  private _indexCache: IndexCacheEntry | null = null;
  private readonly shardManifestCache = new Map<string, CachedShardManifest>();
  private static readonly LIST_SCAN_CONCURRENCY = 32;

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

  /**
   * Emit a structured warning. Uses the configured Logger when available;
   * falls back to console.warn(JSON) so warnings are never silently dropped.
   */
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

  /**
   * Clear the load() cache. Useful for testing or when the caller knows
   * the file has changed externally (e.g., another process wrote to it).
   */
  clearLoadCache(sessionId?: string): void {
    this.loadCache.clear(sessionId);
  }

  async dispose(): Promise<void> {
    await this.catalogClient?.close();
    this.clearLoadCache();
  }

  // â”€â”€ Storage event helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Absolute path to the session index file. */
  private get indexFile(): string {
    return path.join(this.dir, '_index.jsonl');
  }

  /** Join session ID to its absolute path within the store directory. */
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

  /**
   * Ensure the directory implied by the session ID exists. When the ID
   * contains a date prefix like `2026-06-06/...`, this creates the date
   * subdirectory so sessions group naturally by day.
   */
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
      /* v8 ignore start -- defensive: FileSessionWriter ctor does not throw in practice */
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
    /* v8 ignore stop */
  }

  async fork(id: string, opts: SessionForkOptions = {}): Promise<ForkedSession> {
    return forkSession(this, id, opts);
  }

  /**
   * Implements {@link SessionForkHost.readRawEvents} — the parent stream a fork
   * inherits, unmodified.
   *
   * Deliberately NOT `load()`: that loader empties superseded snapshot payloads
   * in place and front-drops events past its retention budget, both of which
   * are correct for reconstructing a conversation and wrong for copying a
   * journal prefix into a child. Streaming with an accept-everything predicate
   * keeps the scrubbing contract (`searchEvents` scrubs each line the same way
   * `load()` does) without either transformation.
   */
  async readRawEvents(id: string): Promise<SessionEvent[]> {
    const hits = await this.searchEvents(id, () => true);
    return hits.map((hit) => hit.event);
  }

  /**
   * Capture the deterministic post-tool workspace identity through the store-owned CAS.
   */
  async captureWorkspaceCheckpoint(sessionId: string, promptIndex: number) {
    return captureCheckpoint(this.checkpointCas, sessionId, promptIndex);
  }
  /**
   * Materialize a store-owned checkpoint into an already isolated workspace.
   */
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
    const t0 = Date.now();
    const data = await this.load(canonicalId);
    const persistedSummary = await this.readSummaryManifest(canonicalId);
    const fileStat = await fsp.stat(file);
    // When the events array was front-truncated to stay within the retention
    // budget (`eventsDropped > 0`), the oldest records are missing from memory.
    // The summary must be derived from the full file, and file-observation
    // validation must use the streaming search path to see every observation.
    const eventsDropped = data.eventsDropped ?? 0;
    const derivedSummary =
      eventsDropped > 0
        ? await summarizeSessionFile({
            id: canonicalId,
            file,
            mtime: fileStat.mtime.toISOString(),
            secretScrubber: this.secretScrubber,
          })
        : await summarizeSessionEvents({
            id: canonicalId,
            events: data.events,
            mtime: fileStat.mtime.toISOString(),
          });
    const initialSummary: SessionSummary = {
      ...derivedSummary,
      ...(persistedSummary?.name !== undefined ? { name: persistedSummary.name } : {}),
    };
    // Ephemeral system notices injected into the first resumed turn. Both are
    // informational only — neither re-executes any prior work.
    const noticeMessages: Message[] = [];
    let resumeValidation: import('../types/session.js').ResumeValidation | undefined;
    if (this.projectRoot) {
      try {
        const validationEvents =
          eventsDropped > 0
            ? (
                await this.searchEvents(
                  canonicalId,
                  (ev: SessionEvent, _i: number, _ts: string) => ev.type === 'file_observation',
                )
              ).map((h) => h.event)
            : data.events;
        resumeValidation = await validateResumeFileObservations(validationEvents, this.projectRoot);
        const notice = formatResumeValidationNotice(resumeValidation, this.projectRoot);
        if (notice) {
          noticeMessages.push({
            role: 'system',
            content: notice,
            ts: resumeValidation.checkedAt,
          });
        }
      } catch (err) {
        // Validation is a safety signal, not a reason to make an otherwise
        // readable session impossible to resume. Surface diagnostics and
        // continue with the replay if an unexpected filesystem error occurs.
        emitSessionStoreError(
          this.events,
          canonicalId,
          file,
          'resume_validation',
          toErrorMessage(err),
          true,
        );
      }
    }
    // Interrupted-tool notice is independent of projectRoot — it reflects the
    // reconstructed conversation, not the filesystem.
    const interruptedNotice = formatInterruptedToolNotice(data.pendingToolUseCount ?? 0);
    if (interruptedNotice) {
      noticeMessages.push({
        role: 'system',
        content: interruptedNotice,
        ts: new Date().toISOString(),
      });
    }
    // Notices from earlier resumes were journaled by the caller's
    // `replaceMessages` and replayed back into `data.messages`. They describe a
    // validation run that this one has just superseded, so they are dropped
    // before the current notices are appended — otherwise every resume of a
    // session with a still-modified file adds another copy that never leaves.
    // Building a fresh array here also stops `resume()` handing the caller the
    // load cache's own message array to mutate.
    const carriedMessages = data.messages.filter((message) => !isResumeNoticeMessage(message));
    const resumedData: SessionData = {
      ...data,
      ...(resumeValidation ? { resumeValidation } : {}),
      messages: [...carriedMessages, ...noticeMessages],
    };
    let handle: fsp.FileHandle;
    try {
      handle = await openSessionForAppend(file);
      /* v8 ignore start -- defensive: load() above already validated the file is readable */
    } catch (err) {
      emitSessionStoreError(this.events, canonicalId, file, 'resume', toErrorMessage(err), false);
      throw new Error(
        `Failed to open session "${canonicalId}" for append: ${toErrorMessage(err)}`,
        {
          cause: err,
        },
      );
    }
    /* v8 ignore stop */
    try {
      const writer = new FileSessionWriter(
        canonicalId,
        handle,
        new Date().toISOString(),
        {
          id: canonicalId,
          model: data.metadata.model,
          provider: data.metadata.provider,
        },
        this.events,
        {
          resumed: true,
          initialSummary,
          // Shard directory (sessions/<date>/) — must match create() so the
          // .summary.json sidecar lands next to the JSONL instead of the
          // sessions root (where summaryFor() would never find it).
          dir: path.dirname(file),
          filePath: file,
          secretScrubber: this.secretScrubber,
          checkpointCas: this.checkpointCas,
          onAppend: this.onAppend,
          onAppendBatch: this.onAppendBatch,
          resolveName: async () => {
            const current = await this.readSummaryManifest(canonicalId);
            if (!current) return null;
            return current.name === undefined
              ? {}
              : { name: sessionContentText(this.secretScrubber.scrub(current.name)) };
          },
          onClose: (s) => this.persistCatalogSummary(s),
        },
      );
      emitSessionStoreWrite(this.events, canonicalId, file, 'resume', 'success', Date.now() - t0);
      return { writer, data: resumedData };
      /* v8 ignore start -- defensive: FileSessionWriter ctor does not throw in practice */
    } catch (err) {
      await handle.close().catch((e) =>
        this.logWarn('Session handle close failed', {
          event: 'session_store.handle_close_failed',
          message: e instanceof Error ? e.message : String(e),
        }),
      );
      emitSessionStoreError(this.events, canonicalId, file, 'resume', toErrorMessage(err), true);
      throw err;
    }
    /* v8 ignore stop */
  }

  async load(id: string): Promise<SessionData> {
    return this.loadInternal(id, { full: true });
  }

  /**
   * Fast-path loader that skips message reconstruction and adjacency repair.
   *
   * Use this for callers that only need the raw event stream + session
   * metadata — e.g. session listers, analytics, audit, and the TUI's
   * "events only" views. It avoids the message array build and
   * repairToolUseAdjacency cost on large session files (a long agent
   * run can have 50k+ events; rebuilding messages is O(events) and
   * allocates per-block, so skipping it is a meaningful win).
   *
   * The returned data.messages is an empty array; data.toolCallEnds
   * is computed from the raw events. usage is the sum across all
   * llm_response events — same as full load().
   */
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
      // Stat the file first to check the cache. The stat is cheap (no content
      // read) and lets us skip the full readFile + JSON parse when the file
      // hasn't changed since the last load.
      const s = await fsp.stat(file);
      const stat: { mtimeMs: number; size: number } = { mtimeMs: s.mtimeMs, size: s.size };

      // Check cache: if mtimeMs AND size match, the file hasn't changed.
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

      // Only full loads populate the cache; events-only loads always read
      // through (they're cheap, and a hot loop on events-only would
      // otherwise evict full-load entries that callers also need).
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

  /**
   * Streaming search over a session's JSONL. Walks the file once, parses
   * each event lazily, and yields only the events that match `predicate`.
   * Stops as soon as `opts.limit` matches are collected.
   *
   * Why this exists: `load()` parses the entire file into memory and
   * rebuilds `messages`/`toolCallEnds` for every caller. `search()` only
   * needs to know which events contain matching text — a per-line
   * predicate is enough. The full parse work (and the `_loadCache` poll)
   * is wasted in that case.
   *
   * Memory: O(hits) regardless of file size. Disk: one linear scan,
   * terminated at `limit` if the caller asked for one.
   *
   * Errors: missing file yields []. Corrupt lines are skipped (same
   * policy as `load()`). Aborting via `signal` rejects with `AbortError`.
   */
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
      // Try the index first; fall back to directory scan if the index is
      // missing, empty, or unreadable.
      const indexed = await this.readIndex();
      if (indexed.length > 0) {
        // `readIndex()` already sorted the array by startedAt DESC, id
        // ASC, so we just slice the prefix.
        return this.scrubSummaries(indexed.slice(0, limit));
      }
      // Index unavailable — fall back to a directory scan. Prefer summary
      // sidecars and only backfill full JSONL-derived summaries for the page
      // we are about to return.
      return this.scrubSummaries(await this.listFromDirectoryScan(limit));
    } catch {
      return [];
    }
  }

  /**
   * List sessions matching filter criteria, using the cached index.
   * Filters are applied BEFORE sorting and slicing, so the caller gets
   * exactly `limit` matching sessions — not a slice of a larger fetch.
   *
   * This avoids the DefaultSessionReader pattern of fetching 1000 sessions
   * then linear-filtering: the index is already in memory (readIndex
   * caches it), and the filter runs over the cached array without any
   * additional disk I/O.
   */
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
        // No index — fall back to list() + in-process filter.
        const raw = await this.list(Math.max(limit, 100));
        return raw.filter((s) => matchesSessionFilter(s, criteria)).slice(0, limit);
      }
      const filtered = this.scrubSummaries(indexed).filter((s) =>
        matchesSessionFilter(s, criteria),
      );
      // Filtering preserves the index's existing newest-first order.
      return filtered.slice(0, limit);
    } catch {
      return [];
    }
  }

  // â”€â”€ Session index (_index.jsonl) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  //
  // One JSON line per closed session, appended atomically on close().
  // When a session is deleted, a tombstone {action:"delete",id:"..."} is
  // appended. On read, tombstones filter out matching session entries.
  // This keeps listing O(lines-in-index) instead of O(files-on-disk).
  //
  // The index auto-compacts every N appends to prevent unbounded growth
  // from tombstones and duplicate entries (resume cycles).

  private indexAppendCount = 0;
  private static readonly COMPACT_EVERY = 30;

  /** Append a session summary to the index, propagating persistence failures. */
  private async appendToIndexStrict(summary: SessionSummary): Promise<void> {
    await ensureDir(this.dir);
    // Serialize the append (and any compaction it triggers) under the index
    // file lock. The lock is per-FILE, so it also guards against a SECOND
    // wstack process in the same project appending/compacting concurrently —
    // without it, a compact() rewrite racing an append() silently drops the
    // appended line (the source-of-truth .jsonl survives, but the listing
    // cache loses the entry until rebuildIndex()).
    let shouldCompact = false;
    await withFileLock(this.indexFile, async () => {
      // Invalidate before appending so an invalidation failure cannot leave a
      // successfully-updated index paired with a stale persisted shard view.
      await this.invalidateShardManifestBySessionId(summary.id);
      const line = JSON.stringify(summary) + '\n';
      await fsp.appendFile(this.indexFile, line, { encoding: 'utf8', mode: SECRET_FILE_MODE });
      this._indexCache = null;
      this.indexAppendCount++;
      // Auto-compact periodically to remove tombstones and duplicates.
      // compactIndexInner() is called WHILE the lock is held — it must not
      // re-acquire it (withFileLock is not reentrant) or it would deadlock.
      if (this.indexAppendCount >= DefaultSessionStore.COMPACT_EVERY) {
        shouldCompact = true;
        this.indexAppendCount = 0;
      }
    });
    if (shouldCompact) {
      await withFileLock(this.indexFile, () => this.compactIndexInner());
    }
  }

  /** Best-effort index append used by writer close. */
  private async appendToIndex(summary: SessionSummary): Promise<void> {
    // Note: storage.write for this operation is emitted by FileSessionWriter.doClose()
    // so it can include the traceId. Do NOT emit here to avoid duplicates.
    await this.appendToIndexStrict(summary).catch(() => {
      // best-effort — error surfaced via the storage.write event in doClose()
    });
  }

  /** Final summary boundary: daemon is authoritative when available. */
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

  /** Append a tombstone entry for a deleted session. */
  private async writeTombstone(id: string): Promise<void> {
    try {
      await ensureDir(this.dir);
      await withFileLock(this.indexFile, async () => {
        const line = JSON.stringify({ action: 'delete', id }) + '\n';
        await fsp.appendFile(this.indexFile, line, { encoding: 'utf8', mode: SECRET_FILE_MODE });
        this._indexCache = null;
        await this.invalidateShardManifestBySessionId(id);
        this.indexAppendCount++;
      });
    } catch {
      // best-effort
    }
  }

  /**
   * Compact the index: read all entries, drop tombstones, deduplicate
   * (keep latest per session), and rewrite atomically. Acquires the index
   * file lock so a concurrent append (this process or another wstack in the
   * same project) can't be overwritten by the rewrite.
   */
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
      // Compact is internal â€” use 'session' as the session ID placeholder.
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
   * Lock-free compaction body. The caller MUST already hold the index file
   * lock (via withFileLock(this.indexFile, ...)). Uses atomicWrite for the
   * rewrite so the temp file gets a random suffix (no collision between two
   * compactions) and the Windows transient-EPERM rename retry.
   */
  private async compactIndexInner(): Promise<void> {
    const entries = await this.readIndex();
    if (entries.length === 0) return;
    const lines = entries.map((s) => JSON.stringify(s)).join('\n') + '\n';
    await atomicWrite(this.indexFile, lines, { mode: 0o600 });
    this._indexCache = null;
  }

  /**
   * Read the index file and return deduplicated session summaries.
   * Entries with a matching tombstone are filtered out.
   * Returns empty array when the index doesn't exist or is corrupt.
   */
  private async readIndex(): Promise<readonly SessionSummary[]> {
    let stat: { mtimeMs: number; size: number; ino: number; birthtimeMs: number };
    try {
      const s = await fsp.stat(this.indexFile);
      stat = { mtimeMs: s.mtimeMs, size: s.size, ino: s.ino, birthtimeMs: s.birthtimeMs };
    } catch {
      this._indexCache = null;
      return [];
    }

    if (
      this._indexCache !== null &&
      this._indexCache.mtimeMs === stat.mtimeMs &&
      this._indexCache.size === stat.size &&
      this._indexCache.ino === stat.ino &&
      this._indexCache.birthtimeMs === stat.birthtimeMs
    ) {
      return this._indexCache.summaries;
    }

    const cached = this._indexCache;
    const sameFile =
      cached !== null && cached.ino === stat.ino && cached.birthtimeMs === stat.birthtimeMs;
    if (cached && sameFile && stat.size > cached.size) {
      const appended = await readFileRange(this.indexFile, cached.size, stat.size);
      if (appended !== null) {
        applySessionIndexLines(appended.raw, cached.byId, cached.deleted);
        const summaries = Array.from(cached.byId.values()).sort(compareSessionSummaries);
        this._indexCache = {
          ...stat,
          size: appended.end,
          summaries,
          byId: cached.byId,
          deleted: cached.deleted,
        };
        return summaries;
      }
    }

    let raw: string;
    try {
      raw = await fsp.readFile(this.indexFile, 'utf8');
    } catch {
      this._indexCache = null;
      return [];
    }
    const deleted = new Set<string>();
    const byId = new Map<string, SessionSummary>();
    applySessionIndexLines(raw, byId, deleted);
    const summaries = Array.from(byId.values());
    // Sort once when the index is (re)loaded so `list()` callers can
    // take a prefix without re-sorting the whole array per request.
    // Sort key mirrors the original `list()` comparator:
    //   startedAt DESC, then id ASC for tie-breaks.
    summaries.sort(compareSessionSummaries);
    this._indexCache = { ...stat, summaries, byId, deleted };
    return summaries;
  }

  /**
   * Rebuild the index from disk by scanning all sessions and writing a
   * fresh _index.jsonl. Useful after manual cleanup or index corruption.
   */
  async rebuildIndex(): Promise<number> {
    if (this.catalogClient) {
      const result = await this.catalogClient.call('rebuild_catalog', {}, { timeoutMs: 120_000 });
      return result.indexed;
    }
    const ids = await this.collectSessionIds(this.dir);
    /* v8 ignore next -- summaryFor() never rejects for a collected id (its .jsonl exists) */
    const summaries = await Promise.all(
      ids.map((id) => this.summaryFor(id).catch(() => null)),
    ); /* best-effort */
    const valid = summaries.filter((s): s is SessionSummary => s !== null);
    // Atomic rewrite under the index lock so it can't clobber a concurrent
    // append (or be clobbered by a concurrent compaction). atomicWrite gives
    // a random temp suffix (no collision with compactIndexInner's temp) and
    // the Windows transient-EPERM rename retry. The expensive disk scan above
    // runs OUTSIDE the lock to avoid holding it for the whole rebuild.
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
        // A failed/best-effort manifest write is still usable for this call,
        // but must not become an unverifiable in-memory cache entry.
        this.shardManifestCache.delete(shardKey);
      }
      return entry;
    });
  }

  /**
   * Shard manifests are invalidated by other store processes via atomic
   * delete/rebuild. Validate the in-memory projection against the persisted
   * file so one long-lived process cannot retain another process's stale view.
   */
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
      // Missing/replaced manifest invalidates the process-local projection.
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

  /** Recursively collect session IDs from date-shard subdirectories.
   *  IDs include the date-prefix path (e.g. "2026-06-06/17-46-57Z_â€¦").
   *  Skips `.jsonl`/`.summary.json` root files, dot-files, and
   *  sub-directories that belong to fleet/subagent sessions. */
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
      errorMsg = 'summary fallback â€” manifest rebuilt';
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

  /**
   * Delete a session and all associated files: JSONL, summary, plan/todos
   * sidecars, and the session directory (fleet.json, shared/, subagents/).
   *
   * Individual file deletions are best-effort (logged as structured warnings),
   * but a tombstone is always written so readIndex() filters this session out.
   * If the session directory itself can't be removed, the error is surfaced
   * to the caller so prune() can report it.
   */
  private async deleteSession(id: string): Promise<void> {
    const jsonlPath = this.sessionPath(id, '.jsonl');
    await deleteSessionArtifacts({ rootDir: this.dir, id, jsonlPath });

    // Write an index tombstone so readIndex() filters this session out.
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
    const trimmed = sessionContentText(this.secretScrubber.scrub(name));
    const manifest = this.sessionPath(id, '.summary.json');
    const jsonlPath = this.sessionPath(id, '.jsonl');
    // Refuse to name a session that has no JSONL on disk. `summaryFor`
    // would otherwise synthesize a '(damaged)' summary and persist it,
    // creating a phantom entry. ENOENT → throw a typed error so callers
    // can surface "session not found" cleanly.
    try {
      await fsp.stat(jsonlPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        throw new Error(`Session not found: ${id}`);
      }
      throw err;
    }

    const t0 = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    let errorMsg: string | undefined;
    let updated: SessionSummary;
    try {
      updated = await withFileLock(manifest, async () => {
        const summary = (await this.readSummaryManifest(id)) ?? (await this.summaryFor(id));
        const { name: _drop, ...rest } = summary;
        const next: SessionSummary = trimmed ? { ...rest, name: trimmed } : rest;
        await atomicWrite(manifest, JSON.stringify(next), { mode: 0o600 });
        try {
          await this.appendToIndexStrict(next);
        } catch (err) {
          // Keep the sidecar and index in agreement when the index append fails.
          await atomicWrite(manifest, JSON.stringify(summary), { mode: 0o600 });
          throw err;
        }
        return next;
      });
    } catch (err) {
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
      emitSessionStoreError(this.events, id, manifest, 'rename', errorMsg, false);
      throw err;
    } finally {
      emitSessionStoreWrite(
        this.events,
        id,
        manifest,
        'rename',
        outcome,
        Date.now() - t0,
        undefined,
        errorMsg,
      );
    }

    // appendToIndexStrict() already invalidated the index and both shard
    // manifest caches while persisting the same updated summary.
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
      // Compact the index to remove tombstones for deleted sessions.
      /* v8 ignore next -- best-effort: compactIndex swallows its own errors */
      await this.compactIndex().catch(() => undefined); /* best-effort */
    }
    return deleted;
  }

  async clearHistory(id: string): Promise<void> {
    const canonical = this.catalogClient ? await this.resolveId(id) : id;
    const maintenance = this.catalogClient
      ? await this.catalogClient.call('acquire_maintenance', {
          sessionId: canonical,
          operation: 'clear',
          holderId: this.maintenanceHolderId,
          // The catalog store runs inside the detached project daemon; without
          // our pid it cannot tell "this TUI clearing its own session" from
          // "another running wstack" and refuses every /clear as `is live`.
          holderPid: process.pid,
        })
      : undefined;
    await this.ensureShardDir(canonical);
    const file = this.sessionPath(canonical, '.jsonl');
    const meta = this.sessionPath(canonical, '.summary.json');
    const backupSuffix = maintenance ? `.${maintenance.leaseId}.clear-backup` : undefined;
    const fileBackup = backupSuffix ? `${file}${backupSuffix}` : undefined;
    const metaBackup = backupSuffix ? `${meta}${backupSuffix}` : undefined;
    let fileStaged = false;
    let metaStaged = false;
    const record = `${JSON.stringify({
      type: 'session_start',
      ts: new Date().toISOString(),
      id: canonical,
      model: 'unknown',
      provider: 'unknown',
    })}\n`;
    try {
      if (fileBackup) {
        try {
          await fsp.rename(file, fileBackup);
          fileStaged = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (metaBackup) {
        try {
          await fsp.rename(meta, metaBackup);
          metaStaged = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await atomicWrite(file, record);
      if (!metaBackup) await fsp.unlink(meta).catch(() => undefined);
      if (this.catalogClient) {
        const now = new Date().toISOString();
        await this.catalogClient.call('upsert_summary', {
          summary: {
            id: canonical,
            title: '',
            startedAt: now,
            model: 'unknown',
            provider: 'unknown',
            tokenTotal: 0,
            lastActivityAt: now,
          },
          transcriptRelativePath: `${canonical}.jsonl`,
          summaryRelativePath: `${canonical}.summary.json`,
        });
      }
      if (fileStaged && fileBackup) await fsp.unlink(fileBackup).catch(() => undefined);
      if (metaStaged && metaBackup) await fsp.unlink(metaBackup).catch(() => undefined);
    } catch (error) {
      if (fileStaged && fileBackup) {
        await fsp.unlink(file).catch(() => undefined);
        await fsp.rename(fileBackup, file).catch(() => undefined);
      }
      if (metaStaged && metaBackup) {
        await fsp.unlink(meta).catch(() => undefined);
        await fsp.rename(metaBackup, meta).catch(() => undefined);
      }
      throw error;
    } finally {
      if (maintenance && this.catalogClient) {
        await this.catalogClient
          .call('release_maintenance', { lease: maintenance })
          .catch(() => undefined);
      }
    }
    // Invalidate the parsed-session cache so the cleared `SessionData`
    // graph cannot survive in `SessionLoadCache` (50 entries / 64 MiB).
    // Without this, a `replaceMessages([])` on a previous hot session can
    // keep an unbounded body graph reachable for the process lifetime.
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

/**
 * Open an existing transcript for append without letting a crash-torn final
 * record absorb the first event of the resumed run. A valid final JSON record
 * without a newline is preserved; a partial record is isolated as its own
 * malformed line, which the tolerant reader already skips.
 */
async function openSessionForAppend(file: string): Promise<fsp.FileHandle> {
  const handle = await fsp.open(file, 'a+', 0o600);
  try {
    const stat = await handle.stat();
    if (stat.size > 0) {
      const tail = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(tail, 0, 1, stat.size - 1);
      if (bytesRead === 1 && tail[0] !== 0x0a) {
        await handle.appendFile('\n', 'utf8');
      }
    }
    return handle;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

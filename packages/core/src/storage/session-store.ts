import { createReadStream, type Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { EventBus } from '../kernel/events.js';
import type { ContentBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type {
  ResumedSession,
  SessionData,
  SessionEvent,
  SessionMetadata,
  SessionStore,
  SessionSummary,
  SessionWriter,
} from '../types/session.js';
import { atomicWrite, ensureDir } from '../utils/atomic-write.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import { toErrorMessage } from '../utils/index.js';
import { sessionScopedPath } from '../utils/session-scoped-path.js';
import { FileSessionWriter } from './file-session-writer.js';
import { userInputTitle } from './session-helpers.js';
import { generateSessionId } from './session-id.js';
import { compareSessionSummaries, matchesSessionFilter } from './session-summary.js';
import { extractToolCallEnds } from './session-tool-call-ends.js';
import { mapWithConcurrency } from './storage-concurrency.js';

export interface SessionStoreOptions {
  dir: string;
  /** Optional EventBus for emitting session diagnostics. */
  events?: EventBus | undefined;
  /**
   * Optional secret scrubber. When set, `user_input` and `llm_response` event
   * content is scrubbed before being persisted to the JSONL log and the
   * summary sidecar â€” so a secret a user pastes or the model echoes does not
   * sit in cleartext on disk (and does not ride along in history cloud-sync).
   * Tool output is already scrubbed upstream by the executor; this closes the
   * conversation-turn gap (finding F-06).
   */
  secretScrubber?: SecretScrubber | undefined;
}

/**
 * Cache entry for load() â€” stores the parsed SessionData along with the
 * file's mtimeMs and size at the time of loading. On subsequent calls,
 * if the file's mtimeMs+size match, we return the cached data without
 * re-reading or re-parsing the JSONL.
 */
interface LoadCacheEntry {
  mtimeMs: number;
  size: number;
  data: SessionData;
}

interface IndexCacheEntry {
  mtimeMs: number;
  size: number;
  summaries: SessionSummary[];
}

interface SessionFileRef {
  id: string;
  filePath: string;
}

interface DirectorySummaryCandidate {
  summary: SessionSummary;
  needsBackfill: boolean;
}

interface ShardManifestEntry {
  summaries: SessionSummary[];
  ids: string[];
}

export class DefaultSessionStore implements SessionStore {
  private readonly dir: string;
  private readonly events?: EventBus | undefined;
  private readonly secretScrubber?: SecretScrubber | undefined;

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
  private readonly _loadCache = new Map<string, LoadCacheEntry>();
  private _indexCache: IndexCacheEntry | null = null;
  private readonly shardManifestCache = new Map<string, ShardManifestEntry>();
  private static readonly LOAD_CACHE_MAX_ENTRIES = 50;
  private static readonly LIST_SCAN_CONCURRENCY = 32;

  constructor(opts: SessionStoreOptions) {
    this.dir = opts.dir;
    this.events = opts.events;
    this.secretScrubber = opts.secretScrubber;
  }

  /**
   * Clear the load() cache. Useful for testing or when the caller knows
   * the file has changed externally (e.g., another process wrote to it).
   */
  clearLoadCache(sessionId?: string): void {
    if (sessionId !== undefined) {
      this._loadCache.delete(sessionId);
    } else {
      this._loadCache.clear();
    }
  }

  // â”€â”€ Storage event helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private emitRead(
    sessionId: string,
    filePath: string,
    operation: 'load' | 'load_events_only' | 'list' | 'summary' | 'index_read',
    outcome: 'success' | 'failure',
    durationMs: number,
    error?: string,
  ): void {
    this.events?.emit('storage.read', {
      sessionId,
      store: 'session',
      filePath,
      operation,
      outcome,
      durationMs,
      ...(error !== undefined ? { error } : {}),
    });
  }

  private emitWrite(
    sessionId: string,
    filePath: string,
    operation: 'create' | 'resume' | 'append' | 'flush' | 'close' | 'index_append' | 'compact' | 'checkpoint',
    outcome: 'success' | 'failure',
    durationMs: number,
    eventCount?: number,
    error?: string,
  ): void {
    this.events?.emit('storage.write', {
      sessionId,
      store: 'session',
      filePath,
      operation,
      outcome,
      durationMs,
      ...(eventCount !== undefined ? { eventCount } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }

  private emitError(
    sessionId: string,
    filePath: string,
    operation: string,
    error: string,
    recoverable: boolean,
  ): void {
    this.events?.emit('storage.error', {
      sessionId,
      store: 'session',
      filePath,
      operation,
      error,
      recoverable,
    });
  }

  /** Absolute path to the session index file. */
  private get indexFile(): string {
    return path.join(this.dir, '_index.jsonl');
  }

  /** Join session ID to its absolute path within the store directory. */
  private sessionPath(id: string, ext: '.jsonl' | '.summary.json'): string {
    return sessionScopedPath(this.dir, id, ext);
  }

  private shardManifestPath(shardKey: string): string {
    return shardKey ? path.join(this.dir, shardKey, '_manifest.json') : path.join(this.dir, '_manifest.json');
  }

  private shardKeyForSessionId(id: string): string {
    const dirName = path.dirname(id);
    return dirName === '.' ? '' : dirName;
  }

  private invalidateShardManifestBySessionId(id: string): void {
    this.shardManifestCache.delete(this.shardKeyForSessionId(id));
  }

  /**
   * Ensure the directory implied by the session ID exists. When the ID
   * contains a date prefix like `2026-06-06/...`, this creates the date
   * subdirectory so sessions group naturally by day.
   */
  private async ensureShardDir(id: string): Promise<string> {
    const dirPath = path.dirname(sessionScopedPath(this.dir, id, ''));
    await ensureDir(dirPath);
    return dirPath;
  }

  async create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter> {
    const startedAt = new Date().toISOString();
    const id =
      meta.id && meta.id.length > 0
        ? meta.id
        : generateSessionId(startedAt);
    const shardDir = await this.ensureShardDir(id);
    const file = this.sessionPath(id, '.jsonl');
    const t0 = Date.now();
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(file, 'a', 0o600);
    } catch (err) {
      this.emitError(id, file, 'create', toErrorMessage(err), false);
      throw new Error(
        `Failed to open session file: ${toErrorMessage(err)}`,
        { cause: err },
      );
    }
    try {
      const writer = new FileSessionWriter(id, handle, startedAt, meta, this.events, {
        dir: shardDir,
        filePath: file,
        secretScrubber: this.secretScrubber,
        onClose: (s) => this.appendToIndex(s),
      });
      this.emitWrite(id, file, 'create', 'success', Date.now() - t0);
      return writer;
      /* v8 ignore start -- defensive: FileSessionWriter ctor does not throw in practice */
    } catch (err) {
      await handle.close().catch((e) => console.warn(JSON.stringify({
        level: 'warn',
        event: 'session_store.handle_close_failed',
        message: e instanceof Error ? e.message : String(e),
        timestamp: new Date().toISOString(),
      })));
      this.emitError(id, file, 'create', toErrorMessage(err), true);
      throw err;
    }
    /* v8 ignore stop */
  }

  async resume(id: string): Promise<ResumedSession> {
    const file = this.sessionPath(id, '.jsonl');
    const t0 = Date.now();
    const data = await this.load(id);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(file, 'a', 0o600);
      /* v8 ignore start -- defensive: load() above already validated the file is readable */
    } catch (err) {
      this.emitError(id, file, 'resume', toErrorMessage(err), false);
      throw new Error(
        `Failed to open session "${id}" for append: ${toErrorMessage(err)}`,
        { cause: err },
      );
    }
    /* v8 ignore stop */
    try {
      const writer = new FileSessionWriter(
        id,
        handle,
        new Date().toISOString(),
        {
          id,
          model: data.metadata.model,
          provider: data.metadata.provider,
        },
        this.events,
        {
          resumed: true,
          // Shard directory (sessions/<date>/) â€” must match create() so the
          // .summary.json sidecar lands next to the JSONL instead of the
          // sessions root (where summaryFor() would never find it).
          dir: path.dirname(file),
          filePath: file,
          secretScrubber: this.secretScrubber,
          onClose: (s) => this.appendToIndex(s),
        },
      );
      this.emitWrite(id, file, 'resume', 'success', Date.now() - t0);
      return { writer, data };
      /* v8 ignore start -- defensive: FileSessionWriter ctor does not throw in practice */
    } catch (err) {
      await handle.close().catch((e) => console.warn(JSON.stringify({
        level: 'warn',
        event: 'session_store.handle_close_failed',
        message: e instanceof Error ? e.message : String(e),
        timestamp: new Date().toISOString(),
      })));
      this.emitError(id, file, 'resume', toErrorMessage(err), true);
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
      const cached = this._loadCache.get(id);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        cacheHit = true;
        // Update insertion order to prevent frequent-access sessions from being
        // evicted by the LRU eviction logic.
        this._loadCache.delete(id);
        this._loadCache.set(id, cached);
        if (mode.full) return cached.data;
        return { ...cached.data, messages: [] };
      }

      // Cache miss â€” do the full read + parse.
      // Fused single pass: parse events + build messages + extract metadata together.
      // Streams the file line-by-line so we don't materialize the whole JSONL
      // (multi-MB for long sessions). Events-only requests skip the message
      // build and the adjacency repair entirely.
      const events: SessionEvent[] = [];

      // Metadata extracted in the same single pass over the raw lines.
      let sessionStartEvent: SessionEvent | undefined;
      let sessionEndEvent: SessionEvent | undefined;
      let sessionModel: string | undefined;
      let sessionProvider: string | undefined;
      let sessionPendingToolUses: string[] | undefined;

      // Message builder state — only allocated when mode.full.
      const messages: Message[] | undefined = mode.full ? [] : undefined;
      const openToolUses: Set<string> | undefined = mode.full ? new Set<string>() : undefined;
      let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

      const stream = createReadStream(file, { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      try {
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const parsed: unknown = JSON.parse(line);
            if (
              parsed !== null &&
              typeof parsed === 'object' &&
              typeof (parsed as { type?: unknown | undefined }).type === 'string' &&
              typeof (parsed as { ts?: unknown | undefined }).ts === 'string'
            ) {
              const ev = parsed as SessionEvent;
              events.push(ev);

              // Track metadata in the same pass.
              if (ev.type === 'session_start' && !sessionStartEvent) {
                sessionStartEvent = ev;
                sessionModel = ev.model;
                sessionProvider = ev.provider;
              }
              if (ev.type === 'session_end') {
                sessionEndEvent = ev;
                sessionPendingToolUses = ev.pendingToolUses;
              }

              // Build messages in the same pass (replay() logic inlined).
              // Skipped entirely when mode.full is false.
              if (mode.full && messages !== undefined && openToolUses !== undefined) {
                if (ev.type === 'user_input') {
                  openToolUses.clear();
                  messages.push({ role: 'user', content: ev.content, ts: ev.ts });
                } else if (ev.type === 'llm_response') {
                  messages.push({ role: 'assistant', content: ev.content, ts: ev.ts });
                  for (const b of ev.content) {
                    if (b.type === 'tool_use') openToolUses.add(b.id);
                  }
                  usage = {
                    input: usage.input + (ev.usage.input ?? 0),
                    output: usage.output + (ev.usage.output ?? 0),
                    cacheRead: (usage.cacheRead ?? 0) + (ev.usage.cacheRead ?? 0),
                    cacheWrite: (usage.cacheWrite ?? 0) + (ev.usage.cacheWrite ?? 0),
                  };
                } else if (ev.type === 'tool_result') {
                  if (!openToolUses.has(ev.id)) {
                    this.events?.emit('session.damaged', {
                      sessionId: id,
                      detail: `Orphan tool_result "${ev.id}" has no matching tool_use`,
                    });
                    continue;
                  }
                  openToolUses.delete(ev.id);
                  const resultBlock: ContentBlock = {
                    type: 'tool_result',
                    tool_use_id: ev.id,
                    content: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
                    is_error: ev.isError,
                  };
                  const last = messages[messages.length - 1];
                  const lastIsToolResultUser =
                    last?.role === 'user' &&
                    Array.isArray(last.content) &&
                    last.content.every((b) => (b as ContentBlock).type === 'tool_result');
                  if (lastIsToolResultUser && Array.isArray(last.content)) {
                    last.content.push(resultBlock);
                  } else {
                    messages.push({ role: 'user', content: [resultBlock], ts: ev.ts });
                  }
                }
              } else if (ev.type === 'llm_response') {
                // events-only path still accumulates usage.
                usage = {
                  input: usage.input + (ev.usage.input ?? 0),
                  output: usage.output + (ev.usage.output ?? 0),
                  cacheRead: (usage.cacheRead ?? 0) + (ev.usage.cacheRead ?? 0),
                  cacheWrite: (usage.cacheWrite ?? 0) + (ev.usage.cacheWrite ?? 0),
                };
              }
            }
          } catch {
            // skip malformed JSON
          }
        }
      } finally {
        rl.close();
        stream.close();
      }

      let finalMessages: Message[] = [];
      if (mode.full && messages !== undefined && openToolUses !== undefined) {
        // Repair tool adjacency after the single parse + replay loop.
        if (openToolUses.size > 0) {
          this.events?.emit('session.damaged', {
            sessionId: id,
            detail: `${openToolUses.size} tool_use blocks without matching results - replay repaired`,
          });
        }
        const repaired = repairToolUseAdjacency(messages);
        if (repaired.report.changed) {
          this.events?.emit('session.damaged', {
            sessionId: id,
            detail:
              `Repaired replay adjacency: removed ${repaired.report.removedToolUses.length} tool_use, ` +
              `${repaired.report.removedToolResults.length} tool_result, ` +
              `${repaired.report.removedMessages} empty messages`,
          });
        }
        finalMessages = repaired.messages;
      }

      // Build metadata from the extracted session_start/end events.
      const meta: SessionMetadata = {
        id,
        startedAt: sessionStartEvent?.ts ?? new Date(0).toISOString(),
        endedAt: sessionEndEvent?.ts,
        model: sessionModel,
        provider: sessionProvider,
        pendingToolUses: sessionPendingToolUses,
      };

      // Extract tool_call_end events for TUI tool entry rendering on resume.
      const toolCallEnds = extractToolCallEnds(events);
      const data: SessionData = { metadata: meta, events, messages: finalMessages, usage, toolCallEnds };

      // Update the cache. Evict oldest entry if at capacity.
      // Only full loads populate the cache; events-only loads always read
      // through (they're cheap, and a hot loop on events-only would
      // otherwise evict full-load entries that callers also need).
      if (mode.full) {
        if (this._loadCache.size >= DefaultSessionStore.LOAD_CACHE_MAX_ENTRIES) {
        // Map iteration order is insertion order â€” delete the first key.
        const oldest = this._loadCache.keys().next().value;
        if (oldest !== undefined) {
          this._loadCache.delete(oldest);
        }
      }
      this._loadCache.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, data });
      }

      return data;
    } catch (err) {
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
      throw err;
    } finally {
      this.emitRead(id, file, mode.full ? 'load' : 'load_events_only', outcome, Date.now() - t0, errorMsg);
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
    const file = this.sessionPath(id, '.jsonl');
    const limit = opts?.limit;
    const signal = opts?.signal;
    const out: Array<{ event: SessionEvent; eventIndex: number; ts: string }> = [];

    // Try to stat first so a missing file returns [] instead of throwing
    // — matches `load()` ENOENT semantics that callers already depend on.
    let stat: import('node:fs').Stats;
    try {
      stat = await fsp.stat(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    if (stat.size === 0) return [];

    let fh: fsp.FileHandle | undefined;
    try {
      fh = await fsp.open(file, 'r');
      // Read in 64KB chunks; lines can straddle a chunk boundary so we
      // carry the trailing partial line forward between iterations.
      const CHUNK = 64 * 1024;
      const buf = Buffer.alloc(CHUNK);
      let leftover = '';
      let eventIndex = 0;
      for (let position = 0; ; position += buf.byteLength) {
        if (signal?.aborted) {
          const reason = signal.reason ?? new DOMException('Aborted', 'AbortError');
          throw reason;
        }
        const { bytesRead } = await fh.read(buf, 0, CHUNK, position);
        if (bytesRead === 0) break;
        const text = leftover + buf.subarray(0, bytesRead).toString('utf8');
        // Split into lines; the last element is either '' (file ended on a
        // newline) or a partial line — keep it as the new leftover.
        const parts = text.split('\n');
        leftover = parts.pop() ?? '';
        for (const line of parts) {
          if (!line) continue;
          let ev: SessionEvent;
          try {
            const parsed: unknown = JSON.parse(line);
            if (
              parsed === null ||
              typeof parsed !== 'object' ||
              typeof (parsed as { type?: unknown }).type !== 'string' ||
              typeof (parsed as { ts?: unknown }).ts !== 'string'
            ) {
              // Skip lines that don't match the SessionEvent shape — same
              // tolerance as `load()` (which silently drops non-events).
              continue;
            }
            ev = parsed as SessionEvent;
          } catch {
            // Skip malformed JSON, matching `load()` behavior.
            continue;
          }
          if (predicate(ev, eventIndex, ev.ts)) {
            out.push({ event: ev, eventIndex, ts: ev.ts });
            if (limit !== undefined && out.length >= limit) {
              return out;
            }
          }
          eventIndex++;
        }
      }
      // Flush a trailing line that lacks a final newline.
      if (leftover.trim()) {
        try {
          const parsed: unknown = JSON.parse(leftover);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            typeof (parsed as { type?: unknown }).type === 'string' &&
            typeof (parsed as { ts?: unknown }).ts === 'string'
          ) {
            const ev = parsed as SessionEvent;
            if (predicate(ev, eventIndex, ev.ts)) {
              out.push({ event: ev, eventIndex, ts: ev.ts });
            }
          }
        } catch {
          /* partial trailing line — drop */
        }
      }
      return out;
    } finally {
      if (fh) await fh.close().catch(() => undefined);
    }
  }

  async list(limit = 20): Promise<SessionSummary[]> {
    try {
      await ensureDir(this.dir);
      // Try the index first; fall back to directory scan if the index is
      // missing, empty, or unreadable.
      const indexed = await this.readIndex();
      if (indexed.length > 0) {
        // `readIndex()` already sorted the array by startedAt DESC, id
        // ASC, so we just slice the prefix.
        return indexed.slice(0, limit);
      }
      // Index unavailable — fall back to a directory scan. Prefer summary
      // sidecars and only backfill full JSONL-derived summaries for the page
      // we are about to return.
      return await this.listFromDirectoryScan(limit);
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
    try {
      await ensureDir(this.dir);
      const indexed = await this.readIndex();
      if (indexed.length === 0) {
        // No index — fall back to list() + in-process filter.
        const raw = await this.list(Math.max(limit, 100));
        return raw.filter((s) => matchesSessionFilter(s, criteria)).slice(0, limit);
      }
      const filtered = indexed.filter((s) => matchesSessionFilter(s, criteria));
      filtered.sort((a, b) => {
        if (a.startedAt < b.startedAt) return 1;
        if (a.startedAt > b.startedAt) return -1;
        return a.id.localeCompare(b.id);
      });
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

  /** Append a session summary to the index. */
  private async appendToIndex(summary: SessionSummary): Promise<void> {
    // Note: storage.write for this operation is emitted by FileSessionWriter.doClose()
    // so it can include the traceId. Do NOT emit here to avoid duplicates.
    try {
      await ensureDir(this.dir);
      const line = JSON.stringify(summary) + '\n';
      await fsp.appendFile(this.indexFile, line, 'utf8');
      this._indexCache = null;
      this.invalidateShardManifestBySessionId(summary.id);
      this.indexAppendCount++;
      // Auto-compact the index periodically to remove tombstones and duplicates.
      if (this.indexAppendCount >= DefaultSessionStore.COMPACT_EVERY) {
        await this.compactIndex();
        this.indexAppendCount = 0;
      }
    } catch {
      // best-effort â€” error surfaced via the storage.write event in doClose()
    }
  }

  /** Append a tombstone entry for a deleted session. */
  private async writeTombstone(id: string): Promise<void> {
    try {
      await ensureDir(this.dir);
      const line = JSON.stringify({ action: 'delete', id }) + '\n';
      await fsp.appendFile(this.indexFile, line, 'utf8');
      this._indexCache = null;
      this.invalidateShardManifestBySessionId(id);
      this.indexAppendCount++;
    } catch {
      // best-effort
    }
  }

  /**
   * Compact the index: read all entries, drop tombstones, deduplicate
   * (keep latest per session), and rewrite. Atomic via temp+rename.
   */
  private async compactIndex(): Promise<void> {
    const t0 = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    let errorMsg: string | undefined;
    try {
      const entries = await this.readIndex();
      if (entries.length === 0) return;
      const tmp = `${this.indexFile}.compact.tmp`;
      const lines = entries.map((s) => JSON.stringify(s)).join('\n') + '\n';
      await fsp.writeFile(tmp, lines, 'utf8');
      await fsp.rename(tmp, this.indexFile);
      this._indexCache = null;
    } catch (err) {
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
    } finally {
      // Compact is internal â€” use 'session' as the session ID placeholder.
      this.emitWrite('~compact~', this.indexFile, 'compact', outcome, Date.now() - t0, undefined, errorMsg);
    }
  }

  /**
   * Read the index file and return deduplicated session summaries.
   * Entries with a matching tombstone are filtered out.
   * Returns empty array when the index doesn't exist or is corrupt.
   */
  private async readIndex(): Promise<SessionSummary[]> {
    let stat: { mtimeMs: number; size: number };
    try {
      const s = await fsp.stat(this.indexFile);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      this._indexCache = null;
      return [];
    }

    if (
      this._indexCache !== null &&
      this._indexCache.mtimeMs === stat.mtimeMs &&
      this._indexCache.size === stat.size
    ) {
      return [...this._indexCache.summaries];
    }

    let raw: string;
    try {
      raw = await fsp.readFile(this.indexFile, 'utf8');
    } catch {
      this._indexCache = null;
      return [];
    }
    const deleted = new Set<string>();
    const seen = new Map<string, SessionSummary>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { action?: string | undefined; id?: string | undefined } & SessionSummary;
        if (entry.action === 'delete' && entry.id) {
          deleted.add(entry.id);
          seen.delete(entry.id);
          continue;
        }
        if (entry.id && !deleted.has(entry.id)) {
          // Keep the latest entry for each session (multiple appends on resume).
          seen.set(entry.id, entry as SessionSummary);
        }
      } catch {
        // skip corrupt lines
      }
    }
    const summaries = Array.from(seen.values());
    // Sort once when the index is (re)loaded so `list()` callers can
    // take a prefix without re-sorting the whole array per request.
    // Sort key mirrors the original `list()` comparator:
    //   startedAt DESC, then id ASC for tie-breaks.
    summaries.sort((a, b) => {
      if (a.startedAt < b.startedAt) return 1;
      if (a.startedAt > b.startedAt) return -1;
      return a.id.localeCompare(b.id);
    });
    this._indexCache = { ...stat, summaries };
    return [...summaries];
  }

  /**
   * Rebuild the index from disk by scanning all sessions and writing a
   * fresh _index.jsonl. Useful after manual cleanup or index corruption.
   */
  async rebuildIndex(): Promise<number> {
    const ids = await this.collectSessionIds(this.dir);
    /* v8 ignore next -- summaryFor() never rejects for a collected id (its .jsonl exists) */
    const summaries = await Promise.all(ids.map((id) => this.summaryFor(id).catch(() => null))); /* best-effort */
    const valid = summaries.filter((s): s is SessionSummary => s !== null);
    // Atomic rewrite: write to temp, then rename.
    const tmp = `${this.indexFile}.tmp`;
    const lines = valid.map((s) => JSON.stringify(s)).join('\n') + '\n';
    await fsp.writeFile(tmp, lines, 'utf8');
    await fsp.rename(tmp, this.indexFile);
    this._indexCache = null;
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
      if (entry.name.startsWith('.') && entry.name !== '.wrongstack') continue;
      if (entry.name === 'shared' || entry.name === 'subagents' || entry.name === 'attachments') continue;
      if (entry.isDirectory()) shardKeys.push(entry.name);
    }
    return shardKeys;
  }

  private async readOrBuildShardManifest(shardKey: string): Promise<ShardManifestEntry> {
    const cached = this.shardManifestCache.get(shardKey);
    if (cached) return cached;

    const manifestPath = this.shardManifestPath(shardKey);
    try {
      const raw = await fsp.readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as ShardManifestEntry;
      const entry: ShardManifestEntry = {
        summaries: Array.isArray(parsed.summaries) ? parsed.summaries : [],
        ids: Array.isArray(parsed.ids) ? parsed.ids : [],
      };
      this.shardManifestCache.set(shardKey, entry);
      return entry;
    } catch {
      // build below
    }

    const refs = await this.collectSessionFilesInShard(shardKey);
    const candidates = await mapWithConcurrency(
      refs,
      DefaultSessionStore.LIST_SCAN_CONCURRENCY,
      async (ref): Promise<DirectorySummaryCandidate | null> => {
        const manifest = await this.readSummaryManifest(ref.id);
        if (manifest) return { summary: manifest, needsBackfill: false };
        const summary = await this.summaryHeaderFor(ref);
        if (!summary) return null;
        const hydrated = await this.summaryFor(summary.id).catch(() => summary);
        return { summary: hydrated, needsBackfill: false };
      },
    );
    const summaries = candidates
      .filter((candidate): candidate is DirectorySummaryCandidate => candidate !== null)
      .map((candidate) => candidate.summary);
    summaries.sort(compareSessionSummaries);
    const entry: ShardManifestEntry = { summaries, ids: summaries.map((summary) => summary.id) };
    this.shardManifestCache.set(shardKey, entry);
    await atomicWrite(manifestPath, JSON.stringify(entry), { mode: 0o600 }).catch(() => undefined);
    return entry;
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
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const dirEntries: Dirent[] = [];
    const files: SessionFileRef[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.wrongstack') continue;
      if (entry.name === 'shared' || entry.name === 'subagents' || entry.name === 'attachments')
        continue;
      if (entry.isDirectory()) {
        dirEntries.push(entry);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (entry.name === '_index.jsonl') continue;
        const base = entry.name.replace(/\.jsonl$/, '');
        const id = prefix ? `${prefix}/${base}` : base;
        files.push({ id, filePath: path.join(dir, entry.name) });
      }
    }

    const childFileArrays = await Promise.all(
      dirEntries.map((entry) => {
        const childPrefix = depth === 0 ? entry.name : `${prefix}/${entry.name}`;
        return this.collectSessionFiles(path.join(dir, entry.name), childPrefix, depth + 1);
      }),
    );

    return [...childFileArrays.flat(), ...files];
  }

  /** Recursively collect session IDs from date-shard subdirectories.
   *  IDs include the date-prefix path (e.g. "2026-06-06/17-46-57Z_â€¦").
   *  Skips `.jsonl`/`.summary.json` root files, dot-files, and
   *  sub-directories that belong to fleet/subagent sessions. */
  private async collectSessionIds(
    dir: string,
    prefix = '',
    depth = 0,
  ): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    // Separate dirs and files in one pass â€” avoids a second iteration.
    const dirEntries: Dirent[] = [];
    const fileIds: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.wrongstack') continue;
      if (entry.name === 'shared' || entry.name === 'subagents' || entry.name === 'attachments')
        continue;
      if (entry.isDirectory()) {
        dirEntries.push(entry);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (entry.name === '_index.jsonl') continue;
        const base = entry.name.replace(/\.jsonl$/, '');
        fileIds.push(prefix ? `${prefix}/${base}` : base);
      }
    }

    // At depth 0 the date-shard directories are independent â€” parallelize across
    // them. Deeper recursion (intra-shard) is sequential since shards are small.
    const childIdArrays = await Promise.all(
      dirEntries.map((entry) => {
        const childPrefix = depth === 0 ? entry.name : `${prefix}/${entry.name}`;
        return this.collectSessionIds(path.join(dir, entry.name), childPrefix, depth + 1);
      }),
    );

    return [...childIdArrays.flat(), ...fileIds];
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
        this.emitError(id, manifest, 'summary_fallback', msg, true);
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'session_store.manifest_write_failed',
          sessionId: id,
          message: msg,
          timestamp: new Date().toISOString(),
        }));
      });
      outcome = 'failure';
      errorMsg = 'summary fallback â€” manifest rebuilt';
      this.emitRead(id, manifest, 'summary', outcome, Date.now() - t0, errorMsg);
      return summary;
    } catch (err) {
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
      this.emitRead(id, manifest, 'summary', outcome, Date.now() - t0, errorMsg);
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
      this.emitRead(id, manifest, 'summary', 'success', Date.now() - startTime);
      return JSON.parse(raw) as SessionSummary;
    } catch {
      return null;
    }
  }

  private async summaryHeaderFor(ref: SessionFileRef): Promise<SessionSummary | null> {
    let mtime = new Date(0).toISOString();
    try {
      const stat = await fsp.stat(ref.filePath);
      if (!stat.isFile()) {
        return {
          id: ref.id,
          title: '(damaged)',
          startedAt: stat.mtime.toISOString(),
          model: 'unknown',
          provider: 'unknown',
          tokenTotal: 0,
        };
      }
      mtime = stat.mtime.toISOString();
    } catch {
      return null;
    }

    try {
      for await (const event of this.iterSessionEvents(ref.filePath)) {
        if (event.type === 'session_start') {
          return {
            id: ref.id,
            title: '(empty session)',
            startedAt: event.ts,
            model: event.model ?? 'unknown',
            provider: event.provider ?? 'unknown',
            tokenTotal: 0,
          };
        }
      }
      return {
        id: ref.id,
        title: '(empty session)',
        startedAt: new Date(0).toISOString(),
        model: 'unknown',
        provider: 'unknown',
        tokenTotal: 0,
      };
    } catch {
      return {
        id: ref.id,
        title: '(damaged)',
        startedAt: mtime,
        model: 'unknown',
        provider: 'unknown',
        tokenTotal: 0,
      };
    }
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
    const summaryPath = this.sessionPath(id, '.summary.json');
    const shardDir = path.dirname(jsonlPath);
    const base = path.basename(id);
    const sessDir = path.join(shardDir, base);

    const deletions: Array<Promise<void>> = [
      fsp.unlink(jsonlPath),
      fsp.unlink(summaryPath),
      fsp.unlink(sessionScopedPath(this.dir, id, '.plan.json')),
      fsp.unlink(sessionScopedPath(this.dir, id, '.tasks.json')),
      fsp.unlink(sessionScopedPath(this.dir, id, '.todos.json')),
    ];

    const results = await Promise.allSettled(deletions);
    for (const r of results) {
      if (r.status === 'rejected') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        // ENOENT is expected (file may not exist â€” sidecars are optional).
        if ((r.reason as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.warn(JSON.stringify({
            level: 'warn',
            event: 'session_store.delete_failed',
            sessionId: id,
            message: msg,
            timestamp: new Date().toISOString(),
          }));
        }
      }
    }

    // Remove the session directory (may contain fleet.json, shared/, subagents/).
    /* v8 ignore start -- defensive: rm with force:true rarely rejects */
    await fsp.rm(sessDir, { recursive: true, force: true }).catch((err) => {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'session_store.rmdir_failed',
        sessionId: id,
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }));
    });
    /* v8 ignore stop */

    // Write an index tombstone so readIndex() filters this session out.
    await this.writeTombstone(id);
  }

  async delete(id: string): Promise<void> {
    await this.deleteSession(id);
  }

  async prune(maxAgeDays = 30): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let deleted = 0;

    // Read the active session lock to avoid pruning the current session.
    let activeSessionId: string | null = null;
    try {
      const raw = await fsp.readFile(path.join(this.dir, 'active.json'), 'utf8');
      const active = JSON.parse(raw) as { sessionId?: string | undefined };
      activeSessionId = active.sessionId ?? null;
    } catch {
      // no active.json â€” nothing to protect
    }

    const isPrunableJsonl = (name: string): boolean =>
      name.endsWith('.jsonl') &&
      name !== '_index.jsonl' &&
      name !== '_mailbox.jsonl' &&
      !name.endsWith('.replay.jsonl') &&
      !name.endsWith('.audit.jsonl');

    const pruneFile = async (dir: string, name: string, prefix: string): Promise<void> => {
      const jsonlPath = path.join(dir, name);
      try {
        const stat = await fsp.stat(jsonlPath);
        if (stat.mtimeMs >= cutoff) return;
        /* v8 ignore start -- defensive: file vanished between readdir and stat */
      } catch {
        return;
      }
      /* v8 ignore stop */
      const base = name.replace(/\.jsonl$/, '');
      const id = prefix ? `${prefix}/${base}` : base;
      // Never prune the currently active session.
      if (activeSessionId && id === activeSessionId) return;
      await this.deleteSession(id);
      deleted++;
    };

    /* v8 ignore next -- defensive: store dir is ensured before prune runs */
    const entries = await fsp.readdir(this.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile()) {
        // Flat legacy sessions at the sessions root â€” pre-shard layout.
        // A shard-only scan left these accumulating forever.
        if (isPrunableJsonl(entry.name)) await pruneFile(this.dir, entry.name, '');
        continue;
      }
      /* v8 ignore next -- defensive: root entries are only files or directories */
      if (!entry.isDirectory()) continue;
      // entry.name is a date-shard like "2026-06-06"
      const dateDir = path.join(this.dir, entry.name);
      /* v8 ignore next -- defensive: dateDir came from readdir and is readable */
      const files = await fsp.readdir(dateDir, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !isPrunableJsonl(file.name)) continue;
        await pruneFile(dateDir, file.name, entry.name);
      }
    }
    if (deleted > 0) {
      // Compact the index to remove tombstones for deleted sessions.
      /* v8 ignore next -- best-effort: compactIndex swallows its own errors */
      await this.compactIndex().catch(() => undefined); /* best-effort */
    }
    // Clean up empty date-shard directories left behind after pruning.
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dateDir = path.join(this.dir, entry.name);
      try {
        const remaining = await fsp.readdir(dateDir);
        if (remaining.length === 0) {
          /* v8 ignore next -- best-effort: rmdir of a confirmed-empty dir does not reject */
          await fsp.rmdir(dateDir).catch(() => undefined);
        }
      } catch {
        // best-effort
      }
    }
    return deleted;
  }

  async clearHistory(id: string): Promise<void> {
    await this.ensureShardDir(id);
    const file = this.sessionPath(id, '.jsonl');
    const meta = this.sessionPath(id, '.summary.json');
    const record = `${JSON.stringify({
      type: 'session_start',
      ts: new Date().toISOString(),
      id,
      model: 'unknown',
      provider: 'unknown',
    })}\n`;
    await fsp.writeFile(file, record, 'utf8');
    await fsp.unlink(meta).catch(() => undefined);
  }

  private async summarize(id: string, mtime: string): Promise<SessionSummary> {
    try {
      const file = this.sessionPath(id, '.jsonl');
      let title = '(empty session)';
      let startedAt = new Date(0).toISOString();
      let endedAt: string | undefined;
      let model = 'unknown';
      let provider = 'unknown';
      let tokenIn = 0;
      let tokenOut = 0;
      let iterationCount = 0;
      let toolCallCount = 0;
      let toolErrorCount = 0;
      let fileChangeCount = 0;
      const toolBreakdown: Record<string, number> = {};
      let outcome: SessionSummary['outcome'] ;
      let lastEventType: SessionEvent['type'] | undefined;
      let hasError = false;
      let sawStart = false;

      for await (const e of this.iterSessionEvents(file)) {
        lastEventType = e.type;
        if (e.type === 'session_start') {
          if (!sawStart) {
            sawStart = true;
            startedAt = e.ts;
            model = e.model ?? 'unknown';
            provider = e.provider ?? 'unknown';
          }
        } else if (e.type === 'session_end') {
          endedAt = e.ts;
        } else if (e.type === 'user_input') {
          if (title === '(empty session)') title = userInputTitle(e.content);
        } else if (e.type === 'llm_response') {
          tokenIn += e.usage.input ?? 0;
          tokenOut += e.usage.output ?? 0;
        } else if (e.type === 'in_flight_start') iterationCount++;
        else if (e.type === 'tool_call_start') {
          toolCallCount++;
          toolBreakdown[e.name] = (toolBreakdown[e.name] ?? 0) + 1;
        } else if (e.type === 'tool_result' && e.isError) toolErrorCount++;
        else if (e.type === 'file_snapshot') fileChangeCount += e.files.length;
        else if (e.type === 'error' || e.type === 'provider_error') hasError = true;
      }

      // Determine outcome from the last event.
      if (lastEventType === 'session_end') {
        outcome = 'completed';
      } else if (lastEventType === 'in_flight_start') {
        outcome = 'aborted';
      } else if (hasError) {
        outcome = 'error';
      }

      return {
        id,
        title,
        startedAt,
        endedAt,
        model,
        provider,
        tokenTotal: tokenIn + tokenOut,
        iterationCount: iterationCount > 0 ? iterationCount : undefined,
        toolCallCount: toolCallCount > 0 ? toolCallCount : undefined,
        toolErrorCount: toolErrorCount > 0 ? toolErrorCount : undefined,
        fileChangeCount: fileChangeCount > 0 ? fileChangeCount : undefined,
        toolBreakdown: Object.keys(toolBreakdown).length > 0 ? toolBreakdown : {},
        outcome,
      };
    } catch {
      return {
        id,
        title: '(damaged)',
        startedAt: mtime,
        model: 'unknown',
        provider: 'unknown',
        tokenTotal: 0,
      };
    }
  }

  private async *iterSessionEvents(file: string): AsyncGenerator<SessionEvent> {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            typeof (parsed as { type?: unknown | undefined }).type === 'string' &&
            typeof (parsed as { ts?: unknown | undefined }).ts === 'string'
          ) {
            yield parsed as SessionEvent;
          }
        } catch {
          // skip malformed JSON
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }


}

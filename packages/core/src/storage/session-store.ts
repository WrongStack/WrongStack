import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { EventBus } from '../kernel/events.js';
import { DefaultSecretScrubber } from '../security/secret-scrubber.js';
import type { ContentBlock } from '../types/blocks.js';
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
  WorkspaceMaterializationResult,
} from '../types/session.js';
import { atomicWrite, ensureDir, withFileLock } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/index.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import { FileSessionWriter } from './file-session-writer.js';
import { SessionCheckpointCas } from './session-checkpoint-cas.js';
import { generateSessionId } from './session-id.js';
import {
  scrubPersistedSessionEvent,
  scrubPersistedSessionSummary,
} from './session-read-scrubber.js';
import {
  formatInterruptedToolNotice,
  formatResumeValidationNotice,
  validateResumeFileObservations,
} from './session-resume-validation.js';
import { applySessionIndexLines, readFileRange } from './session-store/index-reader.js';
import { shouldSkipSessionDirectoryEntry } from './session-store/directory-scan.js';
import {
  collectSessionFiles as collectSessionFilesFromDirectory,
  collectSessionIds as collectSessionIdsFromDirectory,
} from './session-store/directory-session-files.js';
import { deleteSessionArtifacts } from './session-store/delete-session-artifacts.js';
import { SessionLoadCache } from './session-store/load-cache.js';
import { isPrunableSessionJsonl, readActiveSessionId } from './session-store/prune-helpers.js';
import {
  emitSessionStoreError,
  emitSessionStoreRead,
  emitSessionStoreWrite,
} from './session-store/events.js';
import {
  applyContextSnapshot,
  inheritsIntoFork,
  replayableMessage,
  trackMessageToolState,
} from './session-store/replay.js';
import type {
  DirectorySummaryCandidate,
  IndexCacheEntry,
  SessionFileRef,
  SessionStoreOptions,
  ShardManifestEntry,
} from './session-store/types.js';
import {
  ensureShardDir as ensureSessionShardDir,
  sessionPath as sessionStorePath,
  shardKeyForSessionId,
  shardManifestPath,
} from './session-store/paths.js';
import { iterateSessionEvents, summarizeSessionFile } from './session-store/summary-builder.js';
import { compareSessionSummaries, matchesSessionFilter } from './session-summary.js';
import { extractToolCallEnds } from './session-tool-call-ends.js';
import { mapWithConcurrency } from './storage-concurrency.js';

export type { SessionStoreOptions } from './session-store/types.js';

export class DefaultSessionStore implements SessionStore {
  private readonly dir: string;
  private readonly events?: EventBus | undefined;
  private readonly secretScrubber: SecretScrubber;
  private readonly projectRoot?: string | undefined;
  private readonly checkpointCas?: SessionCheckpointCas | undefined;
  private readonly isSessionInUse?: ((sessionId: string) => Promise<string | null>) | undefined;
  private readonly logger: Logger | undefined;

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
  private readonly _loadCache = new Map<string, import('./session-store/types.js').LoadCacheEntry>();
  private readonly loadCache = new SessionLoadCache(this._loadCache);
  private _indexCache: IndexCacheEntry | null = null;
  private readonly shardManifestCache = new Map<string, ShardManifestEntry>();
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

  private invalidateShardManifestBySessionId(id: string): void {
    this.shardManifestCache.delete(this.shardKeyForSessionId(id));
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
        onClose: (s) => this.appendToIndex(s),
      });
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
    const parent = await this.load(id);
    let boundary = parent.events.length - 1;
    let targetCheckpoint: Extract<SessionEvent, { type: 'checkpoint' }> | undefined;
    if (opts.checkpointPromptIndex !== undefined) {
      boundary = -1;
      for (let i = 0; i < parent.events.length; i++) {
        const event = parent.events[i];
        if (event?.type === 'checkpoint' && event.promptIndex === opts.checkpointPromptIndex) {
          // Prefer the latest matching checkpoint if a legacy/non-truncated
          // journal reused prompt indices after a rewind.
          boundary = i;
          targetCheckpoint = event;
        }
      }
      if (boundary === -1) {
        throw new Error(`Checkpoint ${opts.checkpointPromptIndex} not found in session "${id}"`);
      }
    }

    const parentPrefix = parent.events.slice(0, boundary + 1);
    const workspaceCheckpoint = targetCheckpoint?.workspaceCheckpoint;
    const checkpointHash = createHash('sha256')
      .update(parentPrefix.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
      .digest('hex');
    const inherited = parentPrefix.filter(inheritsIntoFork);
    const writer = await this.create({
      id: '',
      title: parent.metadata.title,
      model: parent.metadata.model,
      provider: parent.metadata.provider,
    });

    try {
      await writer.append({
        type: 'session_forked',
        ts: new Date().toISOString(),
        parentSessionId: id,
        parentCheckpointPromptIndex: opts.checkpointPromptIndex,
        parentCheckpointHash: checkpointHash,
        workspace: 'shared-current',
        workspaceCheckpointHash: workspaceCheckpoint?.manifestHash,
      });
      const batchSize = 250;
      for (let offset = 0; offset < inherited.length; offset += batchSize) {
        await writer.appendBatch(inherited.slice(offset, offset + batchSize));
      }
      await writer.flush();
      await writer.close();
      const data = await this.load(writer.id);
      return {
        id: writer.id,
        data,
        parentSessionId: id,
        checkpointPromptIndex: opts.checkpointPromptIndex,
        checkpointHash,
        workspace: 'shared-current',
        workspaceCheckpoint,
      };
    } catch (err) {
      await writer.close().catch(() => undefined);
      await this.delete(writer.id).catch(() => undefined);
      throw err;
    }
  }

  async materializeWorkspaceCheckpoint(
    checkpoint: WorkspaceCheckpointRef,
    targetRoot: string,
  ): Promise<WorkspaceMaterializationResult> {
    if (!this.checkpointCas) {
      throw new Error(
        'Workspace checkpoint materialization requires a projectRoot-aware session store',
      );
    }
    return this.checkpointCas.materialize(checkpoint, targetRoot);
  }

  async resume(id: string): Promise<ResumedSession> {
    const file = this.sessionPath(id, '.jsonl');
    const t0 = Date.now();
    const data = await this.load(id);
    // Ephemeral system notices injected into the first resumed turn. Both are
    // informational only — neither re-executes any prior work.
    const noticeMessages: Message[] = [];
    let resumeValidation: import('../types/session.js').ResumeValidation | undefined;
    if (this.projectRoot) {
      try {
        resumeValidation = await validateResumeFileObservations(data.events, this.projectRoot);
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
          id,
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
    const resumedData: SessionData = {
      ...data,
      ...(resumeValidation ? { resumeValidation } : {}),
      ...(noticeMessages.length > 0 ? { messages: [...data.messages, ...noticeMessages] } : {}),
    };
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(file, 'a', 0o600);
      /* v8 ignore start -- defensive: load() above already validated the file is readable */
    } catch (err) {
      emitSessionStoreError(this.events, id, file, 'resume', toErrorMessage(err), false);
      throw new Error(`Failed to open session "${id}" for append: ${toErrorMessage(err)}`, {
        cause: err,
      });
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
          checkpointCas: this.checkpointCas,
          onClose: (s) => this.appendToIndex(s),
        },
      );
      emitSessionStoreWrite(this.events, id, file, 'resume', 'success', Date.now() - t0);
      return { writer, data: resumedData };
      /* v8 ignore start -- defensive: FileSessionWriter ctor does not throw in practice */
    } catch (err) {
      await handle.close().catch((e) =>
        this.logWarn('Session handle close failed', {
          event: 'session_store.handle_close_failed',
          message: e instanceof Error ? e.message : String(e),
        }),
      );
      emitSessionStoreError(this.events, id, file, 'resume', toErrorMessage(err), true);
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
      let sessionForkedEvent: Extract<SessionEvent, { type: 'session_forked' }> | undefined;

      // Message builder state — only allocated when mode.full.
      const messages: Message[] | undefined = mode.full ? [] : undefined;
      const openToolUses: Set<string> | undefined = mode.full ? new Set<string>() : undefined;
      // Once an exact message-journal event appears, it becomes authoritative.
      // Legacy turn events continue to supply usage/audit data but must not be
      // replayed a second time into the conversation.
      let exactJournalActive = false;
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
              const ev = scrubPersistedSessionEvent(parsed as SessionEvent, this.secretScrubber);
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
              if (ev.type === 'session_forked' && !sessionForkedEvent) {
                sessionForkedEvent = ev;
              }

              // Build messages in the same pass (replay() logic inlined).
              // Skipped entirely when mode.full is false.
              if (mode.full && messages !== undefined && openToolUses !== undefined) {
                if (ev.type === 'message_appended' && ev.version === 1) {
                  const message = replayableMessage(ev.message, ev.ts);
                  if (message) {
                    if (!exactJournalActive) {
                      messages.length = 0;
                      openToolUses.clear();
                      exactJournalActive = true;
                    }
                    messages.push(message);
                    trackMessageToolState(message, openToolUses);
                  } else {
                    this.events?.emit('session.damaged', {
                      sessionId: id,
                      detail: 'Ignored malformed message_appended event',
                    });
                  }
                } else if (ev.type === 'message_updated' && ev.version === 1) {
                  const message = replayableMessage(ev.message, ev.ts);
                  if (
                    message &&
                    exactJournalActive &&
                    ev.index >= 0 &&
                    ev.index < messages.length
                  ) {
                    messages[ev.index] = message;
                    openToolUses.clear();
                    for (const current of messages) trackMessageToolState(current, openToolUses);
                  } else {
                    this.events?.emit('session.damaged', {
                      sessionId: id,
                      detail: `Ignored malformed message_updated event at index ${ev.index}`,
                    });
                  }
                } else if (ev.type === 'messages_replaced' && ev.version === 1) {
                  if (applyContextSnapshot(messages, openToolUses, ev.messages)) {
                    exactJournalActive = true;
                  } else {
                    this.events?.emit('session.damaged', {
                      sessionId: id,
                      detail: 'Ignored malformed messages_replaced event',
                    });
                  }
                } else if (ev.type === 'context_snapshot') {
                  if (!applyContextSnapshot(messages, openToolUses, ev.messages)) {
                    this.events?.emit('session.damaged', {
                      sessionId: id,
                      detail: 'Ignored malformed context_snapshot event',
                    });
                  }
                } else if (!exactJournalActive && ev.type === 'user_input') {
                  openToolUses.clear();
                  messages.push({ role: 'user', content: ev.content, ts: ev.ts });
                } else if (ev.type === 'llm_response') {
                  if (!exactJournalActive) {
                    messages.push({ role: 'assistant', content: ev.content, ts: ev.ts });
                    for (const b of ev.content) {
                      if (b.type === 'tool_use') openToolUses.add(b.id);
                    }
                  }
                  usage = {
                    input: usage.input + (ev.usage.input ?? 0),
                    output: usage.output + (ev.usage.output ?? 0),
                    cacheRead: (usage.cacheRead ?? 0) + (ev.usage.cacheRead ?? 0),
                    cacheWrite: (usage.cacheWrite ?? 0) + (ev.usage.cacheWrite ?? 0),
                  };
                } else if (!exactJournalActive && ev.type === 'tool_result') {
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
                    content:
                      typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
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
        forkedFrom: sessionForkedEvent
          ? {
              sessionId: sessionForkedEvent.parentSessionId,
              checkpointPromptIndex: sessionForkedEvent.parentCheckpointPromptIndex,
              checkpointHash: sessionForkedEvent.parentCheckpointHash,
              workspace: sessionForkedEvent.workspace,
              workspaceCheckpointHash: sessionForkedEvent.workspaceCheckpointHash,
            }
          : undefined,
      };

      // Extract tool_call_end events for TUI tool entry rendering on resume.
      const toolCallEnds = extractToolCallEnds(events);
      // `openToolUses` holds tool_use ids still unmatched after the full replay
      // (before repairToolUseAdjacency strips them) — i.e. tools the prior run
      // left in flight. Surfaced so resume() can notify without re-executing.
      const pendingToolUseCount =
        openToolUses && openToolUses.size > 0 ? openToolUses.size : undefined;
      const data: SessionData = {
        metadata: meta,
        events,
        messages: finalMessages,
        usage,
        toolCallEnds,
        ...(pendingToolUseCount !== undefined ? { pendingToolUseCount } : {}),
      };

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
            ev = scrubPersistedSessionEvent(parsed as SessionEvent, this.secretScrubber);
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
            const ev = scrubPersistedSessionEvent(parsed as SessionEvent, this.secretScrubber);
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

  /** Append a session summary to the index. */
  private async appendToIndex(summary: SessionSummary): Promise<void> {
    // Note: storage.write for this operation is emitted by FileSessionWriter.doClose()
    // so it can include the traceId. Do NOT emit here to avoid duplicates.
    try {
      await ensureDir(this.dir);
      // Serialize the append (and any compaction it triggers) under the index
      // file lock. The lock is per-FILE, so it also guards against a SECOND
      // wstack process in the same project appending/compacting concurrently —
      // without it, a compact() rewrite racing an append() silently drops the
      // appended line (the source-of-truth .jsonl survives, but the listing
      // cache loses the entry until rebuildIndex()).
      let shouldCompact = false;
      await withFileLock(this.indexFile, async () => {
        const line = JSON.stringify(summary) + '\n';
        await fsp.appendFile(this.indexFile, line, 'utf8');
        this._indexCache = null;
        this.invalidateShardManifestBySessionId(summary.id);
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
    } catch {
      // best-effort â€” error surfaced via the storage.write event in doClose()
    }
  }

  /** Append a tombstone entry for a deleted session. */
  private async writeTombstone(id: string): Promise<void> {
    try {
      await ensureDir(this.dir);
      await withFileLock(this.indexFile, async () => {
        const line = JSON.stringify({ action: 'delete', id }) + '\n';
        await fsp.appendFile(this.indexFile, line, 'utf8');
        this._indexCache = null;
        this.invalidateShardManifestBySessionId(id);
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
      emitSessionStoreRead(this.events, id, manifest, 'summary', outcome, Date.now() - t0, errorMsg);
      return summary;
    } catch (err) {
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
      emitSessionStoreRead(this.events, id, manifest, 'summary', outcome, Date.now() - t0, errorMsg);
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
      emitSessionStoreRead(
        this.events,
        id,
        manifest,
        'summary',
        'success',
        Date.now() - startTime,
      );
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
      for await (const event of iterateSessionEvents(ref.filePath, this.secretScrubber)) {
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
    await deleteSessionArtifacts({ rootDir: this.dir, id, jsonlPath });

    // Write an index tombstone so readIndex() filters this session out.
    await this.writeTombstone(id);
  }

  async delete(id: string): Promise<void> {
    // Guard 1: never delete the session another process in this project is
    // actively writing to. active.json is the per-project RecoveryLock; every
    // CLI/TUI/WebUI writes it on session start. Without this check, deleting
    // a session that a parallel surface holds open would silently drop every
    // subsequent append (the JSONL is gone) while the writer keeps buffering —
    // a data-loss + recovery-inconsistency bug.
    const activeId = await readActiveSessionId(this.dir);
    if (activeId && id === activeId) {
      throw new Error(
        `Session ${id} is currently active in this project and cannot be deleted. Resume or start another session first.`,
      );
    }
    // Guard 2: cross-process live-session registry. active.json only tracks
    // the *latest* active session per project; the registry lists every live
    // process (multiple terminals/TUIs/WebUIs can each have their own active
    // session). When wired, this catches a delete targeting a session that a
    // *different* surface is using, even though it isn't in our active.json.
    if (this.isSessionInUse) {
      const reason = await this.isSessionInUse(id);
      if (reason) {
        throw new Error(`Session ${id} is in use (${reason}) and cannot be deleted.`);
      }
    }
    await this.deleteSession(id);
  }

  async rename(id: string, name: string): Promise<SessionSummary> {
    const trimmed = name.trim();
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

    // Load the current summary (sidecar first, rebuild on miss) and apply
    // the name mutation. summaryFor() already emits read/failure events.
    // Build the updated summary with explicit name handling so we stay
    // compatible with exactOptionalPropertyTypes: a cleared name is omitted
    // from the object entirely (not set to undefined).
    const summary = await this.summaryFor(id);
    const { name: _drop, ...rest } = summary;
    const updated: SessionSummary = trimmed ? { ...rest, name: trimmed } : rest;

    const t0 = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    let errorMsg: string | undefined;
    try {
      await atomicWrite(manifest, JSON.stringify(updated), { mode: 0o600 });
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
        'close',
        outcome,
        Date.now() - t0,
        undefined,
        errorMsg,
      );
    }

    // Mirror the change into the index so list() reflects it immediately.
    // appendToIndex dedupes by id ("latest wins"), so the stale entry is
    // shadowed without a full compact.
    await this.appendToIndex(updated);
    this.invalidateShardManifestBySessionId(id);
    this._indexCache = null;
    this.clearLoadCache(id);
    return updated;
  }

  async prune(maxAgeDays = 30): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let deleted = 0;

    // Read the active session lock to avoid pruning the current session.
    const activeSessionId = await readActiveSessionId(this.dir);

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
        if (isPrunableSessionJsonl(entry.name)) await pruneFile(this.dir, entry.name, '');
        continue;
      }
      /* v8 ignore next -- defensive: root entries are only files or directories */
      if (!entry.isDirectory()) continue;
      // entry.name is a date-shard like "2026-06-06"
      const dateDir = path.join(this.dir, entry.name);
      /* v8 ignore next -- defensive: dateDir came from readdir and is readable */
      const files = await fsp.readdir(dateDir, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !isPrunableSessionJsonl(file.name)) continue;
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
    await atomicWrite(file, record);
    await fsp.unlink(meta).catch(() => undefined);
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

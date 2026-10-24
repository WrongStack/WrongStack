import { activeLimits, positiveLimit } from '@wrongstack/contracts/types/config/limits';
// Roadmap 10A: TodoItem's canonical home is the types/context.ts leaf
// (single source of truth, acyclic); re-exported here for existing import paths.
import type {
  AgentContext,
  ContextMessageLimits,
  TodoItem,
} from '@wrongstack/contracts/types/context';
import type { FileEventRecord } from '@wrongstack/contracts/types/file-event-record';
import type { RunEnv } from '@wrongstack/contracts/types/run-env';
import type { SessionEvent } from '@wrongstack/contracts/types/session';
import { isAppendableSessionWriter } from './context-conversation-journal.js';
import { ContextEnvironment } from './context-environment.js';
import type { ProviderMemoryEvidence } from './context-evidence.js';
import {
  recordFileEventEntry,
  recordFileObservation,
  recordSideEffectEntry,
  trimTrackedFiles,
} from './context-file-tracker.js';
import { drainHooks, registerHook } from './context-hooks.js';
import { resolveEventSessionId, resolveOwningSessionId } from './context-session-id.js';
import { ConversationState } from './conversation-state.js';

export type { ContextInit, RunOptions } from './context-environment.js';
export type { ProviderMemoryEvidence, TodoItem };
export { isAppendableSessionWriter, resolveEventSessionId, resolveOwningSessionId };

/**
 * L1-A: `Context` is the live agent-run object. Its read-only environment
 * shape is exposed by the `RunEnv` interface (every field below the
 * conversation state) and its mutable shape by `ConversationState` (the
 * `state` accessor). New code should declare the narrower type at its
 * parameter — pass `ctx` for it. Existing tools that accept `Context`
 * still work because `Context` structurally satisfies both.
 *
 * The single source of truth for the project directory is `projectRoot`.
 * All tools (read/write/bash/exec) resolve paths relative to this.
 * Sessions, config, memory, and logs are also stored under this root.
 *
 * There IS a mutable `workingDir` (separate from `projectRoot`) that can be
 * changed at runtime via `setWorkingDir()`. It starts as `cwd` and allows
 * the agent and user to navigate within the project without spawning a new
 * process. In restricted mode it stays inside `projectRoot` or the user-global
 * `~/.wrongstack`.
 */ export class Context extends ContextEnvironment implements RunEnv, AgentContext {
  /**
   * Optional cap on the number of messages retained in the conversation
   * history; past it the oldest messages are dropped. 0 (the default) = no
   * count cap. A message count says nothing about what the model can hold: a
   * fixed 1,000 evicted history on every append in long tool-heavy sessions
   * while a 1M-window model was far from full. Memory is bounded by
   * {@link MAX_MESSAGE_TOKENS} instead. Embedders/tests may still set one.
   */
  static readonly MAX_MESSAGES: number = 0;
  /**
   * Companion size cap on the same history, in estimated tokens.
   *
   * `MAX_MESSAGES` bounds the message *count*, which does not bound memory:
   * message size spans four orders of magnitude, and a tool result may be up
   * to `exec`'s 200 KB output cap. 2,000 of those is ~400 MB of live
   * conversation, reached without ever tripping the count cap. Both caps guard
   * the same failure — compaction not running — so both belong here.
   *
   * This is a RAM guard, not a model limit: 1M tokens is roughly 4M characters,
   * ~8 MB of UTF-16 text before JS object overhead. It never truncates below
   * the model's own window — {@link messageLimits} raises it to the session's
   * resolved window when that is larger — so history is only ever evicted
   * past what the model could accept anyway.
   * Set to 0 for unlimited (legacy/test behaviour).
   */
  static readonly MAX_MESSAGE_TOKENS = 1_000_000;
  /**
   * Hard cap on distinct tracked-file paths retained in memory per session.
   * Past this limit the oldest (least-recently-entered) path is dropped.
   * Prevents unbounded growth on very large repos in long sessions.
   * Affects readFiles, writtenFiles, fileMtimes, and fileHashes.
   */
  static readonly MAX_TRACKED_FILES = 5_000; /**
   * Files whose content the **user / model has explicitly seen** via the
   * `read` tool (or an edit's auto-read, which surfaces the content to the
   * model). This is the set the permission policy's write-smart-bypass
   * (step 7) checks — writing a file the model has already read is treated
   * as "no new content to approve". It must NEVER contain files only touched
   * by `edit`/`write`, otherwise the model could repeatedly overwrite a file
   * whose content the user never saw (P1 #1, before-release.md).
   *
   * Tool-driven mutations record via `writtenFiles` + `recordRead(..., 'write')`
   * so mtime tracking still works without widening the bypass.
   *
   * Bounded at MAX_TRACKED_FILES with oldest-first eviction to prevent
   * unbounded growth in long-running sessions over large codebases.
   */
  readFiles = new Set<string>();
  /**
   * Files written by `edit`/`write` in this session. Tracked for observability
   * and to keep `readFiles` (the permission-bypass source of truth) clean.
   * `recordRead(path, mtime, 'write')` adds here instead of `readFiles`.
   *
   * Bounded at MAX_TRACKED_FILES with oldest-first eviction.
   */
  writtenFiles = new Set<string>();
  /**
   * Last-known mtime for each tracked file path. Used by the permission
   * policy and edit-staleness checks.
   *
   * Bounded at MAX_TRACKED_FILES with oldest-first eviction to prevent
   * unbounded growth in long-running sessions.
   */
  fileMtimes = new Map<string, number>();
  /**
   * sha-256 (hex) of file content at the last recorded read/write, when the
   * recording tool had the content in hand. Used by `edit` as the authoritative
   * staleness arbiter: mtime comparison has a 2 s tolerance window on Windows
   * (FAT/NTFS granularity) during which an external modification is invisible,
   * and conversely a bare `touch` bumps mtime without changing content. Hash
   * equality resolves both cases exactly. Entries are dropped whenever a
   * hash-less `recordRead` observes a *different* mtime (content may have
   * changed under us — fall back to the mtime heuristic rather than trust a
   * stale hash).
   *
   * Bounded at MAX_TRACKED_FILES with oldest-first eviction.
   */
  fileHashes = new Map<string, string>();
  /**
   * Structured side-effect records accumulated during the current run
   * (P2 #5). Populated by `recordSideEffect()` — read by /diag for an
   * in-memory audit trail without parsing the JSONL file. Cleared by
   * `clearFileTracking()` alongside read/written-file tracking.
   *
   * Bounded at MAX_SIDE_EFFECTS (500) with oldest-first splice.
   */
  sideEffects: import('@wrongstack/contracts/types/side-effect').SideEffect[] = [];
  /**
   * Tracked file events for the current session. Populated by
   * `recordFileEvent()` — used for in-memory audit and real-time
   * subscription (EventBus `file.event`). Also persisted to session
   * JSONL as `file_event` events for durable storage.
   *
   * Bounded at MAX_FILE_EVENTS (1000) with oldest-first slice.
   */
  fileEvents: FileEventRecord[] = [];
  /**
   * Observable wrapper over the mutable conversation state. Lazy so
   * subsystems that don't subscribe pay nothing. Mutations made directly
   * on `ctx.messages` / `ctx.todos` are still visible through this
   * wrapper's read API (it holds a reference, not a copy) but only
   * mutations that go through `state.appendMessage()` etc. fire
   * `onChange`. New code should prefer the wrapper API.
   */
  _state: ConversationState | null = null;
  private static readonly MAX_FILE_EVENTS = 1000;
  private static readonly MAX_SIDE_EFFECTS = 500;
  get state(): ConversationState {
    if (!this._state) {
      this._state = new ConversationState(this);
      this._state.onChange((change) => {
        const ts = new Date().toISOString();
        const event: SessionEvent | null =
          change.kind === 'message_appended'
            ? {
                type: 'message_appended',
                ts,
                version: 1,
                message: change.message,
              }
            : change.kind === 'message_updated'
              ? {
                  type: 'message_updated',
                  ts,
                  version: 1,
                  index: change.index,
                  message: change.message,
                }
              : change.kind === 'messages_replaced'
                ? {
                    type: 'messages_replaced',
                    ts,
                    version: 1,
                    messages: [...change.messages],
                  }
                : change.kind === 'messages_dropped'
                  ? {
                      type: 'messages_dropped',
                      ts,
                      version: 1,
                      count: change.count,
                    }
                  : null;
        if (!event) return;
        this.enqueueConversationJournal(event, this.activeRunSessionWriter ?? this.session);
      });
    }
    return this._state;
  }

  /**
   * Register a teardown hook tied to the current run's abort signal.
   * Hooks registered before a run starts are stored and fired when the
   * next run ends; there is no immediate fire when no run is active.
   *
   * **Scope:** these hooks fire on the **whole agent run's** abort, not on
   * an individual tool call. For per-tool teardown of resources owned by
   * the tool author (child processes, handles), prefer `Tool.cleanup` —
   * see its JSDoc for the full rule.
   *
   * For hooks that must survive across run boundaries (mailbox heartbeat,
   * awareness polling, HQ publisher), prefer `registerAgentHook` instead.
   */
  /** Run-scoped abort hooks (drained by drainAbortHooks). Public for structural typing (Roadmap 10A). */
  readonly abortHooks = new Set<() => void | Promise<void>>();
  /** Retention limits honoring runtime subclass overrides of the statics. */
  get messageLimits(): ContextMessageLimits {
    const cls = this.constructor as typeof Context;
    const guard = cls.MAX_MESSAGE_TOKENS;
    const sessionWindow = this.meta?.['effectiveMaxContext'];
    const providerWindow = this.provider?.capabilities?.maxContext;
    const window =
      typeof sessionWindow === 'number' && sessionWindow > 0
        ? sessionWindow
        : typeof providerWindow === 'number' && providerWindow > 0
          ? providerWindow
          : 0;
    // `limits.historyMessages` is the user's own count cap; a subclass static
    // (embedders/tests) still applies when the user set none.
    const userMessages = positiveLimit(activeLimits().historyMessages);
    return Object.freeze({
      maxMessages: userMessages ?? cls.MAX_MESSAGES,
      maxMessageTokens: guard > 0 ? Math.max(guard, window) : guard,
    });
  }

  registerAbortHook(fn: () => void | Promise<void>): () => void {
    return registerHook(this.abortHooks, fn);
  }
  async drainAbortHooks(): Promise<void> {
    return drainHooks(this.abortHooks);
  }

  /**
   * Register a teardown hook that persists across individual run boundaries.
   * These hooks are NOT drained by `drainAbortHooks()` (which fires on every
   * run end). They are only released by `drainAgentHooks()`, intended to be
   * called during Agent teardown / process shutdown.
   *
   * Used for long-lived resources such as the mailbox heartbeat timer,
   * awareness polling interval, HQ publisher connection, and auto-compaction
   * timer — resources that must survive from the first run to the last.
   */
  /** Session-lifetime teardown hooks (drained by drainAgentHooks). Public for structural typing (Roadmap 10A). */
  readonly agentHooks = new Set<() => void | Promise<void>>();
  registerAgentHook(fn: () => void | Promise<void>): () => void {
    return registerHook(this.agentHooks, fn);
  }
  async drainAgentHooks(): Promise<void> {
    return drainHooks(this.agentHooks);
  }

  /**
   * Record that a file's content was seen / mtime was observed.
   *
   * `source` controls which tracking set is populated — and therefore whether
   * the permission policy's write-smart-bypass (step 7) will auto-approve a
   * subsequent `write` to this path:
   *
   * - `'user'` (default): the model/user saw the content (via `read`, or an
   *   edit's auto-read that surfaced it). Adds to `readFiles` → bypass applies.
   * - `'write'`: a tool wrote the file (`edit`/`write`) and is recording the
   *   new mtime so subsequent edits detect external modification. Adds to
   *   `writtenFiles` only — the bypass does NOT apply, because the user never
   *   approved the new content (P1 #1, before-release.md).
   *
   * `fileMtimes` is updated in both cases so mtime-based staleness checks work.
   *
   * `contentHash` (sha-256 hex of the exact content seen) is optional so
   * existing callers keep working. When provided it is stored in `fileHashes`
   * and becomes the authoritative staleness arbiter for later edits. When
   * omitted, a previously stored hash survives only if the observed mtime is
   * unchanged — a different mtime with no fresh hash means the content may
   * have changed, so the stale hash is dropped and staleness checks fall back
   * to mtime comparison.
   */
  recordRead(
    absPath: string,
    mtimeMs: number,
    source: 'user' | 'write' = 'user',
    contentHash?: string,
  ): void {
    recordFileObservation(
      this,
      this.session,
      absPath,
      mtimeMs,
      source,
      contentHash,
      Context.MAX_TRACKED_FILES,
    );
  }

  /**
   * Enforce MAX_TRACKED_FILES cap on all four file-tracking structures.
   * Evicts the oldest entries (insertion order = oldest-first in Set/Map)
   * when the cap is exceeded. This prevents unbounded memory growth in
   * long-running sessions over very large codebases where the agent
   * touches thousands of distinct files.
   */
  trimTrackedFiles(): void {
    trimTrackedFiles(this, Context.MAX_TRACKED_FILES);
  }

  /** Clear accumulated file-read metadata after compaction or at boundaries
   *  where stale read history could cause tools to skip legitimate re-reads.
   *  The agent re-populates this naturally on the next file access. */
  clearFileTracking(): void {
    this.readFiles.clear();
    this.writtenFiles.clear();
    this.fileMtimes.clear();
    this.fileHashes.clear();
    this.sideEffects = [];
    this.fileEvents = [];
    this.deliveredDirectoryInstructions?.clear();
  }

  /**
   * Record a structured side effect for the audit trail (P2 #5).
   */
  recordSideEffect(sideEffect: import('@wrongstack/contracts/types/side-effect').SideEffect): void {
    const sessionWriter = this.activeRunSessionWriter ?? this.session;
    recordSideEffectEntry(this.sideEffects, sessionWriter, sideEffect, Context.MAX_SIDE_EFFECTS);
  }

  /**
   * Set the current kanban task context for subsequent file operations.
   * Tools call this (or the agent loop sets it) so that `recordFileEvent()`
   * can associate operations with the active kanban task.
   *
   * Pass `undefined` for both to clear the task association.
   */
  setCurrentKanbanTask(taskId: string | undefined, boardId?: string | undefined): void {
    this.currentKanbanTaskId = taskId;
    this.currentKanbanBoardId = boardId;
    const existing =
      this.meta['kanban'] && typeof this.meta['kanban'] === 'object'
        ? (this.meta['kanban'] as Record<string, unknown>)
        : {};
    this.state.setMeta('kanban', {
      ...existing,
      ...(taskId ? { taskId } : { taskId: undefined }),
      ...(boardId ? { boardId } : { boardId: undefined }),
    });
  }

  /**
   * Record a comprehensive file event for the audit trail.
   */
  recordFileEvent(input: {
    operation: 'create' | 'read' | 'update' | 'delete' | 'rename';
    filePath: string;
    absPath: string;
    toolName: string;
    toolUseId: string;
    durationMs?: number | undefined;
    fileSize?: number | undefined;
    lines?: number | undefined;
    bytes?: number | undefined;
  }): void {
    recordFileEventEntry(
      this.fileEvents,
      {
        eventSessionId: () => this.eventSessionId(),
        agentId: this.agentId,
        agentName: this.agentName,
        provider: this.provider,
        model: this.model,
        activeLogicalRequestId: this.activeLogicalRequestId,
        activePromptManifestId: this.activePromptManifestId,
        currentKanbanTaskId: this.currentKanbanTaskId,
        currentKanbanBoardId: this.currentKanbanBoardId,
        activeRunSessionWriter: this.activeRunSessionWriter,
        session: this.session,
      },
      input,
      Context.MAX_FILE_EVENTS,
    );
  }

  /**
   * True if the model/user has explicitly seen this file's content via `read`
   * (or an edit auto-read). Tool-only writes (`source: 'write'`) do NOT count
   * — this is the source of truth for the permission policy's write bypass.
   */
  hasRead(absPath: string): boolean {
    return this.readFiles.has(absPath);
  }

  /** True if `edit`/`write` wrote this file in the current session. */
  hasWritten(absPath: string): boolean {
    return this.writtenFiles.has(absPath);
  }

  lastReadMtime(absPath: string): number | undefined {
    return this.fileMtimes.get(absPath);
  }

  /** sha-256 (hex) of the content at the last recorded read/write, if the
   *  recording tool supplied one. See `fileHashes` for drop semantics. */
  lastReadHash(absPath: string): string | undefined {
    return this.fileHashes.get(absPath);
  }
}

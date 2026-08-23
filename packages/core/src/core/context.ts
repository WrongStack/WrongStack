import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { TextBlock } from '../types/blocks.js';
import type { ContextEvidenceState } from '../types/context-evidence.js';
import type { FileEventRecord } from '../types/file-event-record.js';
import type { Message } from '../types/messages.js';
import type { Provider, Usage } from '../types/provider.js';
import type { SessionEvent, SessionWriter } from '../types/session.js';
import type { TokenCounter } from '../types/token-counter.js';
import type { Tool } from '../types/tool.js';
import { createContextEvidenceState } from '../utils/context-evidence.js';
import type { AgentContext, ContextMessageLimits } from '../types/context.js';
import type { RunEnv } from '../types/run-env.js';
import { ConversationState } from './conversation-state.js';

// Roadmap 10A: TodoItem's canonical home is the types/context.ts leaf
// (single source of truth, acyclic); re-exported here for existing import paths.
import type { TodoItem } from '../types/context.js';
export type { TodoItem };

export interface RunOptions {
  signal?: AbortSignal | undefined;
  model?: string | undefined;
  executionStrategy?: 'parallel' | 'sequential' | 'smart' | undefined;
  maxIterations?: number | undefined;
  /**
   * Enable autonomous continue for this specific run. When true, the agent
   * loop re-runs on `[continue]`/`[next step]`/`[proceed]` markers or
   * `continue_to_next_iteration()` tool calls instead of returning.
   * Overrides `AgentInit.autonomousContinue` for this call only.
   */
  autonomousContinue?: boolean | undefined;
}

export interface ContextInit {
  systemPrompt: TextBlock[];
  provider: Provider;
  session: SessionWriter;
  signal: AbortSignal;
  tokenCounter: TokenCounter;
  cwd: string;
  projectRoot: string;
  /** Mutable working directory. Defaults to `cwd`. Must stay within `projectRoot`. */
  workingDir?: string | undefined;
  /**
   * When false, file tools and `setWorkingDir()` are confined to `projectRoot`.
   * Defaults to `false` (restrictive) when omitted so directly-constructed
   * contexts (tests, embedded callers) keep the safe behavior; the runtime
   * passes the config-derived value (default `true` — permissive) explicitly.
   */
  allowOutsideProjectRoot?: boolean | undefined;
  model: string;
  tools?: Tool[] | undefined;
  /** Complete executable catalog for lazy discovery/meta-tools. */
  catalogTools?: Tool[] | undefined;
  /** Agent id performing this run (e.g. 'leader', 'executor', 'tech-stack'). */
  agentId?: string | undefined;
  /** Human-readable agent name. */
  agentName?: string | undefined;
  /**
   * Session-level trace ID for correlating storage events with agent
   * iterations in observability pipelines. Stored on the SessionWriter
   * so that storage operations can emit it in `storage.*` events.
   * When set, the Context constructor propagates it to
   * `session.traceId` automatically.
   */
  traceId?: string | undefined;
}

export interface ProviderMemoryEvidence {
  /** Stable owner key, for example `sage.tool-memory`. */
  source: string;
  /** Provider-bound evidence text; never appended to chat/tool history. */
  text: string;
}

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
 * process. All changes must stay inside `projectRoot`.
 */
export class Context implements RunEnv, AgentContext {
  messages: Message[] = [];
  /**
   * Maximum number of messages retained in the conversation history.
   * Past this limit, the oldest messages are dropped. Compaction passes
   * should reduce messages below this threshold — this cap is a safety
   * net to prevent unbounded growth when compaction is not running
   * (e.g., during a /rewind, provider error storm, or custom embedder).
   * Set to 0 for unlimited (legacy/test behaviour).
   */
  static readonly MAX_MESSAGES = 1_000;
  /**
   * Companion size cap on the same history, in estimated tokens.
   *
   * `MAX_MESSAGES` bounds the message *count*, which does not bound memory:
   * message size spans four orders of magnitude, and a tool result may be up
   * to `exec`'s 200 KB output cap. 2,000 of those is ~400 MB of live
   * conversation, reached without ever tripping the count cap. Both caps guard
   * the same failure — compaction not running — so both belong here.
   *
   * 1M tokens is roughly 4M characters, i.e. ~8 MB of UTF-16 text before JS
   * object overhead. That is still 5x a full 200k-token context window, so normal
   * compaction runs first; a broken compactor cannot retain tens of millions of characters.
   * Set to 0 for unlimited (legacy/test behaviour).
   */
  static readonly MAX_MESSAGE_TOKENS = 1_000_000;
  /**
   * Hard cap on distinct tracked-file paths retained in memory per session.
   * Past this limit the oldest (least-recently-entered) path is dropped.
   * Prevents unbounded growth on very large repos in long sessions.
   * Affects readFiles, writtenFiles, fileMtimes, and fileHashes.
   */
  static readonly MAX_TRACKED_FILES = 5_000;
  todos: TodoItem[] = [];
  /**
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
  sideEffects: import('../types/side-effect.js').SideEffect[] = [];
  /**
   * Tracked file events for the current session. Populated by
   * `recordFileEvent()` — used for in-memory audit and real-time
   * subscription (EventBus `file.event`). Also persisted to session
   * JSONL as `file_event` events for durable storage.
   *
   * Bounded at MAX_FILE_EVENTS (1000) with oldest-first slice.
   */
  fileEvents: FileEventRecord[] = [];
  contextEvidence: ContextEvidenceState = createContextEvidenceState();
  systemPrompt: TextBlock[];
  provider: Provider;
  session: SessionWriter;
  signal: AbortSignal;
  tokenCounter: TokenCounter;
  cwd: string;
  projectRoot: string;
  /** Mutable working directory — starts as `cwd`. Change via `setWorkingDir()`. */
  workingDir: string;
  /**
   * When true, file tools (via `_util.ts`) and `setWorkingDir()` reject paths
   * outside `projectRoot`. When false, those boundary checks are bypassed so
   * tools may reach paths outside the project (still gated by permission
   * tiers). Mutable so `/settings` can toggle it live on the running session.
   */
  allowOutsideProjectRoot: boolean;
  model: string;
  tools: Tool[] = [];
  /** Complete enabled catalog; provider token accounting continues to use `tools`. */
  catalogTools: Tool[] = [];
  meta: Record<string, unknown> = {};
  /** Agent id performing this run (e.g. 'leader', 'executor'). */
  agentId: string;
  /** Human-readable agent name. */
  agentName: string;
  /**
   * Current kanban task ID, set by the agent/coordinator when working
   * on a specific kanban task. Tools use this via `recordFileEvent()`
   * to associate file operations with the active task.
   */
  currentKanbanTaskId: string | undefined = undefined;
  /**
   * Current kanban board ID, paired with `currentKanbanTaskId`.
   */
  currentKanbanBoardId: string | undefined = undefined;
  /**
   * Session-level trace ID for correlating storage events with agent
   * iterations. Stored here and also propagated to `session.traceId`
   * so storage operations can include it in `storage.*` events.
   */
  traceId: string | undefined;
  /** Logical provider request whose response produced the current tool calls. */
  activeLogicalRequestId: string | undefined = undefined;
  /** Content-addressed prompt composition for {@link activeLogicalRequestId}. */
  activePromptManifestId: string | undefined = undefined;

  /**
   * Session id pinned to the currently-executing run. Set by `Agent.run()`
   * at run start and cleared when the run ends. Event-emission sites must
   * prefer this over `session.id` (via {@link eventSessionId}) because the
   * WebUI can swap `ctx.session` (session.new / resume) while a slow
   * provider stream from the previous session is still in flight — a live
   * `session.id` read would stamp the old run's late events with the NEW
   * session id and leak them into the new session's chat.
   */
  activeRunSessionId: string | undefined = undefined;
  /**
   * Writer pinned alongside `activeRunSessionId`. Persistence sites that stamp
   * a run-pinned session id must append through this writer; otherwise a
   * host-side `ctx.session` swap can put an old-session event in the new
   * session's JSONL.
   */
  activeRunSessionWriter: SessionWriter | undefined = undefined;

  /**
   * Session id that events of the in-flight run must be stamped with: the
   * run-pinned id when a run is active, otherwise the live session id.
   */
  eventSessionId(): string {
    return resolveEventSessionId(this);
  }

  /** Callbacks fired when `setWorkingDir()` changes the working directory. */
  /** WorkingDir-change callbacks; public for structural typing (Roadmap 10A). */
  readonly _onWorkingDirChanged: Array<(newDir: string, oldDir: string) => void> = [];
  /**
   * Serializes externally requested provider/model changes. Request creation
   * waits on this barrier so an automatic continuation cannot capture the old
   * model while a user-triggered switch is still building its provider.
   */
  _modelTransition: Promise<void> = Promise.resolve();

  runModelTransition<T>(transition: () => T | Promise<T>): Promise<T> {
    const result = this._modelTransition.then(transition, transition);
    this._modelTransition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async waitForModelTransition(): Promise<void> {
    await this._modelTransition;
  }

  /**
   * Set to true when the conversation gains new tool_use or tool_result
   * blocks — the only time repairToolUseAdjacency() can find new issues.
   * buildAndRunRequestPipeline() checks this flag to skip an O(n) scan
   * on iterations where no tool content was added (pure text responses).
   */
  toolAdjacencyDirty = false;

  /**
   * Pending PostToolUse hook context text accumulated during tool execution
   * when `contextAs === 'separate'`. Instead of appending a standalone user
   * message (which would break tool-use/tool-result adjacency), the tool
   * executor stores the text here and agent-tools merges it as a leading
   * text block in the same user message that carries the tool_results.
   * Cleared after being consumed by agent-tools.
   */
  pendingPostToolContext: string | undefined = undefined;

  /**
   * Bounded, provider-bound memory evidence kept outside conversation and
   * tool-result history. Owners replace their own slot instead of appending a
   * fresh message on every retrieval, so long sessions do not accumulate the
   * same SAGE hints. Request construction emits these as ephemeral system
   * suffixes, preserving the stable prompt-cache prefix.
   */
  memoryEvidence: ProviderMemoryEvidence[] = [];

  setMemoryEvidence(source: string, text: string | undefined, maxChars = 6_000): void {
    const key = source.trim();
    if (!key) return;
    const clean = text?.trim();
    const retained = this.memoryEvidence.filter((entry) => entry.source !== key);
    if (clean) {
      const boundedMax = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
      if (boundedMax > 0) retained.push({ source: key, text: clean.slice(0, boundedMax) });
    }
    // A plugin cannot grow this into an unbounded side channel. Oldest source
    // slots are evicted; each surviving owner remains independently replaceable.
    this.memoryEvidence = retained.slice(-8);
  }

  clearMemoryEvidence(source?: string): void {
    if (source === undefined) {
      this.memoryEvidence = [];
      return;
    }
    this.memoryEvidence = this.memoryEvidence.filter((entry) => entry.source !== source);
  }

  /**
   * H1: pre-computed total-request token estimate from the most recent
   * `estimateRequestTokens()` call in the agent loop's pre-flight step.
   * The middleware that decides when to compact, the `emitContextPct`
   * helper that drives the live context-fill bar, and the pre-flight
   * itself all need this number; previously each one walked the same
   * messages/system/tools arrays independently. Stashing it here lets
   * the three call sites share a single compute per iteration.
   *
   * The value is the **uncalibrated** total. Callers that want the
   * calibrated number apply the per-(provider,model) ratio themselves.
   */
  lastRequestTokens: number | undefined = undefined;

  /**
   * The provider's **authoritative** prompt-token count from the most recent
   * response — `effectiveInputTokens(usage)` = `input + cacheRead + cacheWrite`.
   * This is a REAL number, not an estimate. Paired with
   * `meta.realAnchorMsgCount` (the `messages.length` of the request that
   * produced it), it anchors the live context figure: the true count of
   * everything sent last turn, plus only an estimate of the messages appended
   * since. Undefined before the first response. See `realAnchoredInputTokens`.
   */
  lastRealInputTokens: number | undefined = undefined;

  constructor(init: ContextInit) {
    this.systemPrompt = init.systemPrompt;
    this.provider = init.provider;
    this.session = init.session;
    this.signal = init.signal;
    this.tokenCounter = init.tokenCounter;
    this.cwd = init.cwd;
    this.projectRoot = init.projectRoot;
    this.workingDir = init.workingDir ?? init.cwd;
    this.allowOutsideProjectRoot = init.allowOutsideProjectRoot ?? false;
    this.model = init.model;
    this.tools = init.tools ?? [];
    this.catalogTools = init.catalogTools ?? this.tools;
    this.agentId = init.agentId ?? 'unknown';
    this.agentName = init.agentName ?? 'Unknown Agent';
    this.traceId = init.traceId;
    this.allowOutsideProjectRoot = init.allowOutsideProjectRoot ?? false;
    // Propagate traceId to the SessionWriter so storage operations
    // can read it without needing a direct handle on the Context.
    this.session.traceId = init.traceId;
  }

  /**
   * Observable wrapper over the mutable conversation state. Lazy so
   * subsystems that don't subscribe pay nothing. Mutations made directly
   * on `ctx.messages` / `ctx.todos` are still visible through this
   * wrapper's read API (it holds a reference, not a copy) but only
   * mutations that go through `state.appendMessage()` etc. fire
   * `onChange`. New code should prefer the wrapper API.
   */
  _state: ConversationState | null = null;
  readonly _conversationJournalQueue: Array<{
    event: SessionEvent;
    bytes: number;
    writer: SessionWriter;
  }> = [];
  _conversationJournalBytes = 0;
  _conversationJournalDrain: Promise<void> | null = null;
  private static readonly CONVERSATION_JOURNAL_MAX_EVENTS = 256;
  private static readonly CONVERSATION_JOURNAL_MAX_BYTES = 4 * 1024 * 1024;
  private static readonly MAX_FILE_EVENTS = 1000;
  private static readonly MAX_SIDE_EFFECTS = 500;

  /** Wait until every exact conversation-state event queued so far is in the writer buffer. */
  async flushConversationJournal(): Promise<void> {
    for (;;) {
      if (this._conversationJournalQueue.length > 0) this.startConversationJournalDrain();
      const drain = this._conversationJournalDrain;
      if (!drain) break;
      await drain;
    }
    // After the drain completes, forcefully clear the queue to release
    // references to the old session's SessionEvent objects. The drain
    // above processed every event, but the array slot references may
    // still be held by V8's internal representation. Explicit nulling
    // here makes the old objects unreachable immediately.
    this._conversationJournalQueue.length = 0;
    this._conversationJournalBytes = 0;
  }

  conversationJournalBytes(event: SessionEvent): number {
    try {
      return Buffer.byteLength(JSON.stringify(event), 'utf8');
    } catch {
      return Context.CONVERSATION_JOURNAL_MAX_BYTES + 1;
    }
  }

  _journalDropCount = 0;
  _journalDropWarnAt = 0;

  /** Throttled notice that a conversation event never reached the journal. */
  warnConversationJournalDrop(eventType: SessionEvent['type']): void {
    this._journalDropCount++;
    const now = Date.now();
    if (now - this._journalDropWarnAt < 5_000) return;
    this._journalDropWarnAt = now;
    const dropped = this._journalDropCount;
    this._journalDropCount = 0;
    console.warn(
      JSON.stringify({
        level: 'error',
        event: 'session.conversation_journal_drop',
        sessionId: this.session?.id,
        eventType,
        droppedEvents: dropped,
        message: 'Session writer is not draining; replay of this session will be incomplete.',
        timestamp: new Date().toISOString(),
      }),
    );
  }

  enqueueConversationJournal(event: SessionEvent, writer: SessionWriter): void {
    const bytes = this.conversationJournalBytes(event);
    const shouldSnapshot =
      event.type === 'messages_replaced' ||
      this._conversationJournalQueue.length >= Context.CONVERSATION_JOURNAL_MAX_EVENTS ||
      this._conversationJournalBytes + bytes > Context.CONVERSATION_JOURNAL_MAX_BYTES;

    if (shouldSnapshot) {
      const snapshot: SessionEvent =
        event.type === 'messages_replaced'
          ? event
          : {
              type: 'messages_replaced',
              ts: new Date().toISOString(),
              version: 1,
              messages: [...this.messages],
            };
      const snapshotBytes = this.conversationJournalBytes(snapshot);
      for (let index = this._conversationJournalQueue.length - 1; index >= 0; index -= 1) {
        const queued = this._conversationJournalQueue[index];
        if (queued?.writer !== writer) continue;
        this._conversationJournalBytes = Math.max(0, this._conversationJournalBytes - queued.bytes);
        this._conversationJournalQueue.splice(index, 1);
      }
      // The snapshot is enqueued whatever it weighs. Refusing an oversized one
      // used to leave the queue holding nothing at all for this writer — the
      // deltas were purged just above — so the journal silently stopped
      // describing the conversation. That is worst exactly where it matters
      // most: `applyRewindToConversation` truncates the JSONL and then relies
      // on this snapshot to re-anchor it, and compaction relies on it to stop
      // the journal replaying the pre-compaction history. The overshoot is
      // also cheaper than the byte count suggests — `messages` is a shallow
      // copy of message objects the Context already keeps alive — and the
      // drain releases it on the next tick.
      this._conversationJournalQueue.push({ event: snapshot, bytes: snapshotBytes, writer });
      this._conversationJournalBytes += snapshotBytes;
    } else {
      this._conversationJournalQueue.push({ event, bytes, writer });
      this._conversationJournalBytes += bytes;
    }
    // Backstop for a writer that stops draining entirely. Snapshots are never
    // evicted: a dropped delta is one turn the next snapshot restores anyway,
    // a dropped snapshot is state nothing can restore. Loud, because reaching
    // here means the journal is about to be incomplete.
    while (
      this._conversationJournalQueue.length > Context.CONVERSATION_JOURNAL_MAX_EVENTS ||
      this._conversationJournalBytes > Context.CONVERSATION_JOURNAL_MAX_BYTES
    ) {
      const index = this._conversationJournalQueue.findIndex(
        (queued) => queued.event.type !== 'messages_replaced',
      );
      if (index === -1) break;
      const [dropped] = this._conversationJournalQueue.splice(index, 1);
      if (!dropped) break;
      this._conversationJournalBytes = Math.max(0, this._conversationJournalBytes - dropped.bytes);
      this.warnConversationJournalDrop(dropped.event.type);
    }
    this.startConversationJournalDrain();
  }

  startConversationJournalDrain(): void {
    if (this._conversationJournalDrain) return;
    const drain = (async () => {
      while (this._conversationJournalQueue.length > 0) {
        const queued = this._conversationJournalQueue.shift();
        if (!queued) continue;
        this._conversationJournalBytes = Math.max(0, this._conversationJournalBytes - queued.bytes);
        await queued.writer.append(queued.event).catch(() => {
          // Session persistence is best-effort. FileSessionWriter separately
          // bounds and retries its durable buffer.
        });
      }
    })().finally(() => {
      if (this._conversationJournalDrain === drain) this._conversationJournalDrain = null;
      if (this._conversationJournalQueue.length > 0) this.startConversationJournalDrain();
    });
    this._conversationJournalDrain = drain;
  }

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
        this.enqueueConversationJournal(event, this.session);
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
    return Object.freeze({
      maxMessages: cls.MAX_MESSAGES,
      maxMessageTokens: cls.MAX_MESSAGE_TOKENS,
    });
  }

  registerAbortHook(fn: () => void | Promise<void>): () => void {
    this.abortHooks.add(fn);
    return () => this.abortHooks.delete(fn);
  }
  async drainAbortHooks(): Promise<void> {
    const snapshot = [...this.abortHooks].reverse();
    // Clear before running so new hooks registered during iteration
    // fire on the next abort cycle (not the current one — hook chains
    // are intentionally not supported).
    this.abortHooks.clear();
    for (const fn of snapshot) {
      try {
        await fn();
      } catch {
        // hooks must be best-effort; swallow so siblings still fire
      }
    }
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
    this.agentHooks.add(fn);
    return () => this.agentHooks.delete(fn);
  }
  async drainAgentHooks(): Promise<void> {
    const snapshot = [...this.agentHooks].reverse();
    this.agentHooks.clear();
    for (const fn of snapshot) {
      try {
        await fn();
      } catch {
        // hooks must be best-effort; swallow so siblings still fire
      }
    }
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
    if (contentHash !== undefined) {
      this.fileHashes.set(absPath, contentHash);
    } else {
      const prevMtime = this.fileMtimes.get(absPath);
      if (prevMtime !== mtimeMs) this.fileHashes.delete(absPath);
    }
    this.fileMtimes.set(absPath, mtimeMs);
    if (contentHash !== undefined) {
      this.session.recordFileObservation?.({
        path: absPath,
        hash: contentHash,
        mtimeMs,
        source,
      });
    }
    if (source === 'write') {
      this.writtenFiles.add(absPath);
    } else {
      this.readFiles.add(absPath);
    }
    this.trimTrackedFiles();
  }

  /**
   * Enforce MAX_TRACKED_FILES cap on all four file-tracking structures.
   * Evicts the oldest entries (insertion order = oldest-first in Set/Map)
   * when the cap is exceeded. This prevents unbounded memory growth in
   * long-running sessions over very large codebases where the agent
   * touches thousands of distinct files.
   *
   * The order of eviction across structures is not synchronized (each
   * structure independently drops its oldest), so after trimming the
   * sets may reference paths whose mtime/hash have been evicted from the
   * maps, and vice-versa. This is safe: paths in a Set are just strings
   * (4-8 bytes per char in the heap), and a stale lookup in fileMtimes
   * returns undefined, which `read`/`edit` treat as "first access" —
   * the tool will re-stat the file and re-populate the entry. The agent
   * never fails or misbehaves; it just pays one extra stat call.
   */
  trimTrackedFiles(): void {
    Context.trimSet(this.readFiles, Context.MAX_TRACKED_FILES);
    Context.trimSet(this.writtenFiles, Context.MAX_TRACKED_FILES);
    Context.trimMap(this.fileMtimes, Context.MAX_TRACKED_FILES);
    Context.trimMap(this.fileHashes, Context.MAX_TRACKED_FILES);
  }

  private static trimSet(set: Set<string>, max: number): void {
    while (set.size > max) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }

  private static trimMap(map: Map<string, unknown>, max: number): void {
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
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
  }

  /**
   * Record a structured side effect for the audit trail (P2 #5).
   * Called by tools that perform non-filesystem mutations (bash, install,
   * fetch) so /diag and session replay can show what the agent did beyond
   * file edits.
   *
   * Unlike recordFileChange(), this does NOT support undo — it is purely
   * for observability and audit. The event is appended to the session
   * JSONL fire-and-forget; errors are swallowed so recording never blocks
   * tool execution.
   */
  recordSideEffect(sideEffect: import('../types/side-effect.js').SideEffect): void {
    this.sideEffects.push(sideEffect);
    if (this.sideEffects.length > Context.MAX_SIDE_EFFECTS) {
      this.sideEffects.splice(0, this.sideEffects.length - Context.MAX_SIDE_EFFECTS);
    }
    // Persist through the writer pinned to this run (if active) so a
    // host-side session swap cannot route side effects into the new
    // session's JSONL — same invariant as recordFileEvent.
    const sessionWriter = this.activeRunSessionWriter ?? this.session;
    sessionWriter
      .append({
        type: 'side_effect',
        ts: sideEffect.ts,
        toolUseId: sideEffect.toolUseId,
        toolName: sideEffect.toolName,
        input: sideEffect.input,
        outcome: sideEffect.outcome,
        risk: sideEffect.risk,
      })
      .catch(() => {
        /* best-effort — never block tool execution */
      });
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
   * Persists the event as a `file_event` session JSONL event.
   * Consumers that need `file.event` EventBus events should subscribe
   * at the executor level (see `ToolExecutor`'s auto-emission).
   *
   * The `scope` field is auto-derived from `currentKanbanTaskId`:
   * - When a kanban task is set, scope = `'task'` and `taskId`/`boardId`
   *   are populated from `currentKanbanTaskId`/`currentKanbanBoardId`.
   * - Otherwise scope = `'session'`.
   *
   * Fire-and-forget: errors are swallowed so recording never blocks
   * tool execution.
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
    const scope = this.currentKanbanTaskId ? 'task' : 'session';
    const ts = new Date().toISOString();
    const record: FileEventRecord = {
      operation: input.operation,
      filePath: input.filePath,
      absPath: input.absPath,
      sessionId: this.eventSessionId(),
      agentId: this.agentId,
      agentName: this.agentName,
      provider:
        typeof this.provider === 'object'
          ? (this.provider as { id: string }).id
          : String(this.provider),
      model: this.model,
      ...(this.activeLogicalRequestId ? { logicalRequestId: this.activeLogicalRequestId } : {}),
      ...(this.activePromptManifestId ? { promptManifestId: this.activePromptManifestId } : {}),
      provenanceConfidence:
        this.activeLogicalRequestId && this.activePromptManifestId ? 'explicit' : 'unknown',
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      scope,
      taskId: this.currentKanbanTaskId,
      boardId: this.currentKanbanBoardId,
      timestamp: ts,
      durationMs: input.durationMs,
      fileSize: input.fileSize,
      lines: input.lines,
      bytes: input.bytes,
    };

    this.fileEvents.push(record);
    if (this.fileEvents.length > Context.MAX_FILE_EVENTS) {
      this.fileEvents.splice(0, this.fileEvents.length - Context.MAX_FILE_EVENTS);
    }

    // Persist through the writer pinned to this run. The WebUI may replace
    // `this.session` while a late tool operation is completing; pairing the
    // writer with the already-pinned id keeps both JSONL routing and metadata
    // on the session that started the run.
    const sessionWriter = this.activeRunSessionWriter ?? this.session;
    sessionWriter
      .append({
        type: 'file_event',
        ts,
        operation: input.operation,
        filePath: input.filePath,
        absPath: input.absPath,
        sessionId: record.sessionId,
        agentId: this.agentId,
        agentName: this.agentName,
        provider: record.provider,
        model: record.model,
        ...(record.logicalRequestId ? { logicalRequestId: record.logicalRequestId } : {}),
        ...(record.promptManifestId ? { promptManifestId: record.promptManifestId } : {}),
        provenanceConfidence: record.provenanceConfidence,
        toolName: input.toolName,
        toolUseId: input.toolUseId,
        scope,
        taskId: this.currentKanbanTaskId,
        boardId: this.currentKanbanBoardId,
        durationMs: input.durationMs,
        fileSize: input.fileSize,
        lines: input.lines,
        bytes: input.bytes,
      })
      .catch(() => {
        /* best-effort — never block tool execution */
      });
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

  /**
   * Change the working directory for path resolution. Resolves relative paths
   * against `projectRoot` and validates the result is within the project root.
   * Fires all registered `onWorkingDirChanged` callbacks.
   * Returns the resolved absolute path.
   */
  setWorkingDir(dir: string): string {
    const resolved = path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(this.projectRoot, dir);

    // Validate containment within projectRoot — unless filesystem access is
    // unrestricted, in which case the working dir may leave the project root.
    if (!this.allowOutsideProjectRoot) {
      const root = path.resolve(this.projectRoot);
      const rel = path.relative(root, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Working directory "${resolved}" is outside project root "${root}"`);
      }
      // The lexical check above passes any path that merely SPELLS as if it
      // were inside the root. A symlink or Windows junction committed inside
      // the repo points outside while spelling as inside, and this setter is
      // the amplifier for that class: once the working dir sits on the far
      // side of the link, every tool that resolves a relative path against it
      // inherits the escape without naming a suspicious path itself.
      //
      // Realpath both sides — the root may itself be a link (macOS
      // `/var`→`/private/var`, Windows 8.3 short names), so a raw-vs-real
      // comparison would reject legitimate setups. `realpathSync`, not the
      // async form: this setter is synchronous and used across many callers.
      // A path that cannot be realpath'd (not yet created, permission denied)
      // keeps the lexical result, which the check above already validated.
      let realTarget = resolved;
      let realRoot = root;
      try {
        realTarget = realpathSync.native(resolved);
        realRoot = realpathSync.native(root);
      } catch {
        /* unresolvable — fall back to the lexically-validated pair */
      }
      const realRel = path.relative(realRoot, realTarget);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw new Error(
          `Working directory "${resolved}" resolves to "${realTarget}", outside project root "${realRoot}"`,
        );
      }
    }

    const old = this.workingDir;
    this.workingDir = resolved;
    // Fire callbacks (catch errors so one bad listener doesn't break others)
    for (const cb of this._onWorkingDirChanged) {
      try {
        cb(resolved, old);
      } catch {
        /* best-effort */
      }
    }
    return resolved;
  }

  /**
   * Register a callback that fires when the working directory changes.
   * Returns an unsubscribe function. Callbacks are fired synchronously
   * inside `setWorkingDir()` — errors in callbacks are swallowed so one
   * bad listener doesn't prevent others from executing.
   */
  onWorkingDirChanged(cb: (newDir: string, oldDir: string) => void): () => void {
    this._onWorkingDirChanged.push(cb);
    return () => {
      const idx = this._onWorkingDirChanged.indexOf(cb);
      if (idx >= 0) this._onWorkingDirChanged.splice(idx, 1);
    };
  }

  usage(): Usage {
    return this.tokenCounter.total();
  }
}

/**
 * Session id that events of the in-flight run must be stamped with: the
 * run-pinned id (`Context.activeRunSessionId`) when a run is active,
 * otherwise the live session id. Reads properties defensively because
 * tests and lightweight embedders stub Context with partial objects whose
 * `session` may be missing despite the non-optional type.
 */
export function resolveEventSessionId(ctx: Context): string {
  if (ctx.activeRunSessionId) return ctx.activeRunSessionId;
  const session: SessionWriter | undefined = ctx.session;
  return session?.id ?? '';
}

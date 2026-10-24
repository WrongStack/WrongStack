/**
 * Run environment of the live agent {@link Context} (context.ts): the
 * provider / session / project fields, run-pinned ids, model-transition
 * barrier, memory evidence, conversation-journal queue and working
 * directory. File tracking, hooks and the observable conversation state live
 * on Context itself.
 *
 * No private or protected members: they would make Context nominal (see
 * `allowOutsideProjectRootByContext`).
 */

import type { TextBlock } from '@wrongstack/contracts/types/blocks';
// Roadmap 10A: TodoItem's canonical home is the types/context.ts leaf
// (single source of truth, acyclic); re-exported here for existing import paths.
import type {
  ConversationJournalQueueApi,
  NestedToolCaller,
  TodoItem,
} from '@wrongstack/contracts/types/context';
import type { ContextEvidenceState } from '@wrongstack/contracts/types/context-evidence';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Provider, Usage } from '@wrongstack/contracts/types/provider';
import type { SessionEvent, SessionWriter } from '@wrongstack/contracts/types/session';
import type { TokenCounter } from '@wrongstack/contracts/types/token-counter';
import type { Tool } from '@wrongstack/contracts/types/tool';
import type {
  UserInputAwaiter,
  UserInputRequest,
  UserInputResponse,
} from '@wrongstack/contracts/types/user-input';
import { isProjectRootLocked } from '../security/process-lockdown.js';
import { createContextEvidenceState } from '../utils/context-evidence.js';
import { ConversationJournalQueue } from './context-conversation-journal.js';
import {
  clearMemoryEvidenceList,
  type ProviderMemoryEvidence,
  setMemoryEvidenceList,
} from './context-evidence.js';
import { resolveEventSessionId } from './context-session-id.js';
import { resolveAndValidateWorkingDir } from './context-working-dir.js';

/**
 * Backing store for `Context.allowOutsideProjectRoot`. A side table rather
 * than a private field: a private member makes `Context` nominal, and code
 * that passes an `AgentContext` where a `Context` is expected stops compiling.
 */
const allowOutsideProjectRootByContext = new WeakMap<object, boolean>();

export type RunInputOrigin = 'user' | 'continuation' | 'runtime';

/** Unlabelled callers are internal until a trusted host proves otherwise. */
export function resolveRunInputOrigin(origin: RunInputOrigin | undefined): RunInputOrigin {
  return origin ?? 'runtime';
}

export interface RunOptions {
  signal?: AbortSignal | undefined;
  model?: string | undefined;
  executionStrategy?: 'parallel' | 'sequential' | 'smart' | undefined;
  maxIterations?: number | undefined;
  /**
   * Provenance of the text passed to `Agent.run()`.
   * Only a real user turn may replace the leader's active mission anchor.
   */
  inputOrigin?: RunInputOrigin | undefined;
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
   * When false, file tools and `setWorkingDir()` are confined to `projectRoot`
   * plus the user-global `~/.wrongstack` (always reachable).
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
  /** Optional host bridge for structured model-to-user questions. */
  userInputAwaiter?: UserInputAwaiter | undefined;
  /**
   * Session-level trace ID for correlating storage events with agent
   * iterations in observability pipelines. Stored on the SessionWriter
   * so that storage operations can emit it in `storage.*` events.
   * When set, the Context constructor propagates it to
   * `session.traceId` automatically.
   */
  traceId?: string | undefined;
}

export abstract class ContextEnvironment {
  userInputAwaiter: UserInputAwaiter | undefined;
  /** Installed by the agent's tool handler (see `createAgentToolHandler`). */
  nestedToolCall?: NestedToolCaller | undefined;
  messages: Message[] = [];
  todos: TodoItem[] = [];
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
   * Under `--restricted` (`lockToProjectRoot`) it always reads false, whatever
   * was assigned.
   */
  get allowOutsideProjectRoot(): boolean {
    return (allowOutsideProjectRootByContext.get(this) ?? false) && !isProjectRootLocked();
  }
  set allowOutsideProjectRoot(value: boolean) {
    allowOutsideProjectRootByContext.set(this, value);
  }
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
  deliveredDirectoryInstructions?: Map<string, string> | undefined = new Map();

  /**
   * Bounded, provider-bound memory evidence kept outside conversation and
   * tool-result history. Owners replace their own slot instead of appending a
   * fresh message on every retrieval, so long sessions do not accumulate the
   * same SAGE hints. Request construction emits these as ephemeral system
   * suffixes, preserving the stable prompt-cache prefix.
   */
  memoryEvidence: ProviderMemoryEvidence[] = [];

  setMemoryEvidence(source: string, text: string | undefined, maxChars = 6_000): void {
    this.memoryEvidence = setMemoryEvidenceList(this.memoryEvidence, source, text, maxChars);
  }

  clearMemoryEvidence(source?: string): void {
    this.memoryEvidence = clearMemoryEvidenceList(this.memoryEvidence, source);
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
    this.userInputAwaiter = init.userInputAwaiter;
    this.traceId = init.traceId;
    this.allowOutsideProjectRoot = init.allowOutsideProjectRoot ?? false;
    // Propagate traceId to the SessionWriter so storage operations
    // can read it without needing a direct handle on the Context.
    this.session.traceId = init.traceId;
  }
  requestUserInput(
    request: UserInputRequest,
    signal: AbortSignal = this.signal,
  ): Promise<UserInputResponse | undefined> {
    return (
      this.userInputAwaiter?.(request, {
        signal,
        sessionId: this.eventSessionId(),
        meta: this.meta,
      }) ?? Promise.resolve(undefined)
    );
  }
  readonly _journalQueueManager: ConversationJournalQueueApi = new ConversationJournalQueue({
    sessionIdGetter: () => this.session?.id,
    messagesGetter: () => this.messages,
  });

  get _conversationJournalQueue() {
    return this._journalQueueManager.queue;
  }
  get _conversationJournalBytes(): number {
    return this._journalQueueManager.bytes;
  }
  set _conversationJournalBytes(val: number) {
    this._journalQueueManager.bytes = val;
  }
  get _conversationJournalDrain(): Promise<void> | null {
    return this._journalQueueManager.drain;
  }
  set _conversationJournalDrain(val: Promise<void> | null) {
    this._journalQueueManager.drain = val;
  }
  get _conversationJournalLastError(): Error | null {
    return this._journalQueueManager.lastError;
  }
  set _conversationJournalLastError(val: Error | null) {
    this._journalQueueManager.lastError = val;
  }
  get _journalDropCount(): number {
    return this._journalQueueManager.dropCount;
  }
  set _journalDropCount(val: number) {
    this._journalQueueManager.dropCount = val;
  }
  get _journalDropWarnAt(): number {
    return this._journalQueueManager.dropWarnAt;
  }
  set _journalDropWarnAt(val: number) {
    this._journalQueueManager.dropWarnAt = val;
  }
  /** Wait until every exact conversation-state event queued so far is in the writer buffer. */
  async flushConversationJournal(): Promise<void> {
    return this._journalQueueManager.flushConversationJournal();
  }

  conversationJournalBytes(event: SessionEvent): number {
    return this._journalQueueManager.conversationJournalBytes(event);
  }

  /** Throttled notice that a conversation event never reached the journal. */
  warnConversationJournalDrop(eventType: SessionEvent['type']): void {
    this._journalQueueManager.warnConversationJournalDrop(eventType);
  }

  enqueueConversationJournal(event: SessionEvent, writer: SessionWriter): void {
    this._journalQueueManager.enqueueConversationJournal(event, writer);
  }

  startConversationJournalDrain(): void {
    this._journalQueueManager.startConversationJournalDrain();
  }
  /**
   * Change the working directory for path resolution. Resolves relative paths
   * against `projectRoot` and validates the result is within the project root.
   * Fires all registered `onWorkingDirChanged` callbacks.
   * Returns the resolved absolute path.
   */
  setWorkingDir(dir: string): string {
    const resolved = resolveAndValidateWorkingDir(
      dir,
      this.projectRoot,
      this.allowOutsideProjectRoot,
    );

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

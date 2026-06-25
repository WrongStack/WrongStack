/**
 * EventBus — observe-only typed event bus.
 * Subscribers cannot modify or cancel. Subscriber exceptions are caught.
 */

import type { BrainDecision, BrainDecisionRequest } from '../coordination/brain.js';
import type { Context } from '../core/context.js';
import type { MemoryClearedPayload, MemoryConsolidatedPayload, MemoryForgottenPayload, MemoryRememberedPayload } from '../types/memory.js';
import type { Usage } from '../types/provider.js';
import type { Tool, ToolProgressEvent } from '../types/tool.js';
import type { ToolOutputMetadata } from '../types/context-evidence.js';

/**
 * Structural shape of a tracked agent as flushed by AgentStatusTracker. Kept
 * structural (not imported from the root `session-registry` module) so the
 * low-level kernel layer takes on no dependency on composition modules. The
 * real `AgentEntry` is assignable to this.
 */
export interface TrackedAgentSnapshot {
  id: string;
  name: string;
  startedAt?: string | undefined;
  status: string;
  currentTool?: string | undefined;
  iterations: number;
  toolCalls: number;
  costUsd?: number | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  ctxPct?: number | undefined;
  model?: string | undefined;
  partialText?: string | undefined;
  lastActivityAt: string;
}

export interface EventMap {
  'brain.decision_requested': { request: BrainDecisionRequest; at: number };
  'brain.decision_answered': { request: BrainDecisionRequest; decision: BrainDecision; at: number };
  'brain.decision_ask_human': {
    request: BrainDecisionRequest;
    decision: BrainDecision;
    at: number;
  };
  'brain.human_answered': {
    id: string;
    optionId?: string | undefined;
    deny?: boolean | undefined;
    text?: string | undefined;
    at: number;
  };
  'brain.decision_denied': { request: BrainDecisionRequest; decision: BrainDecision; at: number };
  /**
   * Fired by the BrainMonitor when it PROACTIVELY engaged (self-activation):
   * a watched signal (tool-failure streak, error storm) crossed its
   * threshold, the Brain was consulted, and — when the decision called for
   * it — a corrective steer was delivered to the working agent.
   */
  'brain.intervention': {
    kind: 'tool_failure_streak' | 'error_storm';
    request: BrainDecisionRequest;
    decision: BrainDecision;
    /** True when a steer was actually delivered to the agent. */
    intervened: boolean;
    at: number;
  };
  'session.started': { id: string };
  'session.ended': { id: string; usage: Usage };
  'session.damaged': { sessionId: string; detail: string };
  /**
   * Fired by AgentStatusTracker after every flush with the full agent list
   * (leader + subagents). In-process consumers (e.g. the HQ session-telemetry
   * bridge) read this to build live snapshots without re-reading the shared
   * session-registry file.
   */
  'session.agents_updated': { agents: readonly TrackedAgentSnapshot[] };
  /**
   * Fired around a single Agent.run() call. Status trackers use these to
   * measure active-run elapsed time instead of inferring it from iterations.
   */
  'agent.run.started': { ctx: Context; model: string; at: string };
  'agent.run.completed': {
    ctx: Context;
    status: 'done' | 'failed' | 'max_iterations' | 'aborted';
    iterations: number;
    at: string;
    durationMs: number;
  };
  'agent.run.error': { ctx: Context; err: Error; at: string; durationMs: number };
  'iteration.started': { ctx: Context; index: number };
  'iteration.completed': { ctx: Context; index: number };
  /**
   * Fired when the agent hits its iteration limit. Listeners (CLI/TUI) can
   * call `grant(extra)` to allow more iterations, or `deny()` to stop.
   * If no listener responds within 30s the run ends with 'max_iterations'.
   */
  'iteration.limit_reached': {
    currentIterations: number;
    currentLimit: number;
    grant: (extraIterations: number) => void;
    deny: () => void;
  };
  'provider.response': { ctx: Context; usage: Usage; stopReason: string };
  'provider.text_delta': { ctx: Context; text: string };
  'provider.thinking_delta': { ctx: Context; text: string };
  'provider.tool_use_start': { ctx: Context; id: string; name: string };
  'provider.tool_use_stop': { ctx: Context; id: string; name: string };
  /**
   * Fired when a single SSE event handler throws mid-stream. Best-effort: the
   * malformed event is skipped and the partial response built from earlier
   * events is preserved, so the stream is not aborted. `eventType` is the SSE
   * event's `type`; `msg` is the handler error message.
   */
  'provider.stream_error': { ctx: Context; eventType: string; msg: string };
  /**
   * Fired before each retry of a failed provider call. `attempt` is 1-based
   * (the first retry is attempt 1, etc.). `description` is the human-readable
   * one-liner from `ProviderError.describe()` — render this in the CLI/TUI
   * instead of grepping logger output for the raw JSON body.
   */
  'provider.retry': {
    providerId: string;
    attempt: number;
    delayMs: number;
    status: number;
    description: string;
  };
  /**
   * Fired once when a provider call ultimately fails (retries exhausted, or
   * non-retryable error). Same shape as `provider.retry` minus the delay.
   */
  'provider.error': {
    providerId: string;
    status: number;
    description: string;
    retryable: boolean;
  };
  /**
   * Fired by the fallback-model extension when the primary model is overloaded
   * (after its own retries are exhausted) and the agent switches to the next
   * model in the configured `fallbackModels` chain. `providerSwitched` is true
   * when the fallback also changed the active provider (cross-provider). UIs
   * render this as a notice: "⚠ opus overloaded — falling back to sonnet".
   */
  'provider.fallback': {
    from: { providerId: string; model: string };
    to: { providerId: string; model: string };
    status: number;
    providerSwitched: boolean;
  };
  'tool.started': { name: string; id: string; input?: unknown | undefined };
  /**
   * Fired for each ToolProgressEvent yielded by `Tool.executeStream`. UIs
   * subscribe to render incremental progress (streaming bash output, file
   * tree counts, etc.) without the tool having to know about the UI.
   */
  'tool.progress': { name: string; id: string; event: ToolProgressEvent };
  /** Cache hit on session store load — used by observability layers. */
  'storage.cache_hit': {
    sessionId: string;
    store: string;
    filePath: string;
    operation: string;
    durationMs: number;
  };
  /**
   * Fired when a tool call needs confirmation
   * is registered on the executor. The TUI renders a confirmation dialog
   * from this event. Resolution is driven by calling the resolve function
   * passed in the payload with a decision string ('yes' | 'no' | 'always' | 'deny').
   */
  'tool.confirm_needed': {
    tool: Tool;
    input: unknown;
    toolUseId: string;
    suggestedPattern: string;
    resolve: (decision: 'yes' | 'no' | 'always' | 'deny') => void;
  };
  /**
   * Fired after the user chooses 'always' or 'deny' on a confirmation prompt.
   * The TUI can use this to show a brief notification that the decision was
   * persisted to the trust file (e.g. "✓ always allowed popo.txt" / "✗ denied popo.txt").
   */
  'trust.persisted': {
    tool: string;
    pattern: string;
    decision: 'always' | 'deny';
  };
  /**
   * Fired when the agent loop detects that the model is repeating the same
   * response shape over and over — a tight loop that would otherwise burn
   * iterations indefinitely. The loop breaks with status `max_iterations`
   * after `repeatCount` consecutive identical iterations.
   *
   * Two flavours caught by the same safety valve:
   *  - `kind: 'tool'` — the same tool(s) called with effectively the same
   *    inputs (catches k2p7's tendency to retry identical tool calls when
   *    a tool returns an unexpected empty result).
   *  - `kind: 'message'` — the same assistant text repeated, with no tool
   *    calls. K2P7 and other weak-instruction-following models can echo
   *    their last assistant turn verbatim across many iterations in
   *    autonomous-continue mode. The fingerprint also matches this case
   *    so the safety valve catches it too.
   *  - `kind: 'mixed'` — both: the response contains tool calls AND text,
   *    and the combined fingerprint (tool names + text) repeats.
   *
   * UIs can render a warning chip. The `kind` field is additive — older
   * subscribers that only read `tools` continue to work.
   */
  'tool.loop_detected': {
    ctx: Context;
    /** Comma-separated tool names involved in the loop, or empty string for pure message loops. */
    tools: string;
    /** Number of consecutive identical iterations detected. */
    repeatCount: number;
    /** 0-based iteration index where the loop was detected. */
    iteration: number;
    /**
     * Shape of the loop. `tool` = identical tool calls; `message` = identical
     * text-only response; `mixed` = both tool calls and text repeated.
     * Defaults to `tool` for backward compatibility with subscribers that
     * pre-date the field.
     */
    kind?: 'tool' | 'message' | 'mixed' | undefined;
  };
  /**
   * `output` is a truncated preview of the tool's serialized result text
   * (capped at ~400 chars by the emitter). UIs render this inline in the
   * tool history line without re-fetching from the session log.
   */
  'tool.executed': {
    /**
     * The tool_use id (e.g. "toolu_…") issued by the provider for this call.
     * Pairs with `tool.started.id` so subscribers can correlate start/finish
     * even when the model fires multiple tools in parallel with identical
     * inputs. Optional only for legacy emit sites — new code should always
     * set it.
     */
    id?: string | undefined;
    name: string;
    durationMs: number;
    ok: boolean;
    input?: unknown | undefined;
    output?: string | undefined;
    /**
     * Full UTF-8 byte length of the serialized tool result that the model
     * actually sees (post-cap, post-scrub). The `output` preview is capped
     * at ~400 chars for transport; this number lets UIs surface what the
     * model is really paying tokens for. Optional only for legacy emit
     * sites that may not yet populate it.
     */
    outputBytes?: number | undefined;
    /**
     * Estimated token count for the full result body the model sees.
     * Computed from `outputBytes` with the standard ~3.5 chars/token
     * heuristic. Cheap to show in the TUI; not authoritative — the real
     * provider count lives in `provider.response.usage`. */
    outputTokens?: number | undefined;
    /**
     * For tools whose output has a clear "line" notion (file reads with
     * numbered prefixes, grep hits, bash stdout), the agent counts the
     * actual lines the model received and forwards it here. Undefined
     * for tools without a meaningful line count. */
    outputLines?: number | undefined;
    /**
     * Parsed context-management metadata for the result the model saw. This is
     * intentionally compact: file/symbol/error/path-integrity hints, not the
     * full output body. Compaction uses it to distinguish seen information from
     * information later referenced by the assistant.
     */
    metadata?: ToolOutputMetadata | undefined;
  };
  /**
   * Fired by the `delegate` tool right before it hands work to a subagent
   * and blocks on the result. Lets UIs render a "started delegating" line
   * immediately instead of looking idle for the (often minutes-long) life
   * of the subagent. Paired with `delegate.completed`.
   */
  'delegate.started': {
    /** Resolved roster role or free-form subagent name. */
    target: string;
    /** The task instruction handed to the subagent (untruncated — UIs trim). */
    task: string;
  };
  /**
   * Fired by the `delegate` tool once the subagent settles (success,
   * timeout, budget exhaustion, error). Carries human-friendly, untruncated
   * fields so UIs / the Telegram bridge can render a readable summary
   * instead of the JSON-stringified, ~400-char-truncated `tool.executed`
   * preview.
   */
  'delegate.completed': {
    /** Resolved roster role or free-form subagent name. */
    target: string;
    /** The task instruction handed to the subagent. */
    task: string;
    /** True only when the subagent finished its task cleanly. */
    ok: boolean;
    /** Task status — 'success' | 'timeout' | 'host_timeout' | 'stopped' | ... */
    status?: string | undefined;
    /** One-line human summary (from `buildDelegateSummary`), untruncated. */
    summary: string;
    durationMs: number;
    iterations: number;
    toolCalls: number;
    /** Estimated subagent cost in USD, from the director usage snapshot when known. */
    costUsd?: number | undefined;
    subagentId?: string | undefined;
  };
  // ── Agent Timeline Events ──────────────────────────────────────────
  /**
   * Fired when a subagent produces an assistant text block that should
   * appear in the main chat timeline (when agent streaming is enabled).
   * The payload carries the subagent's identity, the message content,
   * and the iteration index so UIs can render a threaded timeline.
   */
  'agent.timeline.message': {
    /** Subagent id (e.g. "bug-hunter@abc123"). */
    subagentId: string;
    /** Human-readable name or role label. */
    agentName: string;
    /** The assistant text block content, or a tool-call summary. */
    content: string;
    /** 'text' | 'tool_use' | 'error' | 'status' */
    kind: 'text' | 'tool_use' | 'error' | 'status';
    /** Iteration index within the subagent's own run. */
    iteration: number;
    /** ISO 8601 timestamp. */
    ts: string;
    /** When kind='tool_use', the tool name. */
    toolName?: string | undefined;
    /** Running cost estimate for this subagent so far. */
    costUsd?: number | undefined;
  };
  /**
   * Fired when a subagent's status changes (started, completed, failed,
   * timed out, stopped). UIs use this to update agent status indicators
   * and add status-change entries to the timeline.
   */
  'agent.status_changed': {
    subagentId: string;
    agentName: string;
    status: 'spawned' | 'running' | 'completed' | 'failed' | 'timeout' | 'stopped' | 'budget_exhausted';
    /** ISO 8601 timestamp. */
    ts: string;
    /** Human-readable summary or error message. */
    summary?: string | undefined;
    /** Task description when available. */
    task?: string | undefined;
  };
  /**
   * Fired on every `iteration.completed`. UIs subscribe to render a live
   * context-window fill bar per agent (e.g. "67% ████████░░"). The
   * `load` fraction matches the threshold levels: 0–0.6 green, 0.6–0.75
   * yellow, 0.75+ red.
   */
  'ctx.pct': {
    /** Fraction of maxContext currently in use (0–1+. Can exceed 1 when over budget). */
    load: number;
    /** Estimated total tokens (system + tools + messages). */
    tokens: number;
    /** Provider's max context window. */
    maxContext: number;
  };
  /** Fired when the active model's resolved context window changes. */
  'ctx.max_context': { providerId: string; modelId: string; maxContext: number };
  'token.threshold': { used: number; limit: number };
  /**
   * Fired by `DefaultTokenCounter` after each call to `account()` /
   * `accountWithModel()` updates its internal state. The payload carries
   * the live snapshot so subscribers (notably the TUI's `StatusBar`) can
   * re-render fresh token/cost/cache data immediately instead of waiting
   * for a slow polling interval. Cost fields may be zero when the model
   * is unknown to the ModelsRegistry — that is already signalled separately
   * by `token.cost_estimate_unavailable`.
   */
  'token.accounted': { usage: Usage; cost: { input: number; output: number; total: number } };
  /**
   * Fired when the subagent budget hits a soft limit and the coordinator
   * is being asked for an extension. The coordinator should call `extend()`
   * to grant more budget, or the promise auto-resolves to `deny` after
   * `timeoutMs` (default 30s), treating it as a hard stop.
   *
   * This event lets the CLI/TUI observe budget pressure in real time,
   * surface extension requests to users, and give the coordinator a
   * hook to implement custom extension policy without coupling to the
   * runner/budget classes.
   */
  'budget.threshold_reached': {
    kind: 'iterations' | 'tool_calls' | 'tokens' | 'cost' | 'timeout' | 'idle_timeout';
    used: number;
    limit: number;
    /**
     * Call to grant more of the same budget type. `timeoutMs` extends the
     * wall-clock budget; the coordinator's watchdog observes the patched
     * limit and re-arms its timer for the new remainder.
     */
    extend: (
      extra: Partial<{
        maxIterations: number;
        maxToolCalls: number;
        maxTokens: number;
        maxCostUsd: number;
        timeoutMs: number;
      }>,
    ) => void;
    /** Call to deny the extension — subagent will stop. */
    deny: () => void;
    /** Auto-resolves to deny after timeout. */
    timeoutMs: number;
  };
  'context.repaired': {
    ctx: Context;
    changed: boolean;
    removedToolUses: string[];
    removedToolResults: string[];
    removedMessages: number;
  };
  'compaction.fired': {
    /** Threshold level that triggered compaction (warn / soft / hard). */
    level: 'warn' | 'soft' | 'hard';
    /** Tokens estimated before compaction ran. */
    tokens: number;
    /** Fraction of maxContext at the time compaction fired. */
    load: number;
    /** Provider's max context window in tokens. */
    maxContext: number;
    /** Budget snapshot used for the compaction decision. */
    budget?: {
      maxContext: number;
      inputTokens: number;
      availableInputTokens: number;
      remainingInputTokens: number;
      reservedOutputTokens: number;
      reservedSafetyTokens: number;
      load: number;
      overflowTokens: number;
    } | undefined;
    /** Adaptive trigger signals observed alongside token pressure. */
    signals?: { repeatedReadCount?: number | undefined } | undefined;
    /** Full compaction report from the compactor. */
    report: { before: number; after: number; reductions: { phase: string; saved: number }[] };
    /** Whether aggressive (summary) mode was used. */
    aggressive: boolean;
  };
  /**
   * Fired when the auto-compaction middleware's compactor.compact() call
   * throws. Compaction is best-effort by design so we don't crash the agent
   * loop, but a persistent failure (misconfigured summarizer model, network
   * outage) means the next iteration may hit context overflow. Observability
   * layers / dashboards subscribe to this to surface the silent regression.
   */
  'compaction.failed': {
    err: Error;
    aggressive: boolean;
    level: 'warn' | 'soft' | 'hard';
    tokens: number;
    maxContext: number;
    budget?: {
      maxContext: number;
      inputTokens: number;
      availableInputTokens: number;
      remainingInputTokens: number;
      reservedOutputTokens: number;
      reservedSafetyTokens: number;
      load: number;
      overflowTokens: number;
    } | undefined;
    signals?: { repeatedReadCount?: number | undefined } | undefined;
    load: number;
    fatal: boolean;
  };
  /**
   * Subagent lifecycle events. Emitted by `MultiAgentHost` so the TUI can
   * surface what's happening in the fleet without needing director-mode
   * (which renders the live FleetPanel). These complement the FleetBus
   * (director-only) by giving the TUI a uniform feed for both `/spawn`
   * and director-orchestrated work.
   */
  'subagent.spawned': {
    subagentId: string;
    taskId: string;
    name?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    description?: string | undefined;
    /**
     * Absolute path to the per-subagent JSONL transcript on disk, when
     * one was created. Undefined when the subagent shares the parent
     * session writer (in-memory or single-file configurations).
     * Surfaced so the TUI (FleetPanel) and `/fleet log` can show the
     * user *where* to look without computing it from the run id.
     */
    transcriptPath?: string | undefined;
  };
  'subagent.task_started': {
    subagentId: string;
    taskId: string;
    description?: string | undefined;
  };
  /**
   * Fired by `MultiAgentHost` when a subagent hits a soft budget limit
   * and the coordinator is auto-extending. TUI renders this as a
   * status-line notice: "⚡ agent#name hitting kind limit (used/limit) — extending".
   * After the auto-extend the task either continues or the coordinator
   * denies the extension and the task ends with 'budget_exhausted'.
   */
  'subagent.budget_warning': {
    subagentId: string;
    kind: string;
    used: number;
    limit: number;
  };
  /**
   * Emitted when the coordinator/director actually GRANTS a budget
   * extension to a subagent (the resolution of a `budget.threshold_reached`
   * negotiation). Distinct from `subagent.budget_warning`, which fires when
   * a limit is merely *hit*. UIs use this to render a persistent "⚡ extended
   * ×N" badge so users can see how often an agent self-extended to stay
   * alive. `totalExtensions` is the cumulative count for this subagent across
   * all kinds; `newLimit` is the patched value for `kind`.
   */
  'subagent.budget_extended': {
    subagentId: string;
    kind: string;
    newLimit: number;
    totalExtensions: number;
  };
  /**
   * Per-tool-call event re-emitted from a subagent's own EventBus
   * onto the host EventBus, so the TUI / non-director surfaces can
   * render "AGENT#1 ● bash 250ms" without having to subscribe to
   * the director-only FleetBus. Fired AFTER the tool completes
   * (paired with `tool.executed`). Includes the subagent id so
   * multiple parallel subagents are distinguishable.
   */
  'subagent.tool_executed': {
    subagentId: string;
    taskId?: string | undefined;
    name: string;
    durationMs: number;
    ok: boolean;
    input?: unknown | undefined;
    outputBytes?: number | undefined;
  };
  /**
   * Periodic progress snapshot emitted by the subagent runner every ~25
   * iterations so the user can track what a subagent is doing without
   * looking at the FleetPanel. The leader's TUI surfaces this as a
   * chat history entry: "AGENT#2 💬 L25 · 47 tools · $0.023 · doing grep..."
   * Fired on a best-effort basis — slow subagents may skip emissions if
   * the 25-iteration window passes while the agent is between tool calls.
   */
  'subagent.iteration_summary': {
    subagentId: string;
    iteration: number;
    toolCalls: number;
    costUsd: number;
    currentTool?: string | undefined;
    partialText?: string | undefined;
  };
  'subagent.task_completed': {
    subagentId: string;
    taskId: string;
    status: 'success' | 'failed' | 'timeout' | 'stopped';
    iterations: number;
    toolCalls: number;
    durationMs: number;
    /**
     * Structured failure envelope when `status !== 'success'`. Carries
     * `kind` (one of `SubagentErrorKind`), `message`, `retryable`, and
     * optional `backoffMs`. UIs branch on `kind` to render the right
     * chip (rate_limit vs auth vs tool_failed). The type is imported
     * lazily as a structural object to avoid a coordination → kernel
     * cycle in the dependency graph.
     */
    error?:
      | {
          kind: string;
          message: string;
          retryable: boolean;
          backoffMs?: number | undefined;
          cause?: { name: string | undefined; message: string; stack?: string | undefined } | undefined;
        }
      | undefined;
    /** Final assistant text from the subagent's last turn. */
    finalText?: string | undefined;
  };
  /**
   * Fired by the delegate tool when a subagent finishes. The agent's run
   * loop listens for this to collect `delegateSummaries` for the RunResult,
   * so the CLI/TUI can render flashy completion banners.
   */
  'subagent.done': { summary: string; ok: boolean };
  /**
   * Fired by MultiAgentHost when a subagent's context window load changes.
   * The leader agent's ctx.pct is emitted directly on the host EventBus;
   * subagent ctx.pct events are forwarded here with subagentId attribution.
   * TUI uses this to render live context fill bars per agent.
   */
  'subagent.ctx_pct': {
    subagentId: string;
    load: number;
    tokens: number;
    maxContext: number;
  };
  // ── SDD live board ──────────────────────────────────────────────────────
  // Emitted by SddParallelRun so the board projector + every surface stream a
  // live, dependency-aware multi-agent run. `runId` correlates all events of
  // one run; the projector composes them into `sdd.board.snapshot`.
  /** A parallel SDD run started. */
  'sdd.run.started': { runId: string; graphId: string; specId?: string | undefined; total: number };
  /** A parallel SDD run reached a terminal state. */
  'sdd.run.finished': {
    runId: string;
    deadlocked: boolean;
    completed: number;
    failed: number;
    stopped: boolean;
  };
  /** A task began executing on a worker (carries who + which worktree). */
  'sdd.task.started': {
    runId: string;
    taskId: string;
    subagentId: string;
    agentName: string;
    worktreeBranch?: string | undefined;
  };
  /** A task finished successfully. */
  'sdd.task.completed': { runId: string; taskId: string; subagentId: string; durationMs: number };
  /** A task failed terminally (retries exhausted). */
  'sdd.task.failed': { runId: string; taskId: string; subagentId: string; error: string };
  /** A failed task was requeued for another attempt. */
  'sdd.task.retrying': { runId: string; taskId: string; attempt: number; maxRetries: number };
  /** A task's worker reported success but the post-task verification gate rejected it. */
  'sdd.task.verification_failed': { runId: string; taskId: string; reason: string };
  /** A completed task's worktree could not be merged back into the base branch. */
  'sdd.task.conflict': { runId: string; taskId: string; conflictFiles: string[] };
  /** A task was split into sub-tasks (the parent becomes a completed container). */
  'sdd.task.split': { runId: string; taskId: string; subtaskIds: string[] };
  /** The supervisor made a decision about a failing/stuck task. */
  'sdd.supervisor.decision': {
    runId: string;
    taskId: string;
    action: 'retry' | 'reassign' | 'split' | 'fail';
    rationale?: string | undefined;
  };
  /** A new wave of dependency-ready tasks began. */
  'sdd.wave': { runId: string; wave: number; batchSize: number };
  /** No runnable tasks remain but some are still blocked — with the blocking chains. */
  'sdd.deadlock': {
    runId: string;
    chains: Array<{ blocked: string; blockedBy: string[] }>;
  };
  /**
   * Throttled full board snapshot composed by SddBoardProjector. `snapshot` is
   * an `SddBoardSnapshot` (sdd/board-types) — typed `unknown` here so the kernel
   * layer never imports from the higher `sdd/` layer (it sits below it in the
   * DAG); consumers cast it back. The producer (SddBoardProjector) is typed.
   */
  'sdd.board.snapshot': { runId: string; snapshot: unknown };
  'mcp.server.connected': { name: string; toolCount: number };
  'mcp.server.reconnected': { name: string; toolCount: number };
  'mcp.server.disconnected': { name: string; reason: string };
  'token.cost_estimate_unavailable': { model: string };
  /** Fired by SessionWriter.writeCheckpoint() after the checkpoint event is appended to JSONL. */
  'checkpoint.written': {
    promptIndex: number;
    promptPreview: string;
    ts: string;
    fileCount: number;
  };
  /**
   * Fired by SessionWriter.writeInFlightMarker() — the agent loop has
   * started a long-running operation. Pairs with `in_flight.ended`
   * on clean shutdown. A marker with no end indicates a crash.
   * (Idea #1 from IDEAS.md — Stateful Session Recovery.)
   */
  'in_flight.started': { context: string; ts: string };
  /** Fired by SessionWriter.clearInFlightMarker() — operation completed cleanly. */
  'in_flight.ended': { reason: 'clean' | 'aborted' | 'recovered'; ts: string };
  /**
   * Fired after a session rewind completes: files are reverted and the session
   * history is truncated. The TUI listens to this to update its checkpoint
   * list and clear history entries that are now invalid.
   */
  'session.rewound': { toPromptIndex: number; revertedFiles: string[]; removedEvents: number };
  /**
   * Fired by the multi-agent coordinator on FleetBus whenever subagent
   * counts change (spawn/stop/complete). The TUI subscribes to render
   * live fleet counters without polling.
   */
  'coordinator.stats': {
    total: number;
    running: number;
    idle: number;
    stopped: number;
    inFlight: number;
    pending: number;
    completed: number;
    subagentStatuses: { subagentId: string; taskId: string; status: string; assigned: boolean }[];
  };
  /**
   * The coordinator's max-concurrent subagent ceiling was changed at runtime
   * (e.g. via `/fleet concurrency <n>`). `n` is the new ceiling. Lets the
   * TUI/WebUI reflect the updated limit without polling the host.
   */
  'concurrency.changed': { n: number };
  /**
   * Git-worktree lifecycle, emitted by WorktreeManager. AutoPhase allocates one
   * worktree per phase so parallelizable phases run isolated, then merges them
   * back sequentially. The WebUI/TUI subscribe to render live swim-lanes/DAG.
   */
  'worktree.allocated': {
    handleId: string;
    ownerId: string;
    ownerLabel: string;
    slug: string;
    dir: string;
    branch: string;
    baseBranch: string;
  };
  'worktree.committed': {
    handleId: string;
    ownerId: string;
    branch: string;
    committed: boolean;
    insertions: number;
    deletions: number;
    files: number;
    sha?: string | undefined;
  };
  'worktree.merged': {
    handleId: string;
    ownerId: string;
    branch: string;
    baseBranch: string;
    squash: boolean;
  };
  'worktree.conflict': {
    handleId: string;
    ownerId: string;
    branch: string;
    conflictFiles: string[];
  };
  'worktree.released': { handleId: string; ownerId: string; branch: string; kept: boolean };
  'worktree.failed': {
    handleId: string;
    ownerId: string;
    branch?: string | undefined;
    error: string;
  };
  /**
   * Auto-proceed countdown tick, emitted once per second by the REPL while
   * autonomy mode `auto` is counting down to self-driving the next suggestion.
   * `remaining` is the number of whole seconds left. Display-only: the TUI
   * StatusBar renders it as an "auto-proceed in Ns" chip; no consumer should
   * derive behavior from it (the REPL owns the actual timer).
   */
  'countdown.tick': { remaining: number };
  // ── Memory store events — emitted by DefaultMemoryStore so plugins can react ──
  'memory.remembered': MemoryRememberedPayload;
  'memory.forgotten': MemoryForgottenPayload;
  'memory.cleared': MemoryClearedPayload;
  'memory.consolidated': MemoryConsolidatedPayload;
  // ── Storage events — emitted by DefaultSessionStore, FileSessionWriter, goal-store, plan-store, boot, todos-checkpoint, queue-store, task-store ──
  /**
   * Fired when a store completes a read operation. Carries the session ID
   * and file path so dashboards can correlate storage I/O with agent
   * iterations via the session ID.
   */
  'storage.read': {
    sessionId: string;
    /** Which store was read. */
    store: 'session' | 'goal' | 'plan' | 'project' | 'todos' | 'queue' | 'tasks' | 'memory' | 'annotations' | 'audit' | 'replay' | 'config';
    filePath: string;
    /** Session store: load|list|summary|index_read. Goal store: load. Plan store: load. Memory store: readAll. Annotations: list. Audit: verify|load. Replay: load|lookup. Config: read_json|load_sync. */
    operation: string;
    outcome: 'success' | 'failure';
    durationMs: number;
    error?: string;
    traceId?: string;
  };
  /**
   * Fired when a store completes a write operation. Covers both individual
   * event appends and batch flushes — check `eventCount` to distinguish.
   */
  'storage.write': {
    sessionId: string;
    store: 'session' | 'goal' | 'plan' | 'project' | 'todos' | 'queue' | 'tasks' | 'memory' | 'annotations' | 'audit' | 'replay' | 'config';
    filePath: string;
    /** Session store: create|resume|append|flush|close|index_append|compact|checkpoint.
     * Goal store: save|update|delete. Plan store: save. Project manifest: manifest_write.
     * Todos: save. Queue: write|clear. Tasks: save. Memory: remember|forget|clear|consolidate.
     * Annotations: add|resolve|evict. Audit: record. Replay: record|compact. Config: persist_sync. */
    operation: string;
    outcome: 'success' | 'failure';
    durationMs: number;
    eventCount?: number;
    error?: string;
    traceId?: string;
  };
  /**
   * Fired when a store operation fails after best-effort retries.
   * Use this for alert-worthy persistent failures (disk full, permissions).
   */
  'storage.error': {
    sessionId: string;
    store: 'session' | 'goal' | 'plan' | 'project' | 'todos' | 'queue' | 'tasks' | 'memory' | 'annotations' | 'audit' | 'replay' | 'config';
    filePath: string;
    operation: string;
    outcome?: 'failure';
    error: string;
    recoverable: boolean;
    durationMs?: number;
    traceId?: string;
  };
  /**
   * Real-time client status event. Emitted by TUI/CLI/WebUI to report current
   * session stats (tool calls, tokens, model, mode, cost). Broadcast immediately
   * to all WebUI clients via setup-events.ts and written to status.json for
   * external watchers.
   */
  'client.status': {
    clientType: string;
    clientId: string;
    projectHash: string;
    agentCount: number;
    model: string;
    mode: string;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number;
    timestamp: number;
    projectSlug: string;
  };
  error: { err: Error; phase: string; _original?: Error | undefined };
}

export type EventName = keyof EventMap;
export type Listener<E extends EventName> = (payload: EventMap[E]) => void;

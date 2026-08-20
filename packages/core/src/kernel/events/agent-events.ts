import type { Context } from '../../core/context.js';

export interface AgentEventMap {
  /**
   * Fired around a single Agent.run() call. Status trackers use these to
   * measure active-run elapsed time instead of inferring it from iterations.
   */
  'agent.run.started': {
    sessionId?: string | undefined;
    ctx: Context;
    model: string;
    at: string;
    /** Exact text supplied for this run, used by live Office mission tracking. */
    inputText?: string | undefined;
  };
  'agent.run.completed': {
    sessionId?: string | undefined;
    ctx: Context;
    status: 'done' | 'failed' | 'max_iterations' | 'aborted';
    iterations: number;
    at: string;
    durationMs: number;
  };
  'agent.run.error': {
    sessionId?: string | undefined;
    ctx: Context;
    err: Error;
    at: string;
    durationMs: number;
  };
  /**
   * Fired by the `delegate` tool right before it hands work to a subagent
   * and blocks on the result. Lets UIs render a "started delegating" line
   * immediately instead of looking idle for the (often minutes-long) life
   * of the subagent. Paired with `delegate.completed`.
   */
  'delegate.started': {
    /** Parent/host session id for the delegation lifecycle. */
    sessionId?: string | undefined;
    /** Resolved roster role or free-form subagent name. */
    target: string;
    /** The task instruction handed to the subagent (untruncated — UIs trim). */
    task: string;
    /** Runtime identity for the spawned delegate, when creation succeeded. */
    subagentId?: string | undefined;
  };
  /**
   * Fired by the `delegate` tool once the subagent settles (success,
   * timeout, budget exhaustion, error). Carries human-friendly, untruncated
   * fields so UIs / the Telegram bridge can render a readable summary
   * instead of the JSON-stringified, ~400-char-truncated `tool.executed`
   * preview.
   */
  'delegate.completed': {
    /** Parent/host session id for the delegation lifecycle. */
    sessionId?: string | undefined;
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
    /** Parent/host session id this subagent timeline belongs to. */
    sessionId?: string | undefined;
    /** Subagent id (e.g. "bug-hunter@abc123"). */
    subagentId: string;
    /** Human-readable name or role label. */
    agentName: string;
    /** The assistant text block content, or a tool-call summary. */
    content: string;
    /** Timeline entry kind. */
    kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'status' | 'system';
    /** Iteration index within the subagent's own run. */
    iteration: number;
    /** ISO 8601 timestamp. */
    ts: string;
    /** When kind='tool_use' or 'tool_result', the tool name. */
    toolName?: string | undefined;
    /** Typed tool outcome for tool_result entries. */
    toolOk?: boolean | undefined;
    /** Running cost estimate for this subagent so far. */
    costUsd?: number | undefined;
  };
  /**
   * Fired when a subagent's status changes (started, completed, failed,
   * timed out, stopped). UIs use this to update agent status indicators
   * and add status-change entries to the timeline.
   */
  'agent.status_changed': {
    /** Parent/host session id this subagent status belongs to. */
    sessionId?: string | undefined;
    subagentId: string;
    agentName: string;
    status:
      | 'spawned'
      | 'running'
      | 'completed'
      | 'failed'
      | 'timeout'
      | 'stopped'
      | 'budget_exhausted';
    /** ISO 8601 timestamp. */
    ts: string;
    /** Human-readable summary or error message. */
    summary?: string | undefined;
    /** Task description when available. */
    task?: string | undefined;
  };
  /**
   * Subagent lifecycle events. Emitted by `MultiAgentHost` so the TUI can
   * surface what's happening in the fleet without needing director-mode
   * (which renders the live FleetPanel). These complement the FleetBus
   * (director-only) by giving the TUI a uniform feed for both `/spawn`
   * and director-orchestrated work.
   */
  'subagent.spawned': {
    /** Parent/host session id. Subagents remain children of this session. */
    sessionId?: string | undefined;
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
  /**
   * A spawn resolved fewer skills than it selected. Emitted so a skill that
   * silently failed to load — missing from the loader, gated by a capability
   * the subagent lacks, or cut by the prompt budget — is observable instead
   * of leaving the agent believing it received guidance it never got.
   */
  'subagent.skills.dropped': {
    sessionId?: string | undefined;
    role?: string | undefined;
    /** Skills whose body (and project addendum) reached the prompt. */
    selected: string[];
    /** skill → reason it was dropped. */
    dropped: Record<string, string>;
  };
  /**
   * In-band graceful-finish request for a background subagent (see
   * coordination/subagent-finish.ts). Emitted on the subagent's OWN EventBus
   * when its wall-clock deadline is crossed — or the leader explicitly asked
   * it to finish (session shutdown) — and the subagent's config opted into
   * `gracefulFinish`. The runner folds the notice into the conversation as a
   * `/btw` note at the next iteration boundary; the model then completes its
   * task in its own turn within the granted grace window. This event is a
   * notification, never an interrupt: nothing aborts when it fires.
   */
  'subagent.finish_requested': {
    /** Parent/host session id. */
    sessionId?: string | undefined;
    subagentId: string;
    /** Why the finish was requested (deadline crossed / leader finished). */
    reason: string;
    /** Epoch ms by which the subagent should have produced its final output. */
    deadlineMs: number;
    /** Granted working-time window in ms. */
    graceMs: number;
    /** Ready-to-read notice text; the loop folds it in as a `/btw` note. */
    notice: string;
  };
  /**
   * A background learning-distillation pass finished for a roster role.
   * Emitted by the fleet host's auto-optimize scheduler so surfaces can show
   * that an agent's skills were refined without a user action.
   */
  'agent.learning.optimized': {
    sessionId?: string | undefined;
    role: string;
    trigger: string;
    status: string;
    /** Skill addenda refreshed by the pass. */
    skills: string[];
    error?: string | undefined;
  };
  'subagent.task_started': {
    /** Parent/host session id. */
    sessionId?: string | undefined;
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
    /** Parent/host session id. */
    sessionId?: string | undefined;
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
    /** Parent/host session id. */
    sessionId?: string | undefined;
    subagentId: string;
    kind: string;
    newLimit: number;
    totalExtensions: number;
  };
  /**
   * Live per-tool start bridged from a subagent EventBus to the host. This is
   * distinct from the post-completion summary so observability surfaces can
   * show the exact worker/file while the operation is still running.
   */
  'subagent.tool_started': {
    /** Parent/host session id. */
    sessionId?: string | undefined;
    /** The subagent's own persisted session, when it differs from the host. */
    agentSessionId?: string | undefined;
    subagentId: string;
    agentName?: string | undefined;
    taskId?: string | undefined;
    traceId?: string | undefined;
    id: string;
    name: string;
    input?: unknown | undefined;
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
    /** Parent/host session id. */
    sessionId?: string | undefined;
    subagentId: string;
    agentSessionId?: string | undefined;
    agentName?: string | undefined;
    taskId?: string | undefined;
    /** Owning orchestration run, when the task belongs to one. */
    runId?: string | undefined;
    traceId?: string | undefined;
    /** Original provider tool_use id; pairs with subagent.tool_started.id. */
    id?: string | undefined;
    name: string;
    durationMs: number;
    ok: boolean;
    input?: unknown | undefined;
    output?: string | undefined;
    outputBytes?: number | undefined;
    outputTokens?: number | undefined;
    outputLines?: number | undefined;
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
    /** Parent/host session id. */
    sessionId?: string | undefined;
    subagentId: string;
    iteration: number;
    toolCalls: number;
    costUsd: number;
    currentTool?: string | undefined;
    partialText?: string | undefined;
  };
  'subagent.task_completed': {
    /** Parent/host session id. */
    sessionId?: string | undefined;
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
          cause?:
            | { name: string | undefined; message: string; stack?: string | undefined }
            | undefined;
        }
      | undefined;
    /** Final assistant text from the subagent's last turn. */
    finalText?: string | undefined;
  };
  /**
   * Fired after a subagent has been removed from the live coordinator and its
   * resources released. Surfaces must delete the agent instead of retaining a
   * terminal/idle card indefinitely.
   */
  'subagent.removed': {
    sessionId?: string | undefined;
    subagentId: string;
    reason?: string | undefined;
  };
  /**
   * Fired by the delegate tool when a subagent finishes. The agent's run
   * loop listens for this to collect `delegateSummaries` for the RunResult,
   * so the CLI/TUI can render flashy completion banners.
   */
  'subagent.done': { sessionId?: string | undefined; summary: string; ok: boolean };
  /**
   * Fired by MultiAgentHost when a subagent's context window load changes.
   * The leader agent's ctx.pct is emitted directly on the host EventBus;
   * subagent ctx.pct events are forwarded here with subagentId attribution.
   * TUI uses this to render live context fill bars per agent.
   */
  'subagent.ctx_pct': {
    /** Parent/host session id. */
    sessionId?: string | undefined;
    subagentId: string;
    /** Fraction of maxContext currently in use, clamped to 0..1 for display. */
    load: number;
    /** Unclamped fraction when available. Can exceed 1 when over budget. */
    rawLoad?: number | undefined;
    tokens: number;
    maxContext: number;
  };
}

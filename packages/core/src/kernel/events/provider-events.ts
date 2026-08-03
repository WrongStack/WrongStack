import type { ChroniclePromptManifest } from '../../chronicle/prompt-manifest.js';
import type { Context } from '../../core/context.js';
import type { ContentBlock } from '../../types/blocks.js';
import type { ProviderErrorBody, Usage } from '../../types/provider.js';

export interface ProviderEventMap {
  /** Fired before every physical provider/model attempt, including attempt zero. */
  'provider.attempt.started': {
    sessionId: string;
    traceId?: string | undefined;
    agentId?: string | undefined;
    logicalRequestId: string;
    attemptId: string;
    attempt: number;
    providerId: string;
    model: string;
    streaming: boolean;
    messageCount: number;
    toolCount: number;
    promptManifest?: ChroniclePromptManifest | undefined;
    startedAt: string;
    /** Kanban task this provider call belongs to, when known. */
    taskId?: string | undefined;
    /** Kanban board this provider call belongs to, when known. */
    boardId?: string | undefined;
  };
  /** Fired when one physical attempt returns a usable response. */
  'provider.attempt.completed': {
    sessionId: string;
    traceId?: string | undefined;
    agentId?: string | undefined;
    logicalRequestId: string;
    attemptId: string;
    attempt: number;
    providerId: string;
    model: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    stopReason: string;
    usage: Usage;
    /** Kanban task this provider call belongs to, when known. */
    taskId?: string | undefined;
    /** Kanban board this provider call belongs to, when known. */
    boardId?: string | undefined;
  };
  /** Fired for every failed attempt, whether or not another retry follows. */
  'provider.attempt.failed': {
    sessionId: string;
    traceId?: string | undefined;
    agentId?: string | undefined;
    logicalRequestId: string;
    attemptId: string;
    attempt: number;
    providerId: string;
    model: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    status: number;
    failureKind: string;
    description: string;
    retryable: boolean;
    retryScheduled: boolean;
    retryDelayMs?: number | undefined;
    providerRequestId?: string | undefined;
    /** Scrubbed provider failure envelope/body retained for diagnostics. */
    errorBody?: ProviderErrorBody | undefined;
    /** Kanban task this provider call belongs to, when known. */
    taskId?: string | undefined;
    /** Kanban board this provider call belongs to, when known. */
    boardId?: string | undefined;
  };
  'provider.response': {
    sessionId?: string | undefined;
    ctx: Context;
    model: string;
    content?: ContentBlock[] | undefined;
    usage: Usage;
    stopReason: string;
  };
  'provider.text_delta': { sessionId?: string | undefined; ctx: Context; text: string };
  'provider.thinking_delta': { sessionId?: string | undefined; ctx: Context; text: string };
  'provider.tool_use_start': {
    sessionId?: string | undefined;
    ctx: Context;
    id: string;
    name: string;
  };
  'provider.tool_use_stop': {
    sessionId?: string | undefined;
    ctx: Context;
    id: string;
    name: string;
  };
  /**
   * Fired when a single SSE event handler throws mid-stream. Best-effort: the
   * malformed event is skipped and the partial response built from earlier
   * events is preserved, so the stream is not aborted. `eventType` is the SSE
   * event's `type`; `msg` is the handler error message.
   */
  'provider.stream_error': {
    sessionId?: string | undefined;
    ctx: Context;
    eventType: string;
    msg: string;
  };
  /**
   * Fired before each retry of a failed provider call. `attempt` is 1-based
   * (the first retry is attempt 1, etc.). `description` is the human-readable
   * one-liner from `ProviderError.describe()` — render this in the CLI/TUI
   * instead of grepping logger output for the raw JSON body.
   */
  'provider.retry': {
    sessionId?: string | undefined;
    providerId: string;
    attempt: number;
    delayMs: number;
    status: number;
    description: string;
    /** Scrubbed provider failure envelope/body retained for diagnostics. */
    errorBody?: ProviderErrorBody | undefined;
  };
  /**
   * Fired once when a provider call ultimately fails (retries exhausted, or
   * non-retryable error). Same shape as `provider.retry` minus the delay.
   */
  'provider.error': {
    sessionId?: string | undefined;
    providerId: string;
    status: number;
    description: string;
    retryable: boolean;
    /** Scrubbed provider failure envelope/body retained for diagnostics. */
    errorBody?: ProviderErrorBody | undefined;
  };
  /**
   * Fired by the fallback-model extension when the primary model is overloaded
   * (after its own retries are exhausted) and the agent switches to the next
   * model in the configured `fallbackModels` chain. `providerSwitched` is true
   * when the fallback also changed the active provider (cross-provider). UIs
   * render this as a notice: "⚠ opus overloaded — falling back to planner".
   */
  'provider.fallback': {
    sessionId?: string | undefined;
    from: { providerId: string; model: string };
    to: { providerId: string; model: string };
    status: number;
    providerSwitched: boolean;
    contextWindowWarning?:
      | {
          fromMaxContext: number;
          toMaxContext: number;
          currentTokens?: number | undefined;
        }
      | undefined;
  };
  /**
   * Fired whenever a (providerId, model) pair transitions between
   * healthy/degraded/blocked states. The tracker emits this so the
   * CLI/TUI/WebUI can render a live status indicator.
   */
  'provider.status_changed': {
    providerId: string;
    model: string;
    oldState: 'healthy' | 'degraded' | 'blocked';
    newState: 'healthy' | 'degraded' | 'blocked';
    reason: string;
    timestamp: number;
    stateExpiresAt?: number | undefined;
  };
  /**
   * Fired when the agent's actively selected (primary, not fallback)
   * provider/model is blocked and will be skipped. The CLI/TUI should
   * surface this prominently — the user's chosen provider has a known
   * problem and the agent has rotated to a fallback. The user can then
   * decide whether to switch providers, wait, or overrule the block.
   *
   * This is a one-shot event (one per agent turn when blocked).
   */
  'provider.active_blocked': {
    providerId: string;
    model: string;
    state: 'blocked';
    /** The fallback provider/model the agent will try instead. */
    fallbackProviderId: string;
    fallbackModel: string;
    /** Description of the last error that led to this state. */
    lastError: string;
    sessionId?: string | undefined;
    timestamp: number;
  };
}

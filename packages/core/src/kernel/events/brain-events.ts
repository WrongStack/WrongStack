import type { BrainDecision, BrainDecisionRequest } from '../../coordination/brain.js';
import type { Usage } from '../../types/provider.js';
import type { BrainInterventionKind } from '../events.js';

export interface BrainEventMap {
  'brain.decision_requested': {
    sessionId?: string | undefined;
    request: BrainDecisionRequest;
    at: number;
  };
  'brain.decision_answered': {
    sessionId?: string | undefined;
    request: BrainDecisionRequest;
    decision: BrainDecision;
    at: number;
  };
  'brain.decision_ask_human': {
    sessionId?: string | undefined;
    request: BrainDecisionRequest;
    decision: BrainDecision;
    at: number;
  };
  'brain.human_answered': {
    sessionId?: string | undefined;
    id: string;
    optionId?: string | undefined;
    deny?: boolean | undefined;
    text?: string | undefined;
    at: number;
  };
  'brain.decision_denied': {
    sessionId?: string | undefined;
    request: BrainDecisionRequest;
    decision: BrainDecision;
    at: number;
  };
  /**
   * Fired by the BrainMonitor when it PROACTIVELY engaged (self-activation):
   * a watched signal (tool-failure streak, error storm, agent stall,
   * file-churn oscillation) crossed its threshold, the Brain was consulted,
   * and — when the decision called for it — a corrective steer was
   * delivered to the working agent.
   */
  'brain.intervention': {
    sessionId?: string | undefined;
    kind: BrainInterventionKind;
    request: BrainDecisionRequest;
    decision: BrainDecision;
    /** True when a steer was actually delivered to the agent. */
    intervened: boolean;
    at: number;
  };
  /**
   * Fired by the BrainDecisionLedger when the real-world outcome of an
   * earlier Brain decision becomes observable (e.g. a budget-extended
   * subagent's task later completed or failed, or a steered signal
   * re-triggered). Closes the decide → observe → learn loop: outcome stats
   * are fed back into the LLM/council decision prompts.
   */
  'brain.outcome': {
    sessionId?: string | undefined;
    /** The `BrainDecisionRequest.id` of the decision this outcome belongs to. */
    requestId: string;
    outcome: 'success' | 'failure';
    detail?: string | undefined;
    at: number;
  };
  'token.threshold': { sessionId?: string | undefined; used: number; limit: number };
  /**
   * Fired by `DefaultTokenCounter` after each call to `account()` /
   * `accountWithModel()` updates its internal state. The payload carries
   * the live snapshot so subscribers (notably the TUI's `StatusBar`) can
   * re-render fresh token/cost/cache data immediately instead of waiting
   * for a slow polling interval. Cost fields may be zero when the model
   * is unknown to the ModelsRegistry — that is already signalled separately
   * by `token.cost_estimate_unavailable`.
   */
  'token.accounted': {
    sessionId?: string | undefined;
    usage: Usage;
    cost: { input: number; output: number; total: number };
    /** Provider id that produced this usage (e.g. 'anthropic'), when known. */
    provider?: string | undefined;
    /** Model id the cost was priced against, when known. */
    model?: string | undefined;
  };
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
    sessionId?: string | undefined;
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
  'token.cost_estimate_unavailable': { sessionId?: string | undefined; model: string };
  /**
   * Fired by the multi-agent coordinator on FleetBus whenever subagent
   * counts change (spawn/stop/complete). The TUI subscribes to render
   * live fleet counters without polling.
   */
  'coordinator.stats': {
    sessionId?: string | undefined;
    total: number;
    running: number;
    idle: number;
    stopped: number;
    inFlight: number;
    pending: number;
    completed: number;
    /** Optional fleet-wide cost total (USD) — set by the host bridge when known. */
    totalCostUsd?: number | undefined;
    subagentStatuses: {
      subagentId: string;
      taskId: string;
      status: string;
      assigned: boolean;
      /** Human label / role, when the host bridge joins Director usage data. */
      name?: string | undefined;
      role?: string | undefined;
      model?: string | undefined;
      /** Cumulative spend on this subagent (USD), when known. */
      costUsd?: number | undefined;
      /** Wall-clock runtime so far, in ms. */
      runtimeMs?: number | undefined;
      /** ISO timestamp of the most recent activity, when known. */
      lastActivityAt?: string | undefined;
      iterations?: number | undefined;
      toolCalls?: number | undefined;
    }[];
  };
  /**
   * The coordinator's max-concurrent subagent ceiling was changed at runtime
   * (e.g. via `/fleet concurrency <n>`). `n` is the new ceiling. Lets the
   * TUI/WebUI reflect the updated limit without polling the host.
   */
  'concurrency.changed': { sessionId?: string | undefined; n: number };
}

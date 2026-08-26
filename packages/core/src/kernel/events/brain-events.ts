import type { BrainDecision, BrainDecisionRequest } from '../../coordination/brain.js';
import type { BrainDecisionTier } from '../../coordination/brain-telemetry.js';
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
    /**
     * Which tier resolved the decision (`rule`/`policy`/`heuristic`/`cache`/
     * `ledger-guard` are free; `council`/`llm` cost a provider call). Absent
     * when the arbiter chain recorded no provenance.
     */
    tier?: BrainDecisionTier | undefined;
  };
  'brain.decision_ask_human': {
    sessionId?: string | undefined;
    request: BrainDecisionRequest;
    decision: BrainDecision;
    at: number;
    /** See `brain.decision_answered`. */
    tier?: BrainDecisionTier | undefined;
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
    /** See `brain.decision_answered`. */
    tier?: BrainDecisionTier | undefined;
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
  /**
   * One ATTEMPT against one model in a Brain LLM tier.
   *
   * The single-LLM tier walks its pool with a bare `catch {}`, and the council
   * resolves seats internally, so until this event existed there was no way to
   * answer "which model actually decided, which ones timed out, and what did
   * it cost" — the pool could be silently degraded for an entire session.
   *
   * Emitted once per target per decision (so a fallback chain produces
   * several), including failures. Text fields are populated only when trace
   * content capture is enabled; the metadata is always safe to record.
   */
  'brain.llm_call': {
    sessionId?: string | undefined;
    /** `BrainDecisionRequest.id` this call belongs to. */
    requestId: string;
    /** Which tier issued the call. */
    tier: 'llm' | 'council' | 'judge';
    providerId?: string | undefined;
    model: string;
    /** Display label, e.g. "anthropic/claude-haiku". */
    label?: string | undefined;
    /** 0-based position in the pool/fallback order for this decision. */
    attempt: number;
    ok: boolean;
    durationMs: number;
    /** Failure message when `ok` is false. */
    error?: string | undefined;
    /** Raw response text — only when trace content capture is on. */
    responseText?: string | undefined;
    usage?: Usage | undefined;
    at: number;
  };
  /** One council seat's observable vote. No hidden chain-of-thought is retained. */
  'brain.council_vote': {
    sessionId?: string | undefined;
    requestId: string;
    seatId: string;
    persona: string;
    status: 'valid' | 'invalid' | 'failed' | 'cancelled';
    providerId?: string | undefined;
    model?: string | undefined;
    optionId?: string | undefined;
    /** Free-text stance for optionless questions. Content-gated. */
    stance?: string | undefined;
    /** Vote rationale. Content-gated. */
    rationale?: string | undefined;
    weight?: number | undefined;
    veto?: boolean | undefined;
    durationMs?: number | undefined;
    error?: string | undefined;
    at: number;
  };
  /** How the council's votes resolved — the deterministic half of a council decision. */
  'brain.council_resolved': {
    sessionId?: string | undefined;
    requestId: string;
    status: 'decided' | 'denied' | 'abstained' | 'failed' | 'cancelled';
    /** majority | veto | refusal | judge | first_stance | none */
    resolution: string;
    optionId?: string | undefined;
    configuredSeatCount: number;
    validVoteCount: number;
    distinctTargetCount: number;
    judgeUsed: boolean;
    usage?:
      | {
          calls: number;
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          durationMs: number;
        }
      | undefined;
    /**
     * Panel-integrity warnings from the orchestrator — today the distinctness
     * policy ("N distinct target(s) served M valid vote(s)").
     *
     * NOT content-gated: these strings are structural metadata about the panel
     * itself and carry no decision content. They are also the only signal that
     * a council was CORRELATED — several seats resolving to the same model or
     * provider makes a panel an expensive way to ask one model twice, and the
     * adapter used to compute this and then drop it, so the degradation was
     * invisible at every surface.
     */
    warnings?: string[] | undefined;
    /** Abstain/failure reason. Content-gated. */
    reason?: string | undefined;
    at: number;
  };
  /**
   * A step in the rules → policy → council → LLM → escalation ladder: which
   * tier ran, what it returned, and whether the chain moved on. This is the
   * detailed form of the `tier` field on `brain.decision_*`, and it is what
   * makes a decision reconstructable after the fact.
   */
  'brain.tier_transition': {
    sessionId?: string | undefined;
    requestId: string;
    tier: BrainDecisionTier;
    /** What this tier produced, or 'error' when it threw. */
    outcome: 'answer' | 'deny' | 'ask_human' | 'error' | 'skipped';
    /** True when the chain accepted this tier's result and stopped here. */
    terminal: boolean;
    /** Why the chain moved on (risk ceiling, council floor, non-answer, throw). */
    reason?: string | undefined;
    durationMs?: number | undefined;
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
    /**
     * Agent that burned these tokens. Absent means the leader.
     *
     * Every subagent runs on its own `DefaultTokenCounter` but reports the
     * LEADER's session id (its counter is constructed with the host session so
     * live cost UIs stay on one row). Without this field, a subagent's usage is
     * indistinguishable from the leader's in every downstream consumer —
     * Chronicle's domain adapter keys `scope.agentId` off it, and 2,402
     * measured `token.accounted` rows landed with a null agent because nothing
     * ever set it.
     */
    agentId?: string | undefined;
    usage: Usage;
    /** Usage contributed by this one accounting call (not cumulative). */
    deltaUsage?: Usage | undefined;
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
    /** Concurrent-subagent ceiling (issue #323). */
    maxConcurrent?: number | undefined;
    /** Lifetime spawn budget snapshot (issue #323). */
    maxSpawns?: number | undefined;
    usedSpawns?: number | undefined;
    remainingSpawns?: number | undefined;
    effectiveSource?: string | undefined;
    checkpointMaxSpawns?: number | undefined;
    ceilingMismatch?: boolean | undefined;
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

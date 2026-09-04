/**
 * AutonomyBrain — a self-driving decision layer for autonomous workflows.
 *
 * Unlike the standard BrainArbiter which asks the human when uncertain,
 * AutonomyBrain makes decisions autonomously within configured risk
 * boundaries, keeping the system running unattended. It uses the session
 * LLM to evaluate situations and produce decisions.
 *
 * ## Identity
 * The AutonomyBrain is NOT the main agent. It is a dedicated decision
 * engine with a single purpose: evaluate blocked/stuck situations in
 * autonomous workflows and decide whether to continue, pivot, or stop.
 *
 * ## Decision Flow
 * 1. RISK GATE — if request risk > maxAutoRisk, auto-deny
 * 2. HEURISTIC — fast pattern-match for common situations (deadlock, retry-exhausted)
 * 3. LLM EVALUATION — complex decisions (goal completion, conflict resolution)
 *
 * ## Decision Logging
 * Every decision is emitted via `onDecision` callback with a human-readable
 * summary suitable for chat history and journal entries.
 */

import {
  BRAIN_RISK_LEVELS,
  type BrainArbiter,
  type BrainDecision,
  type BrainDecisionRequest,
} from '../coordination/brain.js';
import {
  type BrainHeuristicsConfig,
  COMPETING_ALTERNATIVE,
  isBlockedResolved,
  resolveBrainHeuristics,
} from '../coordination/brain-heuristics.js';
import { markDecisionTier } from '../coordination/brain-telemetry.js';
import type { EventBus } from '../kernel/events.js';
import type { Provider } from '../types/provider.js';
import {
  type BrainLlmTarget,
  buildBrainUserMessage,
  completeBrainLlm,
  completeBrainLlmDetailed,
  DEFAULT_BRAIN_MAX_TOKENS,
  DEFAULT_BRAIN_TIMEOUT_MS,
  extractConfidence,
  isNonAnswer,
  llmDecide,
  markDenyKind,
  parseFreeTextDecision,
  parseOptionDecision,
  readLlmDenyKind,
  withDecisionDigest,
} from './autonomy-brain-llm.js';
import type { BrainCircuitBreaker } from './brain-circuit.js';

export type { BrainLlmTarget };
export {
  buildBrainUserMessage,
  completeBrainLlm,
  completeBrainLlmDetailed,
  DEFAULT_BRAIN_MAX_TOKENS,
  extractConfidence,
  isNonAnswer,
  parseFreeTextDecision,
  parseOptionDecision,
  readLlmDenyKind,
  withDecisionDigest,
};

export interface AutonomyBrainOptions {
  /** LLM provider for decision-making. Ignored when `targets` is non-empty. */
  provider?: Provider | undefined;
  /** Model to use for decisions (should be fast + cheap). Ignored when `targets` is non-empty. */
  model?: string | undefined;
  /**
   * Ordered LLM pool. With `strategy: 'fallback'` (default) the first target
   * is primary and later ones are tried in order when a call fails/times
   * out; with 'round-robin' successive decisions rotate the starting target.
   * At least one of `targets` / (`provider` + `model`) must be provided.
   */
  targets?: BrainLlmTarget[] | undefined;
  /** Pool selection strategy. Default 'fallback'. */
  strategy?: 'fallback' | 'round-robin' | undefined;
  /** Maximum risk level the brain will auto-decide. Default: 'high'.
   *  'low'    — only auto-decide low-risk questions
   *  'medium' — auto-decide low/medium
   *  'high'   — auto-decide low/medium/high
   *  'all'    — auto-decide everything (including critical)
   */
  maxAutoRisk?: 'low' | 'medium' | 'high' | 'all' | undefined;
  /** Timeout for each decision call (ms). Default: 15_000. */
  decisionTimeoutMs?: number | undefined;
  /** Per-heuristic toggles for `quickDecide`. Omitted fields default to enabled. */
  heuristics?: BrainHeuristicsConfig | undefined;
  /**
   * Bus for `brain.llm_call` trace events — one per pool target per decision,
   * including the failures the fallback loop otherwise swallows.
   */
  events?: EventBus | undefined;
  /** Include raw response text in trace events. Off by default (production content). */
  traceContent?: boolean | undefined;
  /** Output budget per decision call. Default `DEFAULT_BRAIN_MAX_TOKENS` (200). */
  maxTokens?: number | undefined;
  /**
   * Reject responses in which the model declined to decide ("I don't know",
   * "insufficient evidence", empty text) instead of presenting them as an
   * answer. Default true — an empty or hedging response is not a decision.
   */
  rejectUncertain?: boolean | undefined;
  /**
   * Reject answers whose self-reported `confidence` is below this (0..1).
   * Default 0 = off. Responses that report no confidence are never rejected
   * by this gate.
   */
  minConfidence?: number | undefined;
  /**
   * Failure memory for the pool. When the breaker is open the tier is skipped
   * outright instead of paying `pool.length × decisionTimeoutMs` again for a
   * conclusion the previous decision already reached.
   */
  circuit?: BrainCircuitBreaker | undefined;
  /**
   * Decision-history digest for the LLM prompt (typically
   * `BrainDecisionLedger.digestFor`): how similar past decisions went and
   * how they turned out. Appended to the user message when non-empty.
   */
  getDecisionDigest?: ((request: BrainDecisionRequest) => string | undefined) | undefined;
  /**
   * Called after every decision with a human-readable summary.
   * Use this to log decisions into chat history, journal, or status line.
   * Example: "🧠 Brain: skipped deadlocked tasks → continuing with phase 3/5"
   */
  onDecision?:
    | ((summary: string, decision: BrainDecision, request: BrainDecisionRequest) => void)
    | undefined;
}

const RISK_LEVELS = BRAIN_RISK_LEVELS;

/** Runtime-adjustable autonomy ceiling for the tiered brain. */
export type BrainAutoRisk = 'off' | 'low' | 'medium' | 'high' | 'all';

/**
 * Resolve an autonomy ceiling to a level comparable against `RISK_LEVELS`.
 */
export function resolveRiskCeiling(ceiling: BrainAutoRisk | undefined): number {
  if (ceiling === 'off') return -1;
  if (ceiling === 'all') return 3;
  return RISK_LEVELS[ceiling ?? 'medium'] ?? 1;
}

export interface TieredBrainArbiterOptions {
  /** Fast deterministic policy layer (DefaultBrainArbiter). Consulted first. */
  policy: BrainArbiter;
  /** LLM-backed autonomous layer (createAutonomyBrain). Consulted when the
   *  policy layer would escalate to the human and the request's risk is
   *  within the live ceiling. */
  autonomous?: BrainArbiter | undefined;
  /**
   * Live autonomy ceiling — read on EVERY decision so `/brain risk <level>`
   * changes take effect immediately. 'off' disables the autonomous layer
   * entirely (everything the policy can't answer goes to the human).
   */
  getMaxAutoRisk?: (() => BrainAutoRisk) | undefined;
  /**
   * Multi-LLM council (createCouncilBrainArbiter). When present, requests at
   * or above the council risk floor are decided by the council INSTEAD of
   * the single-LLM layer. Council answers AND denies are terminal — a panel
   * that considered the question and refused is a real decision, not a
   * failure. Only `ask_human` (quorum not met / judge unavailable) falls
   * through to the escalation tier.
   */
  council?: BrainArbiter | undefined;
  /** Live council risk floor. Default 'high'. Read on every decision. */
  getCouncilMinRisk?: (() => 'medium' | 'high' | 'critical') | undefined;
  /**
   * Whether an LLM-tier `deny` ends the decision. Read per decision.
   * Default 'never' — see `BrainConfig.llm.denyIsTerminal`.
   */
  getDenyIsTerminal?: (() => 'never' | 'when-decided' | 'always') | undefined;
  /**
   * Bus for `brain.tier_transition` events — one per tier the ladder ran,
   * recording what it returned and why the chain did or did not stop there.
   * Without it a decision's path through the ladder is unrecoverable.
   */
  events?: EventBus | undefined;
}

/**
 * The standard Brain positioning: policy first, LLM/council second,
 * escalation last.
 */
export function createTieredBrainArbiter(opts: TieredBrainArbiterOptions): BrainArbiter {
  const trace = (
    request: BrainDecisionRequest,
    tier: 'policy' | 'council' | 'llm',
    outcome: 'answer' | 'deny' | 'ask_human' | 'error' | 'skipped',
    terminal: boolean,
    startedAt: number,
    reason?: string,
  ): void => {
    opts.events?.emit('brain.tier_transition', {
      sessionId: request.sessionId,
      requestId: request.id,
      tier,
      outcome,
      terminal,
      ...(reason ? { reason } : {}),
      durationMs: Date.now() - startedAt,
      at: Date.now(),
    });
  };

  return {
    async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
      const policyAt = Date.now();
      const policyDecision = await opts.policy.decide(request);
      const provisionalContinue =
        policyDecision.type === 'answer' &&
        policyDecision.optionId === undefined &&
        request.fallback === 'continue';
      if (policyDecision.type !== 'ask_human' && !provisionalContinue) {
        trace(request, 'policy', policyDecision.type, true, policyAt);
        return policyDecision;
      }
      trace(
        request,
        'policy',
        policyDecision.type,
        false,
        policyAt,
        provisionalContinue
          ? 'provisional continue — forwarded for a real judgement'
          : 'policy escalated',
      );

      const ceilingLevel = resolveRiskCeiling(opts.getMaxAutoRisk?.() ?? 'medium');
      const requestLevel = RISK_LEVELS[request.risk] ?? 2;
      if (requestLevel > ceilingLevel) {
        trace(
          request,
          'llm',
          'skipped',
          false,
          policyAt,
          `risk ${request.risk} exceeds the autonomy ceiling`,
        );
        return policyDecision;
      }

      if (opts.council) {
        const floor = opts.getCouncilMinRisk?.() ?? 'high';
        const floorLevel = RISK_LEVELS[floor] ?? 2;
        if (requestLevel >= floorLevel) {
          const councilAt = Date.now();
          try {
            const councilDecision = await opts.council.decide(request);
            if (councilDecision.type !== 'ask_human') {
              markDecisionTier(request, 'council');
              trace(request, 'council', councilDecision.type, true, councilAt);
              return councilDecision;
            }
            trace(request, 'council', 'ask_human', false, councilAt, 'council abstained');
          } catch (err) {
            trace(
              request,
              'council',
              'error',
              false,
              councilAt,
              err instanceof Error ? err.message : String(err),
            );
          }
        } else {
          trace(
            request,
            'council',
            'skipped',
            false,
            policyAt,
            `risk ${request.risk} below the council floor`,
          );
        }
      }

      if (!opts.autonomous) {
        trace(request, 'llm', 'skipped', false, policyAt, 'no LLM tier configured');
        return policyDecision;
      }
      const llmAt = Date.now();
      try {
        const llmDecision = await opts.autonomous.decide(request);
        if (llmDecision.type === 'answer') {
          trace(request, 'llm', 'answer', true, llmAt);
          return llmDecision;
        }
        if (llmDecision.type === 'deny') {
          const policy = opts.getDenyIsTerminal?.() ?? 'never';
          const kind = readLlmDenyKind(llmDecision);
          const terminal = policy === 'always' || (policy === 'when-decided' && kind === undefined);
          if (terminal) {
            markDecisionTier(request, 'llm');
            trace(request, 'llm', 'deny', true, llmAt, `denyIsTerminal: ${policy}`);
            return llmDecision;
          }
        }
        trace(request, 'llm', llmDecision.type, false, llmAt, 'non-answer discarded by the ladder');
      } catch (err) {
        trace(
          request,
          'llm',
          'error',
          false,
          llmAt,
          err instanceof Error ? err.message : String(err),
        );
      }
      markDecisionTier(request, 'policy');
      return policyDecision;
    },
  };
}

/**
 * Create a self-driving brain that makes autonomous decisions.
 * Never asks the human — within its risk boundary it answers, above it denies.
 */
export function createAutonomyBrain(opts: AutonomyBrainOptions): BrainArbiter {
  const maxRisk = opts.maxAutoRisk ?? 'high';
  const maxRiskLevel = resolveRiskCeiling(maxRisk);
  const timeoutMs = opts.decisionTimeoutMs ?? DEFAULT_BRAIN_TIMEOUT_MS;
  const targets: BrainLlmTarget[] =
    opts.targets && opts.targets.length > 0
      ? opts.targets
      : opts.provider && opts.model
        ? [{ provider: opts.provider, model: opts.model }]
        : [];
  if (targets.length === 0) {
    throw new Error('createAutonomyBrain: provide `targets` or `provider` + `model`.');
  }
  const strategy = opts.strategy ?? 'fallback';
  let rrCursor = 0;

  return {
    async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
      const requestLevel = RISK_LEVELS[request.risk] ?? 2;

      if (requestLevel > maxRiskLevel) {
        const reason = `Auto-denied: risk "${request.risk}" exceeds max "${maxRisk}"`;
        const decision: BrainDecision = { type: 'deny', reason };
        opts.onDecision?.(
          `🧠 Brain: DENIED — ${request.question.slice(0, 80)} (risk: ${request.risk} > ${maxRisk})`,
          decision,
          request,
        );
        return decision;
      }

      const heuristic = quickDecide(request, opts.heuristics);
      if (heuristic) {
        markDecisionTier(request, 'heuristic');
        opts.onDecision?.(formatDecisionSummary(heuristic, request), heuristic, request);
        return heuristic;
      }

      if (opts.circuit && !opts.circuit.shouldAttempt()) {
        const decision = markDenyKind(
          {
            type: 'deny',
            reason: 'Autonomy Brain LLM tier is circuit-broken after repeated failures.',
          },
          'unavailable',
        );
        opts.onDecision?.(formatDecisionSummary(decision, request), decision, request);
        return decision;
      }

      let start = 0;
      if (strategy === 'round-robin') {
        start = rrCursor;
        rrCursor = (rrCursor + 1) % targets.length;
      }
      const rotated = [...targets.slice(start), ...targets.slice(0, start)];
      const ordered = opts.circuit
        ? opts.circuit.orderTargets(rotated, (t) => t.label ?? t.model)
        : rotated;
      const digest = opts.getDecisionDigest?.(request);
      const llmDecision = await llmDecide(
        request,
        ordered,
        timeoutMs,
        digest,
        opts.events ? { events: opts.events, content: opts.traceContent === true } : undefined,
        opts.maxTokens,
        {
          rejectUncertain: opts.rejectUncertain ?? true,
          minConfidence: opts.minConfidence ?? 0,
        },
        opts.circuit,
      );
      markDecisionTier(request, 'llm');
      opts.onDecision?.(formatDecisionSummary(llmDecision, request), llmDecision, request);
      return llmDecision;
    },
  };
}

/**
 * Format a decision as a human-readable one-liner for chat history.
 */
export function formatDecisionSummary(
  decision: BrainDecision,
  request: BrainDecisionRequest,
): string {
  const question =
    request.question.length > 80 ? request.question.slice(0, 77) + '…' : request.question;

  if (decision.type === 'deny') {
    return `🧠 Brain: DENIED — "${question}" → ${decision.reason}`;
  }

  if (decision.type === 'answer') {
    const action = decision.optionId
      ? `chose [${decision.optionId}]`
      : decision.text.length > 60
        ? decision.text.slice(0, 57) + '…'
        : decision.text;
    return `🧠 Brain: DECIDED — "${question}" → ${action}`;
  }

  return `🧠 Brain: ASKED HUMAN — "${question}"`;
}

/**
 * Fast heuristic decisions that don't need an LLM call.
 */
export function quickDecide(
  request: BrainDecisionRequest,
  heuristics?: BrainHeuristicsConfig | undefined,
): BrainDecision | null {
  if (request.options?.length) return null;

  const h = resolveBrainHeuristics(heuristics);
  const q = request.question.toLowerCase();
  const ctx = request.context?.toLowerCase() ?? '';

  if (
    h.deadlockSkip &&
    q.includes('deadlock') &&
    /\bfailed\s+(?:task|step|job|build|test|phase|stage|item|unit)s?\b/.test(ctx)
  ) {
    return {
      type: 'answer',
      text: 'Skip deadlocked tasks and continue with remaining work. Failed tasks will be reported in the final summary.',
      rationale:
        'Heuristic: deadlocked tasks blocked by failed dependencies — skipping unblocks remaining work.',
    };
  }

  if (
    h.retryExhausted &&
    (q.includes('failed') || q.includes('retry')) &&
    (/\bexhausted\b/.test(ctx) ||
      /\b(?:[3-9]|\d{2,})\s+(?:consecutive\s+)?(?:times|attempts|retries|failures)\b/.test(ctx) ||
      /\b(?:attempt|retr(?:y|ies)|failure)s?\W{0,3}(?:[3-9]|\d{2,})\b/.test(ctx))
  ) {
    return {
      type: 'answer',
      text: 'Mark as failed and move on. Note the failure for the final report.',
      rationale: 'Heuristic: retries exhausted — continuing would waste resources.',
    };
  }

  if (
    h.blockedResolved &&
    request.fallback === 'continue' &&
    isBlockedResolved(q, ctx, h.blockedResolvedMarkers)
  ) {
    return {
      type: 'answer',
      text: 'Blocker resolved. Continue with the previously blocked work.',
      rationale: 'Heuristic: blocking dependency explicitly resolved — resuming.',
    };
  }

  if (q.includes('goal complete') || q.includes('mission complete')) {
    return null;
  }

  if (
    h.continuePing &&
    request.fallback === 'continue' &&
    /\b(?:continue|proceed)\b/.test(q) &&
    !/\b(?:stop|abort|halt|cancel|pause|rollback)\b/.test(q) &&
    !COMPETING_ALTERNATIVE.test(q)
  ) {
    return {
      type: 'answer',
      text: 'Continue execution. Do not stop.',
      rationale: 'Heuristic: autonomy mode — continue until all work is complete.',
    };
  }

  return null;
}

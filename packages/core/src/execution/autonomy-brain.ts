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
} from '../brain/brain.js';

import {
  type BrainAutoRisk,
  brainTierEligibility,
  resolveRiskCeiling,
} from '../brain/brain-risk.js';

export { type BrainAutoRisk, resolveRiskCeiling } from '../brain/brain-risk.js';

import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { Provider } from '@wrongstack/contracts/types/provider';
import type { BrainHeuristicsConfig } from '../brain/brain-heuristics.js';
import { evaluateQuickBrainDecision } from '../brain/brain-quick-decision.js';
import {
  type BrainDecisionTier,
  markDecisionTier,
  readDecisionTier,
} from '../brain/brain-telemetry.js';
import {
  type BrainLlmTarget,
  buildBrainUserMessage,
  completeBrainLlm,
  completeBrainLlmDetailed,
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
import type { SystemOneBrainTier } from './brain-system-one.js';

export type { BrainLlmTarget };
export {
  buildBrainUserMessage,
  completeBrainLlm,
  completeBrainLlmDetailed,
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
  /** Output cap per decision call. Unset = the model's own output ceiling. */
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
   * TypeSafe System One tier (`createSystemOneBrainTier`). Consulted before
   * the council/LLM tiers for option-bearing requests BELOW the council floor
   * (or at most `medium` with no council). It only settles decisions it is
   * sure of; `null` lets the ladder continue unchanged.
   */
  systemOne?: SystemOneBrainTier | undefined;
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
    tier: BrainDecisionTier,
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
      const policyTier = readDecisionTier(request) ?? 'policy';
      const provisionalContinue =
        policyDecision.type === 'answer' &&
        policyDecision.optionId === undefined &&
        request.fallback === 'continue';
      if (policyDecision.type !== 'ask_human' && !provisionalContinue) {
        trace(request, policyTier, policyDecision.type, true, policyAt);
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

      const eligible = brainTierEligibility(
        request,
        opts.getMaxAutoRisk?.() ?? 'medium',
        !!opts.council,
        opts.getCouncilMinRisk?.() ?? 'high',
      );
      if (!eligible.autonomous) {
        trace(
          request,
          'llm',
          'skipped',
          false,
          policyAt,
          `risk ${request.risk} exceeds the autonomy ceiling`,
        );
        if (policyDecision.type !== 'ask_human')
          trace(request, policyTier, policyDecision.type, true, policyAt);
        return policyDecision;
      }

      if (opts.systemOne && request.options && request.options.length > 1) {
        const floor = opts.council ? (opts.getCouncilMinRisk?.() ?? 'high') : 'high';
        const systemOneAt = Date.now();
        if (eligible.systemOne) {
          const decision = await opts.systemOne.decide(request);
          if (decision) {
            markDecisionTier(request, 'system-one');
            trace(request, 'system-one', decision.type, true, systemOneAt);
            return decision;
          }
          trace(request, 'system-one', 'skipped', false, systemOneAt, 'not confident; deferred');
        } else {
          trace(
            request,
            'system-one',
            'skipped',
            false,
            systemOneAt,
            `risk ${request.risk} at or above the ${floor} floor`,
          );
        }
      }

      if (opts.council) {
        if (eligible.council) {
          const councilAt = Date.now();
          try {
            const councilDecision = await opts.council.decide(request);
            if (councilDecision.type !== 'ask_human') {
              markDecisionTier(request, 'council');
              trace(request, 'council', councilDecision.type, true, councilAt);
              return councilDecision;
            }
            trace(request, 'council', 'ask_human', false, councilAt, 'council abstained');
            if (request.risk === 'critical') return councilDecision;
          } catch (err) {
            trace(
              request,
              'council',
              'error',
              false,
              councilAt,
              err instanceof Error ? err.message : String(err),
            );
            if (request.risk === 'critical') {
              return {
                type: 'ask_human',
                prompt: `Critical council decision could not be resolved: ${request.question}`,
                options: request.options,
              };
            }
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
        if (policyDecision.type !== 'ask_human')
          trace(request, policyTier, policyDecision.type, true, policyAt);
        return policyDecision;
      }
      const llmAt = Date.now();
      try {
        const llmDecision = await opts.autonomous.decide(request);
        if (llmDecision.type === 'answer') {
          trace(request, readDecisionTier(request) ?? 'llm', 'answer', true, llmAt);
          return llmDecision;
        }
        if (llmDecision.type === 'deny') {
          const policy = opts.getDenyIsTerminal?.() ?? 'never';
          const kind = readLlmDenyKind(llmDecision);
          const terminal =
            policy === 'always' ||
            (policy === 'when-decided' && (kind === undefined || kind === 'refused'));
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
      markDecisionTier(request, policyTier);
      if (policyDecision.type !== 'ask_human')
        trace(request, policyTier, policyDecision.type, true, policyAt);
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
  heuristics?: BrainHeuristicsConfig,
): BrainDecision | null {
  return evaluateQuickBrainDecision(request, heuristics);
}

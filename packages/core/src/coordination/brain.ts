/**
 * Brain coordination primitives.
 *
 * Brain is an authority layer above a leader/director but below the human. It is
 * intentionally modeled as a decision interface first, not as an autonomous
 * bypass: callers ask for a decision, Brain either answers within policy or
 * escalates to the human.
 */

import type { EventBus } from '../kernel/events.js';
import {
  type BrainHeuristicsConfig,
  isBlockedResolved,
  type ResolvedBrainHeuristics,
  resolveBrainHeuristics,
} from './brain-heuristics.js';
import { emitBrainTierTransition, markDecisionTier, readDecisionTier } from './brain-telemetry.js';

export type BrainDecisionSource = 'goal' | 'director' | 'tool' | 'user' | 'system';

export type BrainRisk = 'low' | 'medium' | 'high' | 'critical';

/**
 * Canonical ordering of request risk, lowest first. The single source of
 * truth for every risk comparison in the Brain (tier ceilings, council
 * floors, rule `minRisk`/`maxRisk` bounds) — keeping it here, next to the
 * type it orders, stops the ladders from drifting apart.
 *
 * Typed as `Record<string, number>` on purpose: callers index it with values
 * that arrive from config/JSON and may not be valid `BrainRisk` members, and
 * are expected to supply their own `?? default` for that case.
 */
export const BRAIN_RISK_LEVELS: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export type BrainFallback = 'ask_human' | 'deny' | 'continue';

export interface BrainDecisionOption {
  id: string;
  label: string;
  consequence?: string | undefined;
  risk?: BrainRisk | undefined;
  recommended?: boolean | undefined;
}

export interface BrainDecisionRequest {
  id: string;
  /** Active host session id for surfaces that multiplex multiple sessions. */
  sessionId?: string | undefined;
  source: BrainDecisionSource;
  question: string;
  context?: string | undefined;
  options?: BrainDecisionOption[] | undefined;
  risk: BrainRisk;
  /** What a non-LLM/default Brain should do when policy cannot decide safely. */
  fallback: BrainFallback;
}

export type BrainDecision =
  | {
      type: 'answer';
      optionId?: string | undefined;
      text: string;
      rationale?: string | undefined;
    }
  | {
      type: 'ask_human';
      prompt: string;
      options?: BrainDecisionOption[] | undefined;
      rationale?: string | undefined;
    }
  | {
      type: 'deny';
      reason: string;
    };

export interface BrainArbiter {
  decide(request: BrainDecisionRequest): Promise<BrainDecision>;
}

/**
 * Event-emitting decorator for any Brain implementation. Hosts wire this around
 * their actual arbiter so TUI/session surfaces can render Brain decisions
 * without coupling to the caller that requested the decision.
 */
export class ObservableBrainArbiter implements BrainArbiter {
  constructor(
    private readonly inner: BrainArbiter,
    private readonly events: EventBus,
  ) {}

  async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
    this.events.emit('brain.decision_requested', {
      sessionId: request.sessionId,
      request,
      at: Date.now(),
    });
    const decision = await this.inner.decide(request);
    const event =
      decision.type === 'ask_human'
        ? 'brain.decision_ask_human'
        : decision.type === 'deny'
          ? 'brain.decision_denied'
          : 'brain.decision_answered';
    // Provenance is recorded inside the chain (this decorator sits outside
    // it), so surfaces can tell a free deterministic answer from one that
    // cost a council/LLM call. Optional: chains that predate the marking, or
    // arbiters wired directly, simply report no tier.
    const tier = readDecisionTier(request);
    this.events.emit(event, {
      sessionId: request.sessionId,
      request,
      decision,
      at: Date.now(),
      ...(tier ? { tier } : {}),
    });
    return decision;
  }
}

interface BrainDecisionQueueOptions {
  /** Safety fallback if the human never answers. Default: no timeout. */
  timeoutMs?: number | undefined;
  /**
   * Decision to resolve with when the timeout fires. Default: deny.
   * Headless-leaning hosts pass `terminalPolicyDecision` here so an
   * unanswered prompt degrades to the safe default instead of a bare deny.
   */
  onTimeout?: ((request: BrainDecisionRequest) => BrainDecision) | undefined;
}

/**
 * Bridge between an `ask_human` Brain decision and the UI. It emits the visible
 * ask-human event, then resolves when the TUI emits `brain.human_answered`.
 */
export class BrainDecisionQueue {
  private readonly pending = new Map<
    string,
    {
      request: BrainDecisionRequest;
      resolve: (decision: BrainDecision) => void;
      /** When the human was asked — the start of the `human`/`terminal` step. */
      askedAt: number;
      timer?: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  private readonly offAnswer: () => void;

  constructor(
    private readonly events: EventBus,
    private readonly opts: BrainDecisionQueueOptions = {},
  ) {
    this.offAnswer = this.events.on('brain.human_answered', (answer) => {
      const pending = this.pending.get(answer.id);
      if (!pending) return;
      this.pending.delete(answer.id);
      if (pending.timer) clearTimeout(pending.timer);
      markDecisionTier(pending.request, 'human');
      if (answer.deny) {
        emitBrainTierTransition(
          this.events,
          pending.request,
          'human',
          'deny',
          true,
          pending.askedAt,
        );
        pending.resolve({ type: 'deny', reason: answer.text ?? 'Denied by human.' });
        return;
      }
      emitBrainTierTransition(
        this.events,
        pending.request,
        'human',
        'answer',
        true,
        pending.askedAt,
      );
      const option = pending.request.options?.find((o) => o.id === answer.optionId);
      pending.resolve({
        type: 'answer',
        optionId: answer.optionId,
        text: answer.text ?? option?.label ?? answer.optionId ?? 'Human answered.',
        rationale: 'Human answered a Brain escalation prompt.',
      });
    });
  }

  async requestHumanDecision(request: BrainDecisionRequest): Promise<BrainDecision> {
    const ask: BrainDecision = {
      type: 'ask_human',
      prompt: formatHumanPrompt(request),
      options: request.options,
      rationale: 'Decision escalated to human authority.',
    };
    const askedAt = Date.now();
    const pending = new Promise<BrainDecision>((resolve) => {
      const entry: {
        request: BrainDecisionRequest;
        resolve: (decision: BrainDecision) => void;
        askedAt: number;
        timer?: ReturnType<typeof setTimeout> | undefined;
      } = { request, resolve, askedAt };
      if (this.opts.timeoutMs && this.opts.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(request.id);
          // Nobody answered — this resolves through the terminal policy, not
          // through human authority.
          markDecisionTier(request, 'terminal');
          const timedOut = this.opts.onTimeout?.(request) ?? {
            type: 'deny' as const,
            reason: 'Brain human decision timed out.',
          };
          emitBrainTierTransition(
            this.events,
            request,
            'terminal',
            timedOut.type,
            true,
            askedAt,
            `no human answer within ${this.opts.timeoutMs}ms`,
          );
          resolve(timedOut);
        }, this.opts.timeoutMs);
      }
      this.pending.set(request.id, entry);
    });
    // `pending: true` marks this as the PROMPT, not the resolution. The same
    // event name carries both: `ObservableBrainArbiter` emits it when
    // ask_human is the FINAL decision (nothing escalated it), and this queue
    // emits it when a human is being asked and the decision is still open.
    // Consumers that log activity (ledger, decision ring, Chronicle) want
    // both; consumers that close a per-decision record — the trace recorder —
    // must ignore this one or they file the decision before the human answers
    // and drop the answer entirely.
    this.events.emit('brain.decision_ask_human', {
      sessionId: request.sessionId,
      request,
      decision: ask,
      at: Date.now(),
      pending: true,
    });
    return pending;
  }

  dispose(): void {
    this.offAnswer();
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ type: 'deny', reason: 'Brain decision queue disposed.' });
      this.pending.delete(id);
    }
  }
}

/** Escalation routing for the outermost Brain tier. See `EscalationRoutingBrainArbiter`. */
export type BrainEscalationMode = 'interactive' | 'headless';

/**
 * Resolve an `ask_human` escalation WITHOUT a human — the terminal policy of
 * a headless Brain. The ladder is deliberately conservative:
 *
 *   1. A caller-recommended option at low/medium request risk is chosen —
 *      the caller already declared it the safe default.
 *   2. `fallback: 'continue'` requests continue (the caller stated that
 *      continuing is the safe default when nobody can decide).
 *   3. Everything else is denied. Denial is always safe by contract: every
 *      Brain call site treats deny as "do not take the proposed action".
 *
 * The rationale names the terminal policy so decision logs/ledgers make the
 * degradation visible instead of silent.
 */
export type BrainTerminalPolicy = 'conservative' | 'deny-all' | 'continue-on-recommended';

export function terminalPolicyDecision(
  request: BrainDecisionRequest,
  policy: BrainTerminalPolicy = 'conservative',
): BrainDecision {
  if (policy === 'deny-all') {
    return {
      type: 'deny',
      reason:
        `Headless terminal policy "deny-all": "${request.question}" was not auto-approved ` +
        '(risk: ' +
        request.risk +
        '). The proposed action was not taken.',
    };
  }
  const recommended = request.options?.find((option) => option.recommended);
  const acceptRecommended =
    recommended !== undefined &&
    (policy === 'continue-on-recommended' || request.risk === 'low' || request.risk === 'medium');
  if (recommended && acceptRecommended) {
    return {
      type: 'answer',
      optionId: recommended.id,
      text: recommended.label,
      rationale:
        'Headless terminal policy: caller-recommended option accepted at ' +
        `${request.risk} risk (no human available by configuration).`,
    };
  }
  if (request.fallback === 'continue') {
    return {
      type: 'answer',
      text: 'Continue with the caller default.',
      rationale: 'Headless terminal policy: request declares continue as its safe fallback.',
    };
  }
  return {
    type: 'deny',
    reason:
      `Headless terminal policy: no safe automatic option for "${request.question}" ` +
      `(risk: ${request.risk}). The proposed action was not taken.`,
  };
}

/**
 * Outermost escalation tier that never lets an `ask_human` decision leak to
 * the caller. Routing is read PER DECISION so `/brain mode` switches apply
 * live:
 *
 *   - 'interactive' (and a queue is wired) → prompt the human via the
 *     `BrainDecisionQueue`, exactly like `HumanEscalatingBrainArbiter`.
 *   - 'headless' (or no queue) → resolve through `terminalPolicyDecision`.
 *
 * This is the layer that makes a fully unattended Brain possible: with mode
 * 'headless' every decision terminates in answer/deny, never in a blocking
 * prompt.
 */
export class EscalationRoutingBrainArbiter implements BrainArbiter {
  constructor(
    private readonly inner: BrainArbiter,
    private readonly queue: BrainDecisionQueue | undefined,
    private readonly getMode: () => BrainEscalationMode,
    /** Live terminal-policy variant, read per decision. Default 'conservative'. */
    private readonly getTerminalPolicy?: () => BrainTerminalPolicy,
    /**
     * Bus for the `terminal` ladder step. Optional so hosts that predate it
     * keep working — they simply record no step for the headless outcome.
     */
    private readonly events?: EventBus,
  ) {}

  async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
    const decision = await this.inner.decide(request);
    if (decision.type !== 'ask_human') return decision;
    if (this.getMode() === 'interactive' && this.queue) {
      return this.queue.requestHumanDecision(request);
    }
    const startedAt = Date.now();
    markDecisionTier(request, 'terminal');
    const policy = this.getTerminalPolicy?.() ?? 'conservative';
    const terminal = terminalPolicyDecision(request, policy);
    emitBrainTierTransition(
      this.events,
      request,
      'terminal',
      terminal.type,
      true,
      startedAt,
      `headless terminal policy "${policy}" — no human available`,
    );
    return terminal;
  }
}

/**
 * Decorator that turns `ask_human` into an actual awaited human decision.
 * The wrapped Brain remains policy-only; this layer owns the UI/event bridge.
 */
export class HumanEscalatingBrainArbiter implements BrainArbiter {
  constructor(
    private readonly inner: BrainArbiter,
    private readonly queue: BrainDecisionQueue,
  ) {}

  async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
    const decision = await this.inner.decide(request);
    if (decision.type !== 'ask_human') return decision;
    return this.queue.requestHumanDecision(request);
  }
}

export interface DefaultBrainArbiterOptions {
  /**
   * Allow deterministic auto-answering for low-risk requests. Default true.
   * @deprecated Prefer `heuristics.lowRiskAutoAnswer`; this still wins when set.
   */
  allowLowRiskAutoAnswer?: boolean | undefined;
  /** Per-heuristic toggles. Omitted fields default to enabled. */
  heuristics?: BrainHeuristicsConfig | undefined;
}

/**
 * Conservative deterministic Brain implementation.
 *
 * It only auto-answers low-risk requests when the caller provided a recommended
 * option. Everything else follows the request fallback. This gives hosts a safe
 * policy object to wire before an LLM-backed Brain exists.
 */
export class DefaultBrainArbiter implements BrainArbiter {
  private readonly heuristics: ResolvedBrainHeuristics;

  constructor(opts: DefaultBrainArbiterOptions = {}) {
    const resolved = resolveBrainHeuristics(opts.heuristics);
    // The legacy standalone flag still wins when explicitly passed, so hosts
    // that predate `heuristics` keep their behaviour.
    this.heuristics = {
      ...resolved,
      lowRiskAutoAnswer: opts.allowLowRiskAutoAnswer ?? resolved.lowRiskAutoAnswer,
    };
  }

  async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
    const recommended = request.options?.find((option) => option.recommended);
    if (this.heuristics.lowRiskAutoAnswer && request.risk === 'low' && recommended) {
      markDecisionTier(request, 'heuristic');
      return {
        type: 'answer',
        optionId: recommended.id,
        text: recommended.label,
        rationale: 'Low-risk request with an explicit recommended option.',
      };
    }

    // Blocked dependency explicitly resolved → continue. Uses the shared
    // heuristic from brain-heuristics.ts (same pattern as quickDecide in
    // autonomy-brain.ts). Requires the caller to have declared continue safe
    // AND explicit resolution evidence in the context. Skips option-bearing
    // requests (options are control-plane input demanding a structured
    // choice, not a keyword guess — same discipline as quickDecide).
    if (
      this.heuristics.blockedResolved &&
      !request.options?.length &&
      request.fallback === 'continue' &&
      request.context
    ) {
      if (
        isBlockedResolved(
          request.question.toLowerCase(),
          request.context.toLowerCase(),
          this.heuristics.blockedResolvedMarkers,
        )
      ) {
        markDecisionTier(request, 'heuristic');
        return {
          type: 'answer',
          text: 'Blocker resolved. Continue with the previously blocked work.',
          rationale: 'Heuristic: blocking dependency explicitly resolved — resuming.',
        };
      }
    }

    // Fallback semantics. A `continue` answer here is only PROVISIONAL (the
    // tiered arbiter forwards it to the LLM tier), and `ask_human` is always
    // handed onward, so both marks get overwritten by whichever tier actually
    // resolves. Marking anyway keeps the policy visible when no later tier
    // takes over.
    markDecisionTier(request, 'policy');
    switch (request.fallback) {
      case 'deny':
        return {
          type: 'deny',
          reason: `Brain could not safely decide: ${request.question}`,
        };
      case 'continue':
        return {
          type: 'answer',
          text: 'Continue with the caller default.',
          rationale: 'No safe Brain decision was available; request fallback is continue.',
        };
      case 'ask_human':
        return {
          type: 'ask_human',
          prompt: formatHumanPrompt(request),
          options: request.options,
          rationale: 'Decision requires human authority or lacks a safe automatic option.',
        };
      default:
        // Runtime safety: deserialized or unknown fallback defaults to deny
        return {
          type: 'deny',
          reason: `Brain could not safely decide (unknown fallback: ${String(request.fallback)}): ${request.question}`,
        };
    }
  }
}

export function formatHumanPrompt(request: BrainDecisionRequest): string {
  const lines = [
    `Brain requires human decision for ${request.source}:`,
    `Question: ${request.question}`,
  ];
  if (request.context?.trim()) {
    lines.push('', 'Context:', request.context.trim());
  }
  if (request.options?.length) {
    lines.push('', 'Options:');
    for (const option of request.options) {
      const risk = option.risk ? ` [risk: ${option.risk}]` : '';
      const consequence = option.consequence ? ` — ${option.consequence}` : '';
      lines.push(`- ${option.id}: ${option.label}${risk}${consequence}`);
    }
  }
  lines.push('', `Risk: ${request.risk}`);
  return lines.join('\n');
}

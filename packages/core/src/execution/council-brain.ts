/**
 * CouncilBrainArbiter — a multi-LLM decision panel for high-stakes questions.
 *
 * A thin adapter over CouncilOrchestrator. Each CouncilVoter becomes a seat
 * with its OWN Provider via per-seat CouncilLLMCaller, so multi-provider
 * panels work correctly (no voters[0] collapsing).
 *
 * Decision lenses (personas):
 *   - executor — biased toward forward progress; hates stalling.
 *   - skeptic  — hunts for the reason the proposed action is wrong; may veto.
 *   - auditor  — cost/waste/budget lens; hates throwing tokens at dead ends.
 *   - security — examines trust boundaries, abuse cases, security impact.
 *   - maintainer   — evaluates complexity, compatibility, long-term ownership.
 *   - user-advocate — evaluates from the affected user's perspective.
 *
 * @module council-brain
 */

import type {
  BrainArbiter,
  BrainDecision,
  BrainDecisionRequest,
} from '../coordination/brain.js';
import {
  completeBrainLlmDetailed,
  type BrainLlmTarget,
} from './autonomy-brain.js';
import type { EventBus } from '../kernel/events.js';
import { CouncilOrchestrator } from './council-orchestrator.js';
import type { CouncilLLMCaller, CouncilModelTarget, CouncilProfileConfig, CouncilSeatConfig } from '../types/council.js';
import type { OneShotLLMInput, OneShotLLMResult } from '../types/one-shot-llm.js';
import type { Provider } from '../types/provider.js';

/**
 * Refusal option id used by the Brain adapter. Re-exported from the
 * orchestrator so both layers share a single source of truth.
 */
export { COUNCIL_REFUSAL_OPTION_ID as COUNCIL_REFUSE_OPTION_ID } from './council-orchestrator.js';

// ── Config ─────────────────────────────────────────────────────────────────

/** One voting seat on the council. */
export interface CouncilVoter {
  /** Provider instance this voter uses. */
  provider: Provider;
  /** Model id this voter uses. */
  model: string;
  /**
   * Decision lens. Built-ins: 'executor', 'skeptic', 'auditor'. Any other
   * string is injected verbatim as the persona description.
   */
  persona?: string | undefined;
  /** Vote weight. Default 1. */
  weight?: number | undefined;
  /** A refusal from this seat immediately denies the proposal. */
  veto?: boolean | undefined;
  /** Display label for status/logs. Defaults to model. */
  label?: string | undefined;
}

export interface CouncilBrainOptions {
  voters: CouncilVoter[];
  /** Tie-breaker / synthesizer. Default: none (ties call for human). */
  judge?: CouncilVoter | undefined;
  /** Fraction of voters that must vote. Default 0.5. */
  quorumFraction?: number | undefined;
  /** Winning option weight must exceed this fraction. Default 0.5. */
  approvalFraction?: number | undefined;
  /** Per-voter completion timeout in ms. Default 15 000. */
  decisionTimeoutMs?: number | undefined;
  /** Seats polled concurrently, 1..8. Default 3 (the orchestrator's default). */
  maxConcurrency?: number | undefined;
  /** Panel-diversity warning policy. Default 'none'. */
  distinctness?: 'none' | 'model' | 'provider' | undefined;
  /** Output budget for the judge call. */
  judgeMaxTokens?: number | undefined;
  /** Optional digest of past decisions for context. */
  getDecisionDigest?: ((request: BrainDecisionRequest) => string | undefined) | undefined;
  /**
   * Bus for per-seat vote and resolution trace events. Optional: the council
   * decides identically without it, but nothing downstream can reconstruct
   * HOW a panel reached its verdict.
   */
  events?: EventBus | undefined;
  /**
   * Include vote rationales / stances / reasons in the emitted trace events.
   * Off by default — this is production decision content.
   */
  traceContent?: boolean | undefined;
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a council-of-LLMs Brain arbiter backed by CouncilOrchestrator
 * with per-seat LLM callers — each voter's own Provider is used for its
 * seat, avoiding the single-provider collapsing bug.
 */
export function createCouncilBrainArbiter(opts: CouncilBrainOptions): BrainArbiter {
  if (opts.voters.length === 0) {
    throw new Error('createCouncilBrainArbiter: at least one voter is required.');
  }

  // ── Per-seat caller factory ──────────────────────────────────────────
  // Each seat i gets a caller wrapping completeBrainLlm(voter[i], ...).
  function makeSeatCallerForVoter(target: BrainLlmTarget): CouncilLLMCaller {
    return {
      async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
        const startedAt = Date.now();
        try {
          const result = await completeBrainLlmDetailed(
            { provider: target.provider, model: input.model ?? target.model },
            {
              system: typeof input.system === 'string'
                ? input.system
                : Array.isArray(input.system)
                  ? input.system.map((b) => b.text).join('\n')
                  : '',
              user: input.userPrompt ?? '',
              timeoutMs: input.timeoutMs ?? 15_000,
              maxTokens: input.maxTokens,
            },
          );
          // Real usage and timing — these used to be hardcoded zeros, which
          // made `CouncilResult.usage` (and therefore the cost of every
          // council decision) permanently report 0 tokens.
          const inputTokens = result.usage?.input ?? 0;
          const outputTokens = result.usage?.output ?? 0;
          return {
            text: result.text,
            model: target.model,
            provider: target.provider.id,
            tokens: {
              input: inputTokens,
              output: outputTokens,
              total: inputTokens + outputTokens,
            },
            durationMs: Date.now() - startedAt,
            fromFallback: false,
          };
        } catch (error) {
          return {
            text: '',
            model: target.model,
            provider: target.provider.id,
            tokens: { input: 0, output: 0, total: 0 },
            durationMs: 0,
            fromFallback: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
  }

  const seatCaller = (seatIndex: number): CouncilLLMCaller => {
    const voter = opts.voters[seatIndex];
    if (!voter) {
      return {
        async call(_input: OneShotLLMInput): Promise<OneShotLLMResult> {
          return {
            text: '',
            model: '',
            provider: '',
            tokens: { input: 0, output: 0, total: 0 },
            durationMs: 0,
            fromFallback: false,
            error: `No voter at index ${seatIndex}.`,
          };
        },
      };
    }
    return makeSeatCallerForVoter(voter);
  };

  // ── Build a dynamic profile from voters ──────────────────────────────
  const seats: CouncilSeatConfig[] = opts.voters.map((voter, i) => ({
    id: `voter-${i}`,
    label: voter.label ?? voter.model,
    persona: voter.persona ?? 'executor',
    target: {
      providerId: voter.provider.id,
      model: voter.model,
      role: voter.persona ?? 'executor',
    } satisfies CouncilModelTarget,
    weight: voter.weight,
    veto: voter.veto,
  }));

  const judgeTarget = opts.judge
    ? ({
        providerId: opts.judge.provider.id,
        model: opts.judge.model,
        role: 'judge',
      } satisfies CouncilModelTarget)
    : false;

  const profile: CouncilProfileConfig = {
    id: 'brain-council-adapter',
    seats,
    judge: judgeTarget,
    quorumFraction: opts.quorumFraction ?? 0.5,
    approvalFraction: opts.approvalFraction ?? 0.5,
    perCallTimeoutMs: opts.decisionTimeoutMs ?? 15_000,
    ...(opts.judgeMaxTokens !== undefined ? { judgeMaxTokens: opts.judgeMaxTokens } : {}),
    distinctness: opts.distinctness ?? 'none',
  };

  // ── Orchestrator with per-seat callers ───────────────────────────────
  const orchestrator = new CouncilOrchestrator({
    defaultProfile: 'brain-council-adapter',
    // Previously never passed, so the panel was pinned at the orchestrator's
    // default of 3 concurrent seats no matter how many voters were configured.
    ...(opts.maxConcurrency !== undefined ? { maxConcurrency: opts.maxConcurrency } : {}),
    seatCaller,
    judgeCaller: opts.judge
      ? makeSeatCallerForVoter(opts.judge)
      : undefined,
  });

  const abstain = (request: BrainDecisionRequest, why: string): BrainDecision => ({
    type: 'ask_human',
    prompt: `Council abstained (${why}): ${request.question}`,
    options: request.options,
    rationale: `Temporary user escalation because ${why}.`,
  });

  // ── Decide ───────────────────────────────────────────────────────────

  return {
    async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
      const digest = opts.getDecisionDigest?.(request);

      const question = {
        question: request.question,
        context: digest
          ? `${request.context ?? ''}\n\nPrevious decisions:\n${digest}`
          : request.context,
        ...(request.options ? { options: request.options } : {}),
        profile: profile satisfies CouncilProfileConfig,
      };

      const result = await orchestrator.ask(question);

      // ── Trace ────────────────────────────────────────────────────────
      // `CouncilResult` already carries every seat's observable vote, the
      // quorum counts, judge usage and token usage; the adapter used to
      // discard all of it and surface only the verdict. Re-emitting it here
      // needs no orchestrator changes and is what makes a council decision
      // reconstructable.
      if (opts.events) {
        const at = Date.now();
        for (const vote of result.votes) {
          const seat = seats.find((s) => s.id === vote.seatId);
          opts.events.emit('brain.council_vote', {
            sessionId: request.sessionId,
            requestId: request.id,
            seatId: vote.seatId,
            persona: vote.persona,
            status: vote.status,
            providerId: vote.provider,
            model: vote.model,
            optionId: vote.optionId,
            ...(opts.traceContent
              ? { stance: vote.stance, rationale: vote.rationale }
              : {}),
            weight: seat?.weight,
            veto: seat?.veto,
            durationMs: vote.durationMs,
            error: vote.error,
            at,
          });
        }
        opts.events.emit('brain.council_resolved', {
          sessionId: request.sessionId,
          requestId: request.id,
          status: result.status,
          resolution: result.resolution,
          optionId: result.optionId,
          configuredSeatCount: result.configuredSeatCount,
          validVoteCount: result.validVoteCount,
          distinctTargetCount: result.distinctTargetCount,
          judgeUsed: result.judgeUsed,
          usage: result.usage,
          // Structural, not content — always emitted. See the event docs:
          // a correlated panel is the one council failure mode that produces
          // a perfectly normal-looking verdict.
          ...(result.warnings?.length ? { warnings: [...result.warnings] } : {}),
          ...(opts.traceContent ? { reason: result.reason } : {}),
          at,
        });
      }

      // Handle failures and cancellations
      if (result.status === 'cancelled' || result.status === 'failed') {
        return abstain(request, result.reason ?? result.errors?.[0] ?? 'council error');
      }

      if (result.status === 'abstained') {
        return abstain(request, result.reason ?? 'no consensus');
      }

      if (result.status === 'denied') {
        return {
          type: 'deny',
          reason: result.reason ?? `Council (${result.resolution})`,
        };
      }

      // Decided
      if (request.options && request.options.length > 0) {
        // Option-bearing: pick the winning option
        const winningOption = request.options.find((o) => o.id === result.optionId);
        return {
          type: 'answer',
          ...(winningOption ? { optionId: result.optionId } : {}),
          text: winningOption?.label ?? result.answer ?? 'Council decided.',
          rationale: result.reason ?? `Council (${result.resolution})`,
        };
      }

      // Optionless: use the council's synthesized answer
      return {
        type: 'answer',
        text: result.answer ?? 'Council decided.',
        rationale: result.reason ?? `Council (${result.resolution})`,
      };
    },
  };
}

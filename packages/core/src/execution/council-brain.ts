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
 * Any other persona string is registered as an ad-hoc lens instead of being
 * rejected — see `resolvePersonaRegistry`.
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
import {
  CouncilOrchestrator,
  DEFAULT_COUNCIL_MAX_CONCURRENCY,
} from './council-orchestrator.js';
import { DEFAULT_COUNCIL_OVERALL_TIMEOUT_MS } from './council-profiles.js';
import {
  type CouncilPersonaRegistry,
  DEFAULT_COUNCIL_PERSONA_REGISTRY,
} from './council-personas.js';
import type {
  CouncilLLMCaller,
  CouncilModelTarget,
  CouncilProfileConfig,
  CouncilSeatConfig,
} from '../types/council.js';
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
   * Decision lens. Built-ins: 'executor', 'skeptic', 'auditor', 'security',
   * 'maintainer', 'user-advocate'. Any other string is registered as an ad-hoc
   * lens whose instruction is the string itself (see `resolvePersonaRegistry`).
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

// ── Custom personas ────────────────────────────────────────────────────────

/** Longest synthetic persona id derived from a free-text lens description. */
const MAX_CUSTOM_PERSONA_ID_CHARS = 48;

/**
 * Turn a free-text lens into a registry-legal persona id.
 *
 * Persona ids are constrained to `^[a-z0-9]+(-[a-z0-9]+)*$`, so a verbatim
 * description ("weigh latency above all else") cannot be its own id. The slug
 * is only an internal handle — the raw text is what reaches the voter prompt.
 */
function customPersonaId(raw: string, index: number): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_CUSTOM_PERSONA_ID_CHARS)
    .replace(/-+$/g, '');
  return slug ? `custom-${slug}` : `custom-${index + 1}`;
}

/**
 * Resolve every voter's persona against the built-in registry, registering
 * unrecognized strings as ad-hoc decision lenses.
 *
 * `BrainCouncilVoterConfig.persona` is documented as "any other string is
 * injected verbatim as the persona description". After the CouncilOrchestrator
 * refactor that stopped being true: `normalizeCouncilProfile` calls
 * `personas.require()`, which throws — and the throw is swallowed by the
 * tiered arbiter, so a single typo silently disabled the whole council for the
 * rest of the session while every surface still reported it as "convened".
 * Registering the lens instead keeps the documented behaviour and removes that
 * failure mode entirely.
 */
function resolvePersonaRegistry(voters: readonly CouncilVoter[]): {
  registry: CouncilPersonaRegistry;
  /** Voter index → persona id to use in the generated profile. */
  personaIds: string[];
} {
  let registry = DEFAULT_COUNCIL_PERSONA_REGISTRY;
  const personaIds: string[] = [];
  const byRawText = new Map<string, string>();

  voters.forEach((voter, index) => {
    const raw = voter.persona?.trim();
    if (!raw) {
      personaIds.push('executor');
      return;
    }
    if (registry.has(raw)) {
      personaIds.push(raw);
      return;
    }
    const existing = byRawText.get(raw);
    if (existing) {
      personaIds.push(existing);
      return;
    }
    let id = customPersonaId(raw, index);
    // A slug can still collide (two lenses differing only in punctuation).
    let suffix = 2;
    while (registry.has(id)) id = `${customPersonaId(raw, index)}-${suffix++}`;
    registry = registry.with({
      id,
      name: raw.length <= 40 ? raw : `${raw.slice(0, 39)}…`,
      description: 'Custom decision lens supplied by the host configuration.',
      instruction: raw,
    });
    byRawText.set(raw, id);
    personaIds.push(id);
  });

  return { registry, personaIds };
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Build the per-seat LLM caller that wraps `completeBrainLlmDetailed` for
 * one BrainLlmTarget. Exported so tests can drive the exact production
 * wiring: it forwards the orchestrator's `input.signal` (overall budget +
 * caller cancellation) into the provider call so an in-flight seat is
 * interrupted on timeout/cancel instead of running out its per-call
 * timeout.
 */
export function makeSeatCallerForVoter(target: BrainLlmTarget): CouncilLLMCaller {
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
            // Forward the orchestrator's signal (overall budget + caller
            // cancellation) so an in-flight seat call is interrupted when
            // the council times out or is cancelled instead of running to
            // its per-call timeout. Previously this was dropped and a
            // cancelled council waited for every seat to finish.
            signal: input.signal,
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

/**
 * Create a council-of-LLMs Brain arbiter backed by CouncilOrchestrator
 * with per-seat LLM callers — each voter's own Provider is used for its
 * seat, avoiding the single-provider collapsing bug.
 */
export function createCouncilBrainArbiter(opts: CouncilBrainOptions): BrainArbiter {
  if (opts.voters.length === 0) {
    throw new Error('createCouncilBrainArbiter: at least one voter is required.');
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
  // Unrecognized persona strings become ad-hoc lenses rather than throwing.
  const { registry: personas, personaIds } = resolvePersonaRegistry(opts.voters);
  const seats: CouncilSeatConfig[] = opts.voters.map((voter, i) => ({
    id: `voter-${i}`,
    label: voter.label ?? voter.model,
    persona: personaIds[i] ?? 'executor',
    target: {
      providerId: voter.provider.id,
      model: voter.model,
      role: personaIds[i] ?? 'executor',
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

  const perCallTimeoutMs = opts.decisionTimeoutMs ?? 15_000;
  // The overall budget must cover the whole panel: the seat calls run in
  // waves of `maxConcurrency` (worst case ceil(seats / concurrency) waves)
  // plus one final judge call, each budgeted at perCallTimeoutMs. Before
  // this was set, overallTimeoutMs fell back to the 90_000ms default in
  // normalizeCouncilProfile, so any `brain.council.perCallTimeoutMs` or
  // `brain.decisionTimeoutMs` above 90s made profile normalization throw on
  // every ask() — and the tiered arbiter swallowed the throw, silently
  // degrading the council to the single-LLM tier. `Math.max` with the
  // default keeps the old 90s budget for ordinary configs.
  const effectiveConcurrency = Math.max(
    1,
    Math.min(opts.maxConcurrency ?? DEFAULT_COUNCIL_MAX_CONCURRENCY, seats.length),
  );
  const overallTimeoutMs = Math.max(
    DEFAULT_COUNCIL_OVERALL_TIMEOUT_MS,
    perCallTimeoutMs * (Math.ceil(seats.length / effectiveConcurrency) + 1),
  );

  const profile: CouncilProfileConfig = {
    id: 'brain-council-adapter',
    seats,
    judge: judgeTarget,
    quorumFraction: opts.quorumFraction ?? 0.5,
    approvalFraction: opts.approvalFraction ?? 0.5,
    perCallTimeoutMs,
    overallTimeoutMs,
    ...(opts.judgeMaxTokens !== undefined ? { judgeMaxTokens: opts.judgeMaxTokens } : {}),
    distinctness: opts.distinctness ?? 'none',
  };

  // ── Orchestrator with per-seat callers ───────────────────────────────
  const orchestrator = new CouncilOrchestrator({
    defaultProfile: 'brain-council-adapter',
    // Carries the ad-hoc lenses registered above; without it the orchestrator
    // falls back to the built-in registry and rejects every custom persona.
    personas,
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

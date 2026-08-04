import type {
  CouncilLLMCaller,
  CouncilModelTarget,
  CouncilProfileConfig,
  CouncilQuestion,
  CouncilResult,
  CouncilUsage,
  CouncilVoteResult,
  ResolvedCouncilProfile,
  ResolvedCouncilSeat,
} from '../types/council.js';
import type { OneShotLLMResult } from '../types/one-shot-llm.js';
import {
  DEFAULT_COUNCIL_PERSONA_REGISTRY,
  type CouncilPersonaRegistry,
} from './council-personas.js';
import {
  DEFAULT_COUNCIL_PROFILE_REGISTRY,
  type CouncilProfileRegistry,
  resolveCouncilProfile,
} from './council-profiles.js';
import {
  buildCouncilJudgeSystemPrompt,
  buildCouncilJudgeUserPrompt,
  buildCouncilVoterSystemPrompt,
  buildCouncilVoterUserPrompt,
} from './council-prompts.js';
import { resolveCouncilVotes } from './council-resolution.js';
import type { FallbackProfileManager } from '../core/fallback-profile-manager.js';
import type { Config } from '../types/config.js';

/** Synthetic ballot entry for "refuse every real option". */
export const COUNCIL_REFUSAL_OPTION_ID = 'council_refuse';
export const DEFAULT_COUNCIL_MAX_CONCURRENCY = 3;
export const MAX_COUNCIL_CONCURRENCY = 8;

/**
 * Canonical reason/error texts — single source of truth so every code path
 * (envelope reason, seat errors, judge failures, the timeout-errors dedup)
 * surfaces the SAME string for the same condition.
 */
const OVERALL_TIMEOUT_REASON = 'Council overall timeout exceeded.';
const CALL_CANCELLED_REASON = 'Cancelled.';

export interface CouncilOrchestratorOptions {
  /**
   * Shared LLM caller used for every seat and the judge when no per-seat
   * caller is configured. Optional — supply `seatCaller` (per-seat callers)
   * and/or `judgeCaller` (separate judge caller) to route votes to different
   * providers. At least one of `caller`, `seatCaller`, or `judgeCaller`
   * must be provided; the constructor throws otherwise.
   */
  caller?: CouncilLLMCaller | undefined;
  personas?: CouncilPersonaRegistry | undefined;
  profiles?: CouncilProfileRegistry | undefined;
  defaultProfile?: string | undefined;
  maxConcurrency?: number | undefined;
  refusalOptionId?: string | undefined;
  /** Live config accessor for fallback profile resolution. */
  getConfig?: (() => Config) | undefined;
  /**
   * Shared live FallbackProfileManager — required for reliable fallback
   * profile pre-resolution. Pass the runtime container's manager.
   */
  fallbackProfileManager?: FallbackProfileManager | undefined;
  /**
   * Per-seat LLM caller factory. When set, each seat gets its own caller
   * instead of the shared `caller`. The factory receives (seatIndex) and
   * returns a CouncilLLMCaller. Used by Brain council arbitration where
   * each voter has its own Provider instance.
   */
  seatCaller?: ((seatIndex: number) => CouncilLLMCaller) | undefined;
  /**
   * Separate caller for the judge seat. Required when `seatCaller` is set
   * because the judge uses the shared caller path. When absent and
   * `seatCaller` is set, the judge falls back to `seatCaller(0)`.
   */
  judgeCaller?: CouncilLLMCaller | undefined;
}

interface ParsedVote {
  optionId?: string | undefined;
  stance?: string | undefined;
  rationale?: string | undefined;
}

interface ParsedJudge {
  optionId?: string | undefined;
  answer?: string | undefined;
  rationale?: string | undefined;
}

interface UsageAccumulator {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Provider-neutral Council runner backed by an injected one-shot LLM caller. */
export class CouncilOrchestrator {
  private readonly caller: CouncilLLMCaller | undefined;
  private readonly personas: CouncilPersonaRegistry;
  private readonly profiles: CouncilProfileRegistry;
  private readonly defaultProfile: string | undefined;
  private readonly maxConcurrency: number;
  private readonly refusalOptionId: string;
  private readonly fallbackProfileManager: FallbackProfileManager | undefined;
  private readonly seatCaller: ((seatIndex: number) => CouncilLLMCaller) | undefined;
  private readonly judgeCaller: CouncilLLMCaller | undefined;
  /**
   * Normalized ad-hoc profiles keyed by the caller's config object identity.
   * The Brain adapter reuses ONE profile object for every decision, so this
   * avoids re-validating + re-freezing it on every ask() without caching
   * string-keyed registry lookups (those are already O(1)).
   *
   * Hosts must treat ad-hoc profile configs as IMMUTABLE once passed to
   * ask(): the cache is keyed by object identity and never invalidated, so
   * mutating a cached profile would silently serve the first snapshot.
   */
  private readonly profileCache = new WeakMap<CouncilProfileConfig, ResolvedCouncilProfile>();

  constructor(opts: CouncilOrchestratorOptions) {
    if (!opts.caller && !opts.seatCaller && !opts.judgeCaller) {
      throw new Error(
        'CouncilOrchestrator: provide `caller`, `seatCaller`, or `judgeCaller`.',
      );
    }
    this.caller = opts.caller;
    this.personas = opts.personas ?? DEFAULT_COUNCIL_PERSONA_REGISTRY;
    this.profiles = opts.profiles ?? DEFAULT_COUNCIL_PROFILE_REGISTRY;
    this.defaultProfile = opts.defaultProfile;
    this.maxConcurrency = validateConcurrency(
      opts.maxConcurrency ?? DEFAULT_COUNCIL_MAX_CONCURRENCY,
    );
    this.refusalOptionId = opts.refusalOptionId?.trim() || COUNCIL_REFUSAL_OPTION_ID;
    this.fallbackProfileManager = opts.fallbackProfileManager;
    this.seatCaller = opts.seatCaller;
    this.judgeCaller = opts.judgeCaller;
  }

  /**
   * Resolve the effective profile for a question. String ids and the default
   * go through the registry (already O(1)); ad-hoc config objects are
   * normalized once per stable object identity and cached, because hosts such
   * as the Brain adapter pass the same profile object on every ask().
   */
  private resolveProfile(profile: string | CouncilProfileConfig | undefined): ResolvedCouncilProfile {
    if (typeof profile === 'string' || profile === undefined) {
      return resolveCouncilProfile(profile, {
        registry: this.profiles,
        personas: this.personas,
        defaultProfile: this.defaultProfile,
      });
    }
    const cached = this.profileCache.get(profile);
    if (cached) return cached;
    const resolved = resolveCouncilProfile(profile, {
      registry: this.profiles,
      personas: this.personas,
      defaultProfile: this.defaultProfile,
    });
    this.profileCache.set(profile, resolved);
    return resolved;
  }

  async ask(question: CouncilQuestion): Promise<CouncilResult> {
    const startedAt = Date.now();
    const profile = this.resolveProfile(question.profile);
    validateRefusalCollision(question, this.refusalOptionId);

    const timeoutSignal = AbortSignal.timeout(profile.overallTimeoutMs);
    const signal = question.signal
      ? AbortSignal.any([question.signal, timeoutSignal])
      : timeoutSignal;
    const usage: UsageAccumulator = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    const votes = await mapConcurrent(
      profile.seats,
      Math.min(this.maxConcurrency, profile.seats.length),
      async (seat, i) => {
        try {
          return await this.callSeat(question, profile, seat, i, signal, usage);
        } catch (error) {
          const timedOut = signal.aborted && !question.signal?.aborted;
          return {
            seatId: seat.id,
            persona: seat.persona,
            // Only the caller's own cancel is a "cancelled" vote; the overall
            // budget expiring is a failure (timeout), matching the envelope.
            status: question.signal?.aborted ? 'cancelled' : 'failed',
            // Canonical text for aborted-by-budget or cancelled seats, so one
            // event does not surface a different string per code path.
            error: question.signal?.aborted
              ? CALL_CANCELLED_REASON
              : timedOut
                ? OVERALL_TIMEOUT_REASON
                : errorMessage(error),
          } satisfies CouncilVoteResult;
        }
      },
    );
    const warnings = distinctnessWarnings(votes, profile);
    const errors = votes
      .filter((vote) => vote.status === 'failed' || vote.status === 'invalid')
      .map((vote) => `${vote.seatId}: ${vote.error ?? vote.status}`);

    if (question.signal?.aborted) {
      return resultEnvelope({
        status: 'cancelled',
        reason: CALL_CANCELLED_REASON,
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }
    if (timeoutSignal.aborted) {
      return resultEnvelope({
        status: 'failed',
        reason: OVERALL_TIMEOUT_REASON,
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        // Seat-prefixed errors normally carry the canonical timeout text, but
        // a signal-blind caller can resolve valid votes even after the budget
        // expired — append the standalone entry only when nothing carries it.
        errors: errors.some((entry) => entry.includes(OVERALL_TIMEOUT_REASON))
          ? errors
          : [...errors, OVERALL_TIMEOUT_REASON],
      });
    }

    if (!question.options || question.options.length === 0) {
      return this.resolveOpenQuestion(
        question,
        profile,
        votes,
        signal,
        usage,
        startedAt,
        warnings,
        errors,
      );
    }
    return this.resolveOptionQuestion(
      question,
      profile,
      votes,
      signal,
      usage,
      startedAt,
      warnings,
      errors,
    );
  }

  private async callSeat(
    question: CouncilQuestion,
    profile: ResolvedCouncilProfile,
    seat: ResolvedCouncilSeat,
    seatIndex: number,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<CouncilVoteResult> {
    if (signal.aborted) {
      // Only the caller's own cancel means "cancelled" — the overall budget
      // expiring is a failure (timeout), so the vote status matches the
      // envelope status instead of showing a failed panel of cancelled seats.
      return question.signal?.aborted
        ? cancelledVote(seat)
        : {
            seatId: seat.id,
            persona: seat.persona,
            status: 'failed',
            ...(seat.target?.providerId ? { provider: seat.target.providerId } : {}),
            ...(seat.target?.model ? { model: seat.target.model } : {}),
            durationMs: 0,
            error: OVERALL_TIMEOUT_REASON,
          } satisfies CouncilVoteResult;
    }
    let persona;
    try {
      persona = this.personas.require(seat.persona);
    } catch (error) {
      return {
        seatId: seat.id,
        persona: seat.persona,
        status: 'failed',
        error: errorMessage(error),
      };
    }
    const result = await this.safeCall({
      system: buildCouncilVoterSystemPrompt(persona),
      userPrompt: buildCouncilVoterUserPrompt(question, seat, {
        refusalOptionId: question.options?.length ? this.refusalOptionId : undefined,
      }),
      target: seat.target,
      maxTokens: profile.voterMaxTokens,
      timeoutMs: profile.perCallTimeoutMs,
      signal,
      usage,
      seatIndex,
    });

    const metadata = callMetadata(result);
    if (result.error) {
      const timedOut = signal.aborted && !question.signal?.aborted;
      return {
        seatId: seat.id,
        persona: seat.persona,
        status: question.signal?.aborted ? 'cancelled' : 'failed',
        ...metadata,
        // Canonical text for cancelled or aborted-by-budget seats, so one
        // cancel/timeout event does not surface a raw provider string.
        error: question.signal?.aborted
          ? CALL_CANCELLED_REASON
          : timedOut
            ? OVERALL_TIMEOUT_REASON
            : result.error,
      };
    }
    const parsed = parseVote(result.text, question, this.refusalOptionId);
    if (!parsed.ok) {
      return {
        seatId: seat.id,
        persona: seat.persona,
        status: 'invalid',
        ...metadata,
        error: parsed.error,
      };
    }
    return {
      seatId: seat.id,
      persona: seat.persona,
      status: 'valid',
      ...parsed.vote,
      ...metadata,
    };
  }

  private async resolveOptionQuestion(
    question: CouncilQuestion,
    profile: ResolvedCouncilProfile,
    votes: CouncilVoteResult[],
    signal: AbortSignal,
    usage: UsageAccumulator,
    startedAt: number,
    warnings: string[],
    errors: string[],
  ): Promise<CouncilResult> {
    const validVotes = votes.filter(
      (vote): vote is CouncilVoteResult & { optionId: string } =>
        vote.status === 'valid' && typeof vote.optionId === 'string',
    );
    const resolution = resolveCouncilVotes({
      seats: profile.seats.map((seat) => ({
        id: seat.id,
        weight: seat.weight,
        veto: seat.veto,
      })),
      votes: validVotes.map((vote) => ({ seatId: vote.seatId, optionId: vote.optionId })),
      refusalOptionId: this.refusalOptionId,
      quorumFraction: profile.quorumFraction,
      approvalFraction: profile.approvalFraction,
    });

    if (resolution.status === 'abstained') {
      return resultEnvelope({
        status: 'abstained',
        reason: 'Council quorum was not met.',
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }
    if (resolution.status === 'denied') {
      return resultEnvelope({
        status: 'denied',
        optionId: resolution.optionId,
        reason: `Council denied the proposal via ${resolution.method}.`,
        resolution: resolution.method,
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }
    if (resolution.status === 'decided') {
      return resultEnvelope({
        status: 'decided',
        optionId: resolution.optionId,
        answer: optionLabel(question, resolution.optionId),
        resolution: 'majority',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }
    if (!profile.judge) {
      return resultEnvelope({
        status: 'abstained',
        reason: `Council requires a judge (${resolution.reason}), but this profile has none.`,
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }

    const judged = await this.callJudge(
      question,
      profile,
      votes,
      profile.judge,
      resolution.reason,
      signal,
      usage,
    );
    // A signal-blind judge can return a verdict AFTER the overall budget
    // expired or the caller cancelled — a decision derived from a post-abort
    // call must not be reported as decided. (The seat path guards via vote
    // classification; the judge path needs an explicit re-check.) Mirrors the
    // seat-stage canonical texts and the errors dedup.
    if (signal.aborted) {
      const cancelled = question.signal?.aborted === true;
      const reason = cancelled ? CALL_CANCELLED_REASON : OVERALL_TIMEOUT_REASON;
      return resultEnvelope({
        status: cancelled ? 'cancelled' : 'failed',
        reason,
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors: errors.some((entry) => entry.includes(reason))
          ? errors
          : [...errors, reason],
        judgeUsed: true,
      });
    }
    if (!judged.ok) {
      return resultEnvelope({
        // User cancel -> cancelled; overall budget expired mid-judge -> failed;
        // otherwise the judge simply failed -> abstained (can't decide).
        status: question.signal?.aborted
          ? 'cancelled'
          : signal.aborted
            ? 'failed'
            : 'abstained',
        reason: judged.error,
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors: [...errors, judged.error],
        judgeUsed: true,
      });
    }
    if (judged.value.optionId === this.refusalOptionId) {
      return resultEnvelope({
        status: 'denied',
        optionId: this.refusalOptionId,
        reason: judged.value.rationale ?? 'Council judge refused all options.',
        resolution: 'judge',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
        judgeUsed: true,
      });
    }
    return resultEnvelope({
      status: 'decided',
      optionId: judged.value.optionId,
      answer: optionLabel(question, judged.value.optionId),
      reason: judged.value.rationale,
      resolution: 'judge',
      votes,
      profile,
      usage,
      startedAt,
      warnings,
      errors,
      judgeUsed: true,
    });
  }

  private async resolveOpenQuestion(
    question: CouncilQuestion,
    profile: ResolvedCouncilProfile,
    votes: CouncilVoteResult[],
    signal: AbortSignal,
    usage: UsageAccumulator,
    startedAt: number,
    warnings: string[],
    errors: string[],
  ): Promise<CouncilResult> {
    const valid = votes.filter(
      (vote): vote is CouncilVoteResult & { stance: string } =>
        vote.status === 'valid' && typeof vote.stance === 'string',
    );
    if (valid.length / profile.seats.length < profile.quorumFraction) {
      return resultEnvelope({
        status: 'abstained',
        reason: 'Council quorum was not met.',
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }
    if (!profile.judge) {
      // No judge to reconcile free-text stances. The quorum gate above
      // guarantees at least one valid stance (quorumFraction is validated
      // > 0), so a single stance — or several identical ones — is a decision
      // while genuinely divergent stances are surfaced as a divergence,
      // escalated to the caller instead of silently letting the first seat
      // win. weight and approvalFraction are intentionally not consulted
      // here: there is no tally for optionless questions (see
      // CouncilSeatConfig.weight / CouncilProfileConfig.approvalFraction
      // docs).
      if (divergentStances(valid)) {
        return resultEnvelope({
          status: 'abstained',
          reason:
            'Council produced multiple distinct stances and has no judge to reconcile them.',
          resolution: 'none',
          votes,
          profile,
          usage,
          startedAt,
          warnings,
          errors,
        });
      }
      const first = valid[0];
      if (!first) {
        // Defensive only — unreachable while quorumFraction > 0.
        return resultEnvelope({
          status: 'failed',
          reason: 'Council produced no valid stance.',
          resolution: 'none',
          votes,
          profile,
          usage,
          startedAt,
          warnings,
          errors,
        });
      }
      return resultEnvelope({
        status: 'decided',
        answer: first.stance,
        reason: first.rationale,
        resolution: 'first_stance',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }

    const judged = await this.callJudge(
      question,
      profile,
      votes,
      profile.judge,
      'open_question_synthesis',
      signal,
      usage,
    );
    // A signal-blind judge can return a verdict AFTER the overall budget
    // expired or the caller cancelled — a decision derived from a post-abort
    // call must not be reported as decided. (The seat path guards via vote
    // classification; the judge path needs an explicit re-check.) Mirrors the
    // seat-stage canonical texts and the errors dedup.
    if (signal.aborted) {
      const cancelled = question.signal?.aborted === true;
      const reason = cancelled ? CALL_CANCELLED_REASON : OVERALL_TIMEOUT_REASON;
      return resultEnvelope({
        status: cancelled ? 'cancelled' : 'failed',
        reason,
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors: errors.some((entry) => entry.includes(reason))
          ? errors
          : [...errors, reason],
        judgeUsed: true,
      });
    }
    if (!judged.ok) {
      return resultEnvelope({
        // User cancel -> cancelled; overall budget expired mid-judge -> failed;
        // otherwise the judge simply failed -> failed (open questions cannot
        // abstain for a judge failure — 'abstained' is reserved for quorum
        // failure and stance divergence; the option path maps this same
        // plain-judge-failure case to 'abstained' instead).
        status: question.signal?.aborted ? 'cancelled' : 'failed',
        reason: judged.error,
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors: [...errors, judged.error],
        judgeUsed: true,
      });
    }
    return resultEnvelope({
      status: 'decided',
      answer: judged.value.answer,
      reason: judged.value.rationale,
      resolution: 'judge',
      votes,
      profile,
      usage,
      startedAt,
      warnings,
      errors,
      judgeUsed: true,
    });
  }

  private async callJudge(
    question: CouncilQuestion,
    profile: ResolvedCouncilProfile,
    votes: CouncilVoteResult[],
    target: CouncilModelTarget,
    reason: string,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<{ ok: true; value: ParsedJudge } | { ok: false; error: string }> {
    const result = await this.safeCall({
      system: buildCouncilJudgeSystemPrompt(),
      userPrompt: buildCouncilJudgeUserPrompt(question, votes, {
        reason,
        refusalOptionId: question.options?.length ? this.refusalOptionId : undefined,
      }),
      target,
      maxTokens: profile.judgeMaxTokens,
      timeoutMs: profile.perCallTimeoutMs,
      signal,
      usage,
    });
    if (result.error) {
      // Canonicalize abort-caused judge failures so the envelope reason is not
      // an environment-dependent raw string (the same invariant the seat
      // votes enforce). A plain judge failure keeps its real error.
      if (signal.aborted && !question.signal?.aborted) {
        return { ok: false, error: OVERALL_TIMEOUT_REASON };
      }
      if (question.signal?.aborted) {
        return { ok: false, error: CALL_CANCELLED_REASON };
      }
      return { ok: false, error: result.error };
    }
    return parseJudge(result.text, question, this.refusalOptionId);
  }

  /**
   * Resolve the effective LLM caller for a call. Voter seats (defined
   * seatIndex) use `seatCaller(seatIndex)` when wired, otherwise the shared
   * `caller` — a seat never falls through to the judge caller. Judge seats
   * (seatIndex undefined) use `judgeCaller` if set, otherwise `seatCaller(0)`
   * if set, otherwise the shared `caller`.
   */
  private resolveCaller(seatIndex?: number): CouncilLLMCaller {
    if (seatIndex !== undefined) {
      if (this.seatCaller) return this.seatCaller(seatIndex);
      // Shared caller — guaranteed present by the constructor invariant
      // (at least one of `caller` / `seatCaller` / `judgeCaller` is required);
      // a judgeCaller-only host has no voter distinction, so seats share it.
      return (this.caller ?? this.judgeCaller) as CouncilLLMCaller;
    }
    if (this.judgeCaller) return this.judgeCaller;
    if (this.seatCaller) return this.seatCaller(0);
    // Shared caller — guaranteed present by the constructor invariant.
    return this.caller as CouncilLLMCaller;
  }

  private async safeCall(input: {
    system: string;
    userPrompt: string;
    target?: CouncilModelTarget | undefined;
    maxTokens: number;
    timeoutMs: number;
    signal: AbortSignal;
    usage: UsageAccumulator;
    seatIndex?: number | undefined;
  }): Promise<OneShotLLMResult> {
    const effectiveCaller = this.resolveCaller(input.seatIndex);

    const resolvedTarget = this.resolveCouncilTarget(input.target);
    const startedAt = Date.now();

    try {
      const result = await effectiveCaller.call({
        system: input.system,
        userPrompt: input.userPrompt,
        responseFormat: { type: 'json_object' },
        maxTokens: input.maxTokens,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        ...(resolvedTarget?.providerId ? { providerId: resolvedTarget.providerId } : {}),
        ...(resolvedTarget?.model ? { model: resolvedTarget.model } : {}),
        ...(resolvedTarget?.role ? { role: resolvedTarget.role } : {}),
        ...(resolvedTarget?.fallbackModels && resolvedTarget.fallbackModels.length > 0
          ? { fallbackModels: [...resolvedTarget.fallbackModels] }
          : {}),
      });
      addUsage(input.usage, result);
      return result;
    } catch (error) {
      // A caller that throws still cost wall-clock time and a provider/model
      // target — report both instead of the old hardcoded 0s/empty strings.
      // Routed through addUsage so the thrown path shares the single
      // accounting site with every successful/error-result path.
      const failed: OneShotLLMResult = {
        text: '',
        model: resolvedTarget?.model ?? '',
        provider: resolvedTarget?.providerId ?? '',
        tokens: { input: 0, output: 0, total: 0 },
        durationMs: Math.max(0, Date.now() - startedAt),
        fromFallback: false,
        error: errorMessage(error),
      };
      addUsage(input.usage, failed);
      return failed;
    }
  }

  /**
   * Resolve a CouncilModelTarget: pre-resolve fallbackProfile to fallbackModels
   * so the downstream caller only sees the resolved chain.
   */
  private resolveCouncilTarget(
    target?: CouncilModelTarget | undefined,
  ): CouncilModelTarget | undefined {
    if (!target) return undefined;
    if (!target.fallbackProfile) return target;

    const mgr = this.fallbackProfileManager;
    if (!mgr) return target;
    const chain = mgr.resolve(target.fallbackProfile);
    if (chain.length === 0) return target;

    // Combine profile-resolved chain with any explicit fallbackModels
    const combined = [
      ...chain.map((e) => `${e.providerId}/${e.model}`),
      ...(target.fallbackModels ?? []),
    ];
    // Deduplicate while preserving order
    const seen = new Set<string>();
    const deduped = combined.filter((ref) => {
      if (seen.has(ref)) return false;
      seen.add(ref);
      return true;
    });

    return {
      ...(target.providerId ? { providerId: target.providerId } : {}),
      ...(target.model ? { model: target.model } : {}),
      ...(target.role ? { role: target.role } : {}),
      fallbackModels: deduped,
    };
  }
}

/** One parsed seat/judge response before role-specific shaping. */
interface ParsedCouncilResponse {
  optionId?: string | undefined;
  stance?: string | undefined;
  answer?: string | undefined;
  rationale?: string | undefined;
}

/**
 * Shared parser for voter and judge JSON responses. The two roles differ only
 * in the free-text field name ('stance' vs 'answer') and the error labels, so
 * one parameterized function replaces the near-identical parseVote/parseJudge
 * twins.
 */
function parseCouncilResponse(
  text: string,
  question: CouncilQuestion,
  refusalOptionId: string,
  opts: { role: 'voter' | 'judge'; freeTextField: 'stance' | 'answer' },
): { ok: true; value: ParsedCouncilResponse } | { ok: false; error: string } {
  const roleLabel = opts.role === 'judge' ? 'Judge' : 'Voter';
  const parsed = parseObject(text);
  if (!parsed.ok && (!question.options || question.options.length === 0)) {
    // Optionless: if JSON parsing fails, use the raw text as the free-text
    // field (backward compat with old council-brain behavior).
    const fallback = text.trim();
    if (fallback) return { ok: true, value: { [opts.freeTextField]: fallback } };
    return { ok: false, error: `${roleLabel} returned an empty response.` };
  }
  if (!parsed.ok) return parsed;
  const rationale = optionalString(parsed.value['rationale']);
  if (question.options && question.options.length > 0) {
    const optionId = optionalString(parsed.value['optionId']);
    const allowed = new Set([
      ...question.options.map((option) => option.id.trim()),
      refusalOptionId,
    ]);
    if (!optionId || !allowed.has(optionId)) {
      return { ok: false, error: `${roleLabel} returned an unknown or missing optionId.` };
    }
    return { ok: true, value: { optionId, ...(rationale ? { rationale } : {}) } };
  }
  const freeText = optionalString(parsed.value[opts.freeTextField]);
  if (!freeText) {
    return {
      ok: false,
      error: `${roleLabel} returned an empty or missing ${opts.freeTextField}.`,
    };
  }
  return { ok: true, value: { [opts.freeTextField]: freeText, ...(rationale ? { rationale } : {}) } };
}

/**
 * True when the valid free-text stances diverge beyond formatting. Stances
 * are compared after normalization (trim, lowercase, strip trailing
 * punctuation, collapse whitespace) so trivial casing/punctuation differences
 * ("Yes" vs "Yes.") count as agreement — only substantively different wording
 * escalates to abstained. The winning stance is still returned raw.
 */
function divergentStances(valid: readonly (CouncilVoteResult & { stance: string })[]): boolean {
  const seen = new Set<string>();
  for (const vote of valid) {
    const normalized = vote.stance
      .trim()
      // Strip surrounding quotes — the raw-text fallback can carry them
      // ('"Yes"' from a model that quoted its stance).
      .replace(/^["'`]+|["'`]+$/g, '')
      .toLowerCase()
      .replace(/[.!?;:,]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // A stance that normalizes to nothing is not a real stance: two
    // punctuation-only "stances" must not count as agreement.
    if (!normalized) return true;
    seen.add(normalized);
    if (seen.size > 1) return true;
  }
  return false;
}

function parseVote(
  text: string,
  question: CouncilQuestion,
  refusalOptionId: string,
): { ok: true; vote: ParsedVote } | { ok: false; error: string } {
  const parsed = parseCouncilResponse(text, question, refusalOptionId, {
    role: 'voter',
    freeTextField: 'stance',
  });
  if (!parsed.ok) return parsed;
  const { optionId, stance, rationale } = parsed.value;
  return {
    ok: true,
    vote: {
      ...(optionId ? { optionId } : {}),
      ...(stance ? { stance } : {}),
      ...(rationale ? { rationale } : {}),
    },
  };
}

function parseJudge(
  text: string,
  question: CouncilQuestion,
  refusalOptionId: string,
): { ok: true; value: ParsedJudge } | { ok: false; error: string } {
  const parsed = parseCouncilResponse(text, question, refusalOptionId, {
    role: 'judge',
    freeTextField: 'answer',
  });
  if (!parsed.ok) return parsed;
  const { optionId, answer, rationale } = parsed.value;
  return {
    ok: true,
    value: {
      ...(optionId ? { optionId } : {}),
      ...(answer ? { answer } : {}),
      ...(rationale ? { rationale } : {}),
    },
  };
}

function parseObject(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last < first) return { ok: false, error: 'LLM response did not contain JSON.' };
  try {
    const value: unknown = JSON.parse(trimmed.slice(first, last + 1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'LLM response JSON must be an object.' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: `Invalid LLM response JSON: ${errorMessage(error)}` };
  }
}

function resultEnvelope(input: {
  status: CouncilResult['status'];
  answer?: string | undefined;
  optionId?: string | undefined;
  reason?: string | undefined;
  resolution: CouncilResult['resolution'];
  votes: CouncilVoteResult[];
  profile: ResolvedCouncilProfile;
  usage: UsageAccumulator;
  startedAt: number;
  warnings: string[];
  errors: string[];
  judgeUsed?: boolean | undefined;
}): CouncilResult {
  const validVoteCount = input.votes.filter((vote) => vote.status === 'valid').length;
  return {
    status: input.status,
    ...(input.answer ? { answer: input.answer } : {}),
    ...(input.optionId ? { optionId: input.optionId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    resolution: input.resolution,
    votes: Object.freeze([...input.votes]),
    configuredSeatCount: input.profile.seats.length,
    validVoteCount,
    distinctTargetCount: distinctTargetCount(input.votes, input.profile),
    judgeUsed: input.judgeUsed ?? false,
    usage: usageResult(input.usage, input.startedAt),
    ...(input.warnings.length > 0 ? { warnings: Object.freeze([...input.warnings]) } : {}),
    ...(input.errors.length > 0 ? { errors: Object.freeze([...input.errors]) } : {}),
  };
}

function callMetadata(result: OneShotLLMResult): Omit<CouncilVoteResult, 'seatId' | 'persona' | 'status'> {
  return {
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.model ? { model: result.model } : {}),
    ...(result.fromFallback ? { fromFallback: true } : {}),
    durationMs: result.durationMs,
  };
}

function addUsage(usage: UsageAccumulator, result: OneShotLLMResult): void {
  // `attempts` is the number of provider invocations behind this result
  // (primary + fallbacks) when the caller reports it; callers without
  // fallback machinery (Brain seats, test doubles) report nothing and count
  // as one call each. Clamped to at least 1: a seat that ran at all counts
  // as one council-level call, even when no provider could be resolved
  // (OneShot reports attempts: 0 for that pre-call failure).
  usage.calls += Math.max(1, result.attempts ?? 1);
  usage.inputTokens += result.tokens.input;
  usage.outputTokens += result.tokens.output;
  usage.totalTokens += result.tokens.total;
}

function usageResult(usage: UsageAccumulator, startedAt: number): CouncilUsage {
  return Object.freeze({ ...usage, durationMs: Math.max(0, Date.now() - startedAt) });
}

function cancelledVote(seat: ResolvedCouncilSeat): CouncilVoteResult {
  return {
    seatId: seat.id,
    persona: seat.persona,
    status: 'cancelled',
    ...(seat.target?.providerId ? { provider: seat.target.providerId } : {}),
    ...(seat.target?.model ? { model: seat.target.model } : {}),
    durationMs: 0,
    error: CALL_CANCELLED_REASON,
  };
}

/**
 * Distinct serving targets among valid votes that carry a provider/model.
 * Display counterpart of the distinctness warning; a 0 count means NO vote
 * carried attribution (not "zero diversity") — consumers must not read it as
 * evidence of correlation.
 */
function distinctTargetCount(
  votes: readonly CouncilVoteResult[],
  profile: ResolvedCouncilProfile,
): number {
  return new Set(distinctTargetKeys(votes, profile)).size;
}

/**
 * Serving-target keys for valid votes, omitting votes whose caller reported
 * no provider/model: such a vote can neither demonstrate nor refute diversity,
 * so it is excluded from the distinctness computation entirely (it must not
 * inflate the denominator into a spurious warning, nor mask correlation).
 */
function distinctTargetKeys(
  votes: readonly CouncilVoteResult[],
  profile: ResolvedCouncilProfile,
): string[] {
  const keys: string[] = [];
  for (const vote of votes) {
    if (vote.status !== 'valid') continue;
    const provider = vote.provider?.trim() ?? '';
    const model = vote.model?.trim() ?? '';
    if (profile.distinctness === 'provider') {
      // Provider diversity needs an actual provider — a model-only vote
      // cannot demonstrate it and must not produce an empty key.
      if (provider) keys.push(provider);
    } else if (provider || model) {
      // 'model' mode: at least one part is non-empty, so the key never
      // degrades to the truthy '/' sentinel.
      keys.push(`${provider}/${model}`);
    }
  }
  return keys;
}

function distinctnessWarnings(
  votes: readonly CouncilVoteResult[],
  profile: ResolvedCouncilProfile,
): string[] {
  if (profile.distinctness === 'none') return [];
  const keys = distinctTargetKeys(votes, profile);
  const distinct = new Set(keys).size;
  // The comparison counts only seats that actually voted WITH a serving
  // target: a half-dead panel cannot hide correlation (survivors sharing one
  // target still warn), and votes without target attribution cannot conjure a
  // "met" (or "not met") verdict from unverifiable data.
  if (keys.length > 1 && distinct < keys.length) {
    return [
      `Council distinctness policy "${profile.distinctness}" was not met: ${distinct} distinct target(s) served ${keys.length} valid vote(s).`,
    ];
  }
  return [];
}

function optionLabel(question: CouncilQuestion, optionId: string | undefined): string | undefined {
  if (!optionId) return undefined;
  return question.options?.find((option) => option.id.trim() === optionId)?.label.trim();
}

function validateRefusalCollision(question: CouncilQuestion, refusalOptionId: string): void {
  if (question.options?.some((option) => option.id.trim() === refusalOptionId)) {
    throw new Error(`CouncilOrchestrator: option id "${refusalOptionId}" is reserved.`);
  }
}

function validateConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_COUNCIL_CONCURRENCY) {
    throw new Error(
      `CouncilOrchestrator: maxConcurrency must be an integer in [1, ${MAX_COUNCIL_CONCURRENCY}].`,
    );
  }
  return value;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

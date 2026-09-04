import type { FallbackProfileManager } from '../core/fallback-profile-manager.js';
import type { Config } from '../types/config.js';
import type {
  CouncilLLMCaller,
  CouncilModelTarget,
  CouncilProfileConfig,
  CouncilQuestion,
  CouncilResult,
  CouncilVoteResult,
  ResolvedCouncilProfile,
  ResolvedCouncilSeat,
} from '../types/council.js';
import type { OneShotLLMResult } from '../types/one-shot-llm.js';
import {
  addUsage,
  CALL_CANCELLED_REASON,
  COUNCIL_REFUSAL_OPTION_ID,
  callMetadata,
  cancelledVote,
  DEFAULT_COUNCIL_MAX_CONCURRENCY,
  deliberationWarnings,
  distinctnessWarnings,
  MAX_COUNCIL_CONCURRENCY,
  mapConcurrent,
  OVERALL_TIMEOUT_REASON,
  optionLabel,
  resultEnvelope,
  type UsageAccumulator,
  validateConcurrency,
  validateRefusalCollision,
} from './council-orchestrator-helpers.js';
import {
  type CouncilPersonaRegistry,
  DEFAULT_COUNCIL_PERSONA_REGISTRY,
} from './council-personas.js';
import {
  type CouncilProfileRegistry,
  DEFAULT_COUNCIL_PROFILE_REGISTRY,
  resolveCouncilProfile,
} from './council-profiles.js';
import {
  buildCouncilJudgeSystemPrompt,
  buildCouncilJudgeUserPrompt,
  buildCouncilVoterSystemPrompt,
  buildCouncilVoterUserPrompt,
} from './council-prompts.js';
import { resolveCouncilVotes } from './council-resolution.js';
import {
  divergentStances,
  errorMessage,
  type ParsedJudge,
  parseJudge,
  parseVote,
  withTruncationNote,
} from './council-response-parser.js';

export { COUNCIL_REFUSAL_OPTION_ID, DEFAULT_COUNCIL_MAX_CONCURRENCY, MAX_COUNCIL_CONCURRENCY };

export interface CouncilOrchestratorOptions {
  /**
   * Shared LLM caller used for every seat and the judge when no per-seat
   * caller is configured.
   */
  caller?: CouncilLLMCaller | undefined;
  personas?: CouncilPersonaRegistry | undefined;
  profiles?: CouncilProfileRegistry | undefined;
  defaultProfile?: string | undefined;
  maxConcurrency?: number | undefined;
  refusalOptionId?: string | undefined;
  getConfig?: (() => Config) | undefined;
  fallbackProfileManager?: FallbackProfileManager | undefined;
  seatCaller?: ((seatIndex: number) => CouncilLLMCaller) | undefined;
  judgeCaller?: CouncilLLMCaller | undefined;
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

  constructor(opts: CouncilOrchestratorOptions) {
    if (!opts.caller && !opts.seatCaller && !opts.judgeCaller) {
      throw new Error('CouncilOrchestrator: provide `caller`, `seatCaller`, or `judgeCaller`.');
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

  private resolveProfile(
    profile: string | CouncilProfileConfig | undefined,
  ): ResolvedCouncilProfile {
    return resolveCouncilProfile(profile, {
      registry: this.profiles,
      personas: this.personas,
      defaultProfile: this.defaultProfile,
    });
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

    // Deliberation: round 1 is independent, later rounds show each seat the
    // previous round's ballots. Only the LAST round is tallied — earlier ones
    // are retained on the result so a verdict stays reconstructable.
    const roundVotes: CouncilVoteResult[][] = [];
    let votes: CouncilVoteResult[] = [];
    for (let round = 1; round <= profile.deliberationRounds; round++) {
      const previous = roundVotes[roundVotes.length - 1];
      const current = await mapConcurrent(
        profile.seats,
        Math.min(this.maxConcurrency, profile.seats.length),
        async (seat, i) => {
          try {
            return await this.callSeat(question, profile, seat, i, signal, usage, {
              round,
              ...(previous ? { previous } : {}),
            });
          } catch (error) {
            const timedOut = signal.aborted && !question.signal?.aborted;
            return {
              seatId: seat.id,
              persona: seat.persona,
              round,
              status: question.signal?.aborted ? 'cancelled' : 'failed',
              error: question.signal?.aborted
                ? CALL_CANCELLED_REASON
                : timedOut
                  ? OVERALL_TIMEOUT_REASON
                  : errorMessage(error),
            } satisfies CouncilVoteResult;
          }
        },
      );
      roundVotes.push(current);
      votes = current;
      // Stop deliberating the moment the budget is gone. Carrying on would
      // spend a whole extra wave of calls that can only come back aborted,
      // and would overwrite a usable round with a wave of failures.
      if (signal.aborted) break;
    }
    // A later round that failed wholesale is worse than the independent round
    // it replaced: falling back to the last round that produced any usable
    // ballot keeps a transport failure in round 2 from discarding a perfectly
    // good round 1.
    if (roundVotes.length > 1 && !votes.some((vote) => vote.status === 'valid')) {
      const lastUsable = [...roundVotes].reverse().find((r) => r.some((v) => v.status === 'valid'));
      if (lastUsable) votes = lastUsable;
    }
    const warnings = [
      ...distinctnessWarnings(votes, profile),
      ...deliberationWarnings(roundVotes, profile),
    ];
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
        roundVotes,
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
        errors: errors.some((entry) => entry.includes(OVERALL_TIMEOUT_REASON))
          ? errors
          : [...errors, OVERALL_TIMEOUT_REASON],
        roundVotes,
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
        roundVotes,
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
      roundVotes,
    );
  }

  private async callSeat(
    question: CouncilQuestion,
    profile: ResolvedCouncilProfile,
    seat: ResolvedCouncilSeat,
    seatIndex: number,
    signal: AbortSignal,
    usage: UsageAccumulator,
    /** Round 1 is independent; later rounds carry the previous ballots. */
    ctx: { round: number; previous?: readonly CouncilVoteResult[] | undefined } = { round: 1 },
  ): Promise<CouncilVoteResult> {
    const { round } = ctx;
    const priorSelf = ctx.previous?.find((vote) => vote.seatId === seat.id);
    /** Did this seat move? Only meaningful once it has a previous ballot. */
    const markChange = (vote: CouncilVoteResult): CouncilVoteResult => {
      if (priorSelf?.status !== 'valid' || vote.status !== 'valid') return vote;
      const moved = (vote.optionId ?? vote.stance) !== (priorSelf.optionId ?? priorSelf.stance);
      return moved ? { ...vote, changed: true } : vote;
    };
    if (signal.aborted) {
      return question.signal?.aborted
        ? { ...cancelledVote(seat), round }
        : ({
            seatId: seat.id,
            persona: seat.persona,
            round,
            status: 'failed',
            ...(seat.target?.providerId ? { provider: seat.target.providerId } : {}),
            ...(seat.target?.model ? { model: seat.target.model } : {}),
            durationMs: 0,
            error: OVERALL_TIMEOUT_REASON,
          } satisfies CouncilVoteResult);
    }
    let persona;
    try {
      persona = this.personas.require(seat.persona);
    } catch (error) {
      return {
        seatId: seat.id,
        persona: seat.persona,
        round,
        status: 'failed',
        error: errorMessage(error),
      };
    }
    const result = await this.safeCall({
      system: buildCouncilVoterSystemPrompt(persona),
      userPrompt: buildCouncilVoterUserPrompt(question, seat, {
        refusalOptionId: question.options?.length ? this.refusalOptionId : undefined,
        ...(ctx.previous
          ? {
              deliberation: {
                round,
                totalRounds: profile.deliberationRounds,
                previous: ctx.previous,
              },
            }
          : {}),
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
        round,
        status: question.signal?.aborted ? 'cancelled' : 'failed',
        ...metadata,
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
        round,
        status: 'invalid',
        ...metadata,
        error: withTruncationNote(parsed.error, result, profile.voterMaxTokens),
      };
    }
    return markChange({
      seatId: seat.id,
      persona: seat.persona,
      round,
      status: 'valid',
      ...parsed.vote,
      ...metadata,
    });
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
    roundVotes: readonly (readonly CouncilVoteResult[])[],
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
        roundVotes,
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
        roundVotes,
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
        roundVotes,
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
        roundVotes,
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
        roundVotes,
        errors: errors.some((entry) => entry.includes(reason)) ? errors : [...errors, reason],
        judgeUsed: true,
      });
    }
    if (!judged.ok) {
      return resultEnvelope({
        status: question.signal?.aborted ? 'cancelled' : signal.aborted ? 'failed' : 'abstained',
        reason: judged.error,
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        roundVotes,
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
        roundVotes,
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
      roundVotes,
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
    roundVotes: readonly (readonly CouncilVoteResult[])[],
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
        roundVotes,
        errors,
      });
    }
    if (!profile.judge) {
      if (divergentStances(valid)) {
        return resultEnvelope({
          status: 'abstained',
          reason: 'Council produced multiple distinct stances and has no judge to reconcile them.',
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
        roundVotes,
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
        roundVotes,
        errors: errors.some((entry) => entry.includes(reason)) ? errors : [...errors, reason],
        judgeUsed: true,
      });
    }
    if (!judged.ok) {
      return resultEnvelope({
        status: question.signal?.aborted ? 'cancelled' : 'failed',
        reason: judged.error,
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        roundVotes,
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
      roundVotes,
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
      if (signal.aborted && !question.signal?.aborted) {
        return { ok: false, error: OVERALL_TIMEOUT_REASON };
      }
      if (question.signal?.aborted) {
        return { ok: false, error: CALL_CANCELLED_REASON };
      }
      return { ok: false, error: result.error };
    }
    const judged = parseJudge(result.text, question, this.refusalOptionId);
    if (!judged.ok) {
      return {
        ok: false,
        error: withTruncationNote(judged.error, result, profile.judgeMaxTokens),
      };
    }
    return judged;
  }

  private resolveCaller(seatIndex?: number): CouncilLLMCaller {
    if (seatIndex !== undefined) {
      if (this.seatCaller) return this.seatCaller(seatIndex);
      return (this.caller ?? this.judgeCaller) as CouncilLLMCaller;
    }
    if (this.judgeCaller) return this.judgeCaller;
    if (this.seatCaller) return this.seatCaller(0);
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

  private resolveCouncilTarget(
    target?: CouncilModelTarget | undefined,
  ): CouncilModelTarget | undefined {
    if (!target) return undefined;
    if (!target.fallbackProfile) return target;

    const mgr = this.fallbackProfileManager;
    if (!mgr) return target;
    const chain = mgr.resolve(target.fallbackProfile);
    if (chain.length === 0) return target;

    const combined = [
      ...chain.map((e) => `${e.providerId}/${e.model}`),
      ...(target.fallbackModels ?? []),
    ];
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

import type {
  CouncilQuestion,
  CouncilResult,
  CouncilVoteResult,
  ResolvedCouncilProfile,
  ResolvedCouncilSeat,
} from '@wrongstack/contracts/types/council';
import { CouncilOrchestratorCore } from './council-orchestrator-core.js';
import {
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
  resultEnvelope,
  type UsageAccumulator,
  validateRefusalCollision,
} from './council-orchestrator-helpers.js';
import { buildCouncilVoterSystemPrompt, buildCouncilVoterUserPrompt } from './council-prompts.js';
import {
  type CouncilQuestionResolutionHost,
  resolveOpenCouncilQuestion,
  resolveOptionCouncilQuestion,
} from './council-question-resolution.js';
import { errorMessage, parseVote, withTruncationNote } from './council-response-parser.js';

export type { CouncilOrchestratorOptions } from './council-orchestrator-core.js';
export { COUNCIL_REFUSAL_OPTION_ID, DEFAULT_COUNCIL_MAX_CONCURRENCY, MAX_COUNCIL_CONCURRENCY };

/** Provider-neutral Council runner backed by an injected one-shot LLM caller. */
export class CouncilOrchestrator extends CouncilOrchestratorCore {
  async ask(
    question: CouncilQuestion,
    onVote?: (vote: CouncilVoteResult) => void,
  ): Promise<CouncilResult> {
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
          let vote: CouncilVoteResult;
          try {
            vote = await this.callSeat(question, profile, seat, i, signal, usage, {
              round,
              ...(previous ? { previous } : {}),
            });
          } catch (error) {
            const timedOut = signal.aborted && !question.signal?.aborted;
            vote = {
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
          // Observers cannot change the ballot or break arbitration.
          try {
            onVote?.({ ...vote });
          } catch {
            /* telemetry is best-effort */
          }
          return vote;
        },
      );
      roundVotes.push(current);
      votes = current;
      // Stop deliberating the moment the budget is gone. Carrying on would
      // spend a whole extra wave of calls that can only come back aborted,
      // and would overwrite a usable round with a wave of failures.
      if (signal.aborted) break;

      // Early short-circuit: if a seat with veto power cast a refusal, the
      // decision is already terminal (veto cannot be overturned in subsequent
      // rounds). Break immediately to save token spend and latency.
      const hasVeto = current.some(
        (v) =>
          v.status === 'valid' &&
          v.optionId === this.refusalOptionId &&
          profile.seats.find((s) => s.id === v.seatId)?.veto === true,
      );
      if (hasVeto) break;
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
      ...(votes[0]?.round !== undefined && votes[0].round < roundVotes.length
        ? [
            `Council retained round ${votes[0].round} because later rounds produced no valid ballots.`,
          ]
        : []),
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
      return resolveOpenCouncilQuestion(
        this.questionResolutionHost(),
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
    return resolveOptionCouncilQuestion(
      this.questionResolutionHost(),
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
  private questionResolutionHost(): CouncilQuestionResolutionHost {
    return {
      refusalOptionId: this.refusalOptionId,
      callJudge: (...args) => this.callJudge(...args),
    };
  }
}

/**
 * Turning a council's final ballots into a result: weighted option tallies
 * (with judge tie-break) and open-question stance synthesis.
 */

import type {
  CouncilModelTarget,
  CouncilQuestion,
  CouncilResult,
  CouncilVoteResult,
  ResolvedCouncilProfile,
} from '@wrongstack/contracts/types/council';
import {
  CALL_CANCELLED_REASON,
  OVERALL_TIMEOUT_REASON,
  optionLabel,
  resultEnvelope,
  type UsageAccumulator,
} from './council-orchestrator-helpers.js';
import { resolveCouncilVotes } from './council-resolution.js';
import { divergentStances, type ParsedJudge } from './council-response-parser.js';

/** What resolution needs from the orchestrator: the refusal id and its judge call. */
export interface CouncilQuestionResolutionHost {
  readonly refusalOptionId: string;
  callJudge(
    question: CouncilQuestion,
    profile: ResolvedCouncilProfile,
    votes: CouncilVoteResult[],
    target: CouncilModelTarget,
    reason: string,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<{ ok: true; value: ParsedJudge } | { ok: false; error: string }>;
}

export async function resolveOptionCouncilQuestion(
  host: CouncilQuestionResolutionHost,
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
    refusalOptionId: host.refusalOptionId,
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

  const judged = await host.callJudge(
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
  if (judged.value.optionId === host.refusalOptionId) {
    return resultEnvelope({
      status: 'denied',
      optionId: host.refusalOptionId,
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

export async function resolveOpenCouncilQuestion(
  host: CouncilQuestionResolutionHost,
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
        roundVotes,
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
        roundVotes,
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

  const judged = await host.callJudge(
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

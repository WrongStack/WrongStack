import type {
  CouncilQuestion,
  CouncilResult,
  CouncilUsage,
  CouncilVoteResult,
  ResolvedCouncilProfile,
  ResolvedCouncilSeat,
} from '../types/council.js';
import type { OneShotLLMResult } from '../types/one-shot-llm.js';

export const COUNCIL_REFUSAL_OPTION_ID = 'council_refuse';
export const DEFAULT_COUNCIL_MAX_CONCURRENCY = 3;
export const MAX_COUNCIL_CONCURRENCY = 8;

export const OVERALL_TIMEOUT_REASON = 'Council overall timeout exceeded.';
export const CALL_CANCELLED_REASON = 'Cancelled.';

export interface UsageAccumulator {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function validateConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_COUNCIL_CONCURRENCY) {
    throw new Error(
      `CouncilOrchestrator: maxConcurrency must be an integer in [1, ${MAX_COUNCIL_CONCURRENCY}].`,
    );
  }
  return value;
}

export function validateRefusalCollision(question: CouncilQuestion, refusalOptionId: string): void {
  if (question.options?.some((option) => option.id.trim() === refusalOptionId)) {
    throw new Error(`CouncilOrchestrator: option id "${refusalOptionId}" is reserved.`);
  }
}

export function optionLabel(
  question: CouncilQuestion,
  optionId: string | undefined,
): string | undefined {
  if (!optionId) return undefined;
  return question.options?.find((option) => option.id.trim() === optionId)?.label.trim();
}

export async function mapConcurrent<T, R>(
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

export function distinctTargetKeys(
  votes: readonly CouncilVoteResult[],
  profile: ResolvedCouncilProfile,
): string[] {
  const keys: string[] = [];
  for (const vote of votes) {
    if (vote.status !== 'valid') continue;
    const provider = vote.provider?.trim() ?? '';
    const model = vote.model?.trim() ?? '';
    if (profile.distinctness === 'provider') {
      if (provider) keys.push(provider);
    } else if (provider || model) {
      keys.push(`${provider}/${model}`);
    }
  }
  return keys;
}

export function distinctTargetCount(
  votes: readonly CouncilVoteResult[],
  profile: ResolvedCouncilProfile,
): number {
  return new Set(distinctTargetKeys(votes, profile)).size;
}

export function distinctnessWarnings(
  votes: readonly CouncilVoteResult[],
  profile: ResolvedCouncilProfile,
): string[] {
  if (profile.distinctness === 'none') return [];
  const keys = distinctTargetKeys(votes, profile);
  const distinct = new Set(keys).size;
  if (keys.length > 1 && distinct < keys.length) {
    return [
      `Council distinctness policy "${profile.distinctness}" was not met: ${distinct} distinct target(s) served ${keys.length} valid vote(s).`,
    ];
  }
  return [];
}

/**
 * Panel-integrity warnings specific to deliberation.
 *
 * Deliberation buys information at the cost of independence, and the failure
 * mode is silent: a panel that CONFORMS produces a clean unanimous verdict
 * that looks better than the split it started from. These warnings are the
 * only signal that the unanimity was manufactured.
 *
 * Structural, never content — same contract as `distinctnessWarnings`.
 */
export function deliberationWarnings(
  roundVotes: readonly (readonly CouncilVoteResult[])[],
  profile: ResolvedCouncilProfile,
): string[] {
  if (roundVotes.length < 2) return [];
  const previous = roundVotes[roundVotes.length - 2];
  const final = roundVotes[roundVotes.length - 1];
  if (!previous || !final) return [];
  const changed = final.filter((vote) => vote.changed === true).length;
  const validFinal = final.filter((vote) => vote.status === 'valid').length;
  if (validFinal === 0) return [];

  const warnings: string[] = [];
  // A majority of the panel abandoning its position in one round is the
  // signature of conformity, not of one decisive argument.
  if (changed > validFinal / 2) {
    warnings.push(
      `Council deliberation moved ${changed} of ${validFinal} valid vote(s) in the final round — ` +
        'a majority of the panel changed position, which reads as convergence rather than independent revision.',
    );
  }
  // A seat with veto power that folds has surrendered the one thing it was
  // seated for; the panel's safety property quietly disappears.
  const foldedVeto = final.filter(
    (vote) =>
      vote.changed === true && profile.seats.find((seat) => seat.id === vote.seatId)?.veto === true,
  );
  for (const vote of foldedVeto) {
    warnings.push(
      `Council deliberation: veto seat "${vote.seatId}" changed its vote after seeing the other ballots.`,
    );
  }
  return warnings;
}

export function cancelledVote(seat: ResolvedCouncilSeat): CouncilVoteResult {
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

export function callMetadata(
  result: OneShotLLMResult,
): Omit<CouncilVoteResult, 'seatId' | 'persona' | 'status'> {
  return {
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.model ? { model: result.model } : {}),
    ...(result.fromFallback ? { fromFallback: true } : {}),
    durationMs: result.durationMs,
  };
}

export function addUsage(usage: UsageAccumulator, result: OneShotLLMResult): void {
  usage.calls += Math.max(1, result.attempts ?? 1);
  usage.inputTokens += result.tokens.input;
  usage.outputTokens += result.tokens.output;
  usage.totalTokens += result.tokens.total;
}

export function usageResult(usage: UsageAccumulator, startedAt: number): CouncilUsage {
  return Object.freeze({ ...usage, durationMs: Math.max(0, Date.now() - startedAt) });
}

export function resultEnvelope(input: {
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
  /**
   * Every round's ballots, oldest first. Omit for a single-round panel; the
   * envelope then reports one round holding `votes`.
   */
  roundVotes?: readonly (readonly CouncilVoteResult[])[] | undefined;
}): CouncilResult {
  const validVoteCount = input.votes.filter((vote) => vote.status === 'valid').length;
  const roundVotes: readonly (readonly CouncilVoteResult[])[] = input.roundVotes ?? [
    Object.freeze([...input.votes]),
  ];
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
    rounds: roundVotes.length,
    roundVotes: Object.freeze(roundVotes.map((round) => Object.freeze([...round]))),
    // Counted from the ballots themselves rather than passed in: a seat marks
    // its own `changed` when it is re-polled, so every exit path of the
    // orchestrator reports the same number without having to remember to.
    deliberationChanges: input.votes.filter((vote) => vote.changed === true).length,
  };
}

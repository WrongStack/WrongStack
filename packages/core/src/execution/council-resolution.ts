/**
 * Provider- and Brain-independent council vote resolution.
 *
 * This module contains only deterministic quorum, veto, weighted-majority,
 * refusal, and judge-escalation rules. LLM calls, prompts, parsing, and host
 * decision types belong in adapters such as `council-brain.ts`.
 */

export interface CouncilResolutionSeat {
  id: string;
  /** Vote weight in the tally. Default 1. */
  weight?: number | undefined;
  /** A refusal from this seat immediately denies the proposal. */
  veto?: boolean | undefined;
}

export interface CouncilResolutionVote {
  seatId: string;
  optionId: string;
}

export interface CouncilResolutionInput {
  seats: readonly CouncilResolutionSeat[];
  votes: readonly CouncilResolutionVote[];
  refusalOptionId: string;
  /** Fraction of configured seats required to return a vote. */
  quorumFraction: number;
  /** Winning weight must exceed this fraction of cast weight. */
  approvalFraction: number;
}

export type CouncilResolution =
  | {
      status: 'abstained';
      reason: 'quorum_not_met';
      validVoteCount: number;
      seatCount: number;
    }
  | {
      status: 'denied';
      method: 'veto';
      optionId: string;
      seatId: string;
    }
  | {
      status: 'denied';
      method: 'refusal';
      optionId: string;
      winningWeight: number;
      castWeight: number;
    }
  | {
      status: 'decided';
      method: 'majority';
      optionId: string;
      winningWeight: number;
      castWeight: number;
    }
  | {
      status: 'needs_judge';
      reason: 'tie' | 'approval_threshold_not_met';
      castWeight: number;
    };

/** Resolve already-parsed council votes without performing any I/O. */
export function resolveCouncilVotes(input: CouncilResolutionInput): CouncilResolution {
  validateInput(input);

  const seatById = new Map(input.seats.map((seat) => [seat.id, seat] as const));
  const validVotes: CouncilResolutionVote[] = [];
  const votedSeatIds = new Set<string>();
  for (const vote of input.votes) {
    if (!seatById.has(vote.seatId) || votedSeatIds.has(vote.seatId)) continue;
    votedSeatIds.add(vote.seatId);
    validVotes.push(vote);
  }

  if (validVotes.length / input.seats.length < input.quorumFraction) {
    return {
      status: 'abstained',
      reason: 'quorum_not_met',
      validVoteCount: validVotes.length,
      seatCount: input.seats.length,
    };
  }

  const veto = validVotes.find(
    (vote) =>
      vote.optionId === input.refusalOptionId && seatById.get(vote.seatId)?.veto === true,
  );
  if (veto) {
    return {
      status: 'denied',
      method: 'veto',
      optionId: veto.optionId,
      seatId: veto.seatId,
    };
  }

  const weightByOption = new Map<string, number>();
  let castWeight = 0;
  for (const vote of validVotes) {
    const weight = seatById.get(vote.seatId)?.weight ?? 1;
    castWeight += weight;
    weightByOption.set(vote.optionId, (weightByOption.get(vote.optionId) ?? 0) + weight);
  }

  let winner: { optionId: string; weight: number } | undefined;
  let contested = false;
  for (const [optionId, weight] of weightByOption) {
    if (!winner || weight > winner.weight) {
      winner = { optionId, weight };
      contested = false;
    } else if (weight === winner.weight) {
      contested = true;
    }
  }

  const decisive =
    winner !== undefined &&
    !contested &&
    winner.weight > input.approvalFraction * castWeight;

  if (!decisive || !winner) {
    return {
      status: 'needs_judge',
      reason: contested ? 'tie' : 'approval_threshold_not_met',
      castWeight,
    };
  }

  if (winner.optionId === input.refusalOptionId) {
    return {
      status: 'denied',
      method: 'refusal',
      optionId: winner.optionId,
      winningWeight: winner.weight,
      castWeight,
    };
  }

  return {
    status: 'decided',
    method: 'majority',
    optionId: winner.optionId,
    winningWeight: winner.weight,
    castWeight,
  };
}

function validateInput(input: CouncilResolutionInput): void {
  if (input.seats.length === 0) {
    throw new Error('resolveCouncilVotes: at least one seat is required.');
  }
  requireFraction(input.quorumFraction, 'quorumFraction');
  requireFraction(input.approvalFraction, 'approvalFraction');

  const seatIds = new Set<string>();
  for (const seat of input.seats) {
    if (!seat.id.trim()) throw new Error('resolveCouncilVotes: seat id must not be empty.');
    if (seatIds.has(seat.id)) {
      throw new Error(`resolveCouncilVotes: duplicate seat id "${seat.id}".`);
    }
    seatIds.add(seat.id);
    if (seat.weight !== undefined && (!Number.isFinite(seat.weight) || seat.weight <= 0)) {
      throw new Error(`resolveCouncilVotes: invalid weight for seat "${seat.id}".`);
    }
  }
}

function requireFraction(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`resolveCouncilVotes: ${label} must be in (0, 1].`);
  }
}

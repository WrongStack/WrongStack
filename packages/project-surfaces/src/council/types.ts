/** Brain council panels: one seat per model, a tally, and the card that shows them. */
export type CouncilVoteStatus = 'valid' | 'invalid' | 'failed' | 'cancelled';

/** One council seat's observable vote. No hidden chain-of-thought is retained. */
export interface CouncilSeatVote {
  seatId: string;
  persona: string;
  status: CouncilVoteStatus | string;
  /** The option this seat voted for, on an option-bearing question. */
  optionId?: string | undefined;
  /** Free-text stance / rationale; only present when trace content is full. */
  stance?: string | undefined;
  rationale?: string | undefined;
  providerId?: string | undefined;
  model?: string | undefined;
  veto?: boolean | undefined;
  weight?: number | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
  /** Deliberation round this ballot came from; 1 is the independent round. */
  round?: number | undefined;
  /** The seat changed its vote after seeing the other seats' ballots. */
  changed?: boolean | undefined;
  at: number;
}

export interface CouncilDecisionData {
  requestId?: string | undefined;
  phase?: 'voting' | 'resolved' | undefined;
  startedAt?: number | undefined;
  resolvedAt?: number | undefined;
  status?: string | undefined;
  resolution?: string | undefined;
  optionId?: string | undefined;
  question?: string | undefined;
  reason?: string | undefined;
  configuredSeatCount?: number | undefined;
  validVoteCount?: number | undefined;
  distinctTargetCount?: number | undefined;
  judgeUsed?: boolean | undefined;
  judgeModel?: string | undefined;
  /** The tie-breaker had already cast one of the votes it is breaking. */
  judgeIsVoter?: boolean | undefined;
  judgeRationale?: string | undefined;
  totalTokens?: number | undefined;
  durationMs?: number | undefined;
  /** Deliberation rounds run (1 = none) and seats that moved in the last one. */
  rounds?: number | undefined;
  deliberationChanges?: number | undefined;
  warnings?: string[] | undefined;
  seats: CouncilSeatVote[];
}

/** Provider-neutral model routing hints for one Council seat or judge. */
export interface CouncilModelTarget {
  /** Optional provider id. Omit to use role routing or the session default. */
  providerId?: string | undefined;
  /** Optional model id. Omit to use role routing or the session default. */
  model?: string | undefined;
  /** Model-matrix role used before explicit/default target resolution. */
  role?: string | undefined;
  /** Named fallback profile from the host configuration. */
  fallbackProfile?: string | undefined;
  /** Explicit fallback model references, in priority order. */
  fallbackModels?: readonly string[] | undefined;
}

/** A reusable decision lens available to Council profiles. */
export interface CouncilPersona {
  id: string;
  name: string;
  description: string;
  /** Trusted system-level instruction for this decision lens. */
  instruction: string;
  defaultWeight?: number | undefined;
  defaultVeto?: boolean | undefined;
  tags?: readonly string[] | undefined;
}

/** One configurable voting seat. Defaults are inherited from its persona. */
export interface CouncilSeatConfig {
  id?: string | undefined;
  label?: string | undefined;
  persona: string;
  target?: CouncilModelTarget | undefined;
  /**
   * Vote weight in the tally. Ignored for optionless questions — open
   * stances are not tallied, so every valid stance counts once.
   */
  weight?: number | undefined;
  veto?: boolean | undefined;
}

/** A normalized seat ready for orchestration. */
export interface ResolvedCouncilSeat {
  id: string;
  label: string;
  persona: string;
  target?: CouncilModelTarget | undefined;
  /** Vote weight in the tally. No-op for optionless questions (see above). */
  weight: number;
  veto: boolean;
}

export interface CouncilOption {
  id: string;
  label: string;
  consequence?: string | undefined;
}

/** How strictly the orchestrator should enforce independent serving targets. */
export type CouncilDistinctness = 'none' | 'model' | 'provider';

/** User/config supplied Council profile. Missing policy fields receive defaults. */
export interface CouncilProfileConfig {
  id: string;
  name?: string | undefined;
  description?: string | undefined;
  seats: readonly CouncilSeatConfig[];
  /** False disables judging. Omitted profiles also default to no judge. */
  judge?: CouncilModelTarget | false | undefined;
  quorumFraction?: number | undefined;
  /**
   * Winning option must exceed this fraction of cast vote weight. No-op for
   * optionless questions — open stances are not tallied; divergence is
   * escalated instead (see `resolveOpenQuestion`).
   */
  approvalFraction?: number | undefined;
  distinctness?: CouncilDistinctness | undefined;
  voterMaxTokens?: number | undefined;
  judgeMaxTokens?: number | undefined;
  perCallTimeoutMs?: number | undefined;
  overallTimeoutMs?: number | undefined;
  /**
   * How many voting rounds the panel runs. Default
   * {@link DEFAULT_COUNCIL_DELIBERATION_ROUNDS}.
   *
   * Round 1 is always independent: no seat sees any other. From round 2 on,
   * each seat is shown the OTHER seats' previous ballots and votes again, so
   * a seat that missed a consequence another lens caught can revise. Only the
   * FINAL round is tallied.
   *
   * The cost is linear: N rounds means N x seats provider calls, every time.
   *
   * Deliberation trades independence for information, and that trade is not
   * free — models converge on a stated majority whether or not the majority
   * brought an argument. The voter instruction counters this explicitly
   * ("agreement is not evidence"), and `deliberationChanges` on the result
   * reports how many seats actually moved, which is the number to watch: a
   * panel where most seats flip every round has stopped being a panel.
   */
  deliberationRounds?: number | undefined;
}

/** Fully validated profile used by the future Council orchestrator. */
export interface ResolvedCouncilProfile {
  id: string;
  name: string;
  description: string;
  seats: readonly ResolvedCouncilSeat[];
  judge: CouncilModelTarget | false;
  quorumFraction: number;
  /** No-op for optionless questions (see the config-level doc above). */
  approvalFraction: number;
  distinctness: CouncilDistinctness;
  voterMaxTokens: number;
  judgeMaxTokens: number;
  perCallTimeoutMs: number;
  overallTimeoutMs: number;
  /** Voting rounds to run; 1 disables deliberation. See the config doc. */
  deliberationRounds: number;
}

/** Generic question accepted by a Council orchestrator. */
export interface CouncilQuestion {
  id?: string | undefined;
  question: string;
  context?: string | undefined;
  options?: readonly CouncilOption[] | undefined;
  /** Profile id or an ad-hoc profile. Default profile is host-defined. */
  profile?: string | CouncilProfileConfig | undefined;
  signal?: AbortSignal | undefined;
}

export type CouncilVoteStatus = 'valid' | 'invalid' | 'failed' | 'cancelled';

/** One observable seat outcome. No hidden chain-of-thought is retained. */
export interface CouncilVoteResult {
  seatId: string;
  persona: string;
  status: CouncilVoteStatus;
  /**
   * 1-based deliberation round this ballot was cast in. Absent on ballots
   * from callers that predate deliberation; 1 means the independent round.
   */
  round?: number | undefined;
  /**
   * True when this ballot differs from the same seat's previous round — the
   * seat was persuaded. Only meaningful from round 2 on.
   */
  changed?: boolean | undefined;
  optionId?: string | undefined;
  stance?: string | undefined;
  rationale?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  fromFallback?: boolean | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
}

export type CouncilResolutionMethod =
  | 'majority'
  | 'veto'
  | 'refusal'
  | 'judge'
  | 'first_stance'
  | 'none';

export interface CouncilUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
}

/** Structured, host-neutral result returned by a Council orchestrator. */
export interface CouncilResult {
  status: 'decided' | 'denied' | 'abstained' | 'failed' | 'cancelled';
  answer?: string | undefined;
  optionId?: string | undefined;
  reason?: string | undefined;
  resolution: CouncilResolutionMethod;
  votes: readonly CouncilVoteResult[];
  configuredSeatCount: number;
  validVoteCount: number;
  distinctTargetCount: number;
  judgeUsed: boolean;
  usage: CouncilUsage;
  warnings?: readonly string[] | undefined;
  errors?: readonly string[] | undefined;
  /**
   * Deliberation rounds actually run. 1 means the panel voted once, which is
   * the whole of the pre-deliberation behaviour.
   */
  rounds: number;
  /**
   * Every round's ballots, oldest first. The last entry is `votes` — the
   * tallied round. Kept so a decision stays reconstructable: without it,
   * "the panel was unanimous" is indistinguishable from "the panel was split
   * and then conformed", and those are very different verdicts.
   */
  roundVotes: readonly (readonly CouncilVoteResult[])[];
  /**
   * Ballots that changed in the final round versus the round before it.
   *
   * The health metric for deliberation: 0 means the extra rounds bought
   * nothing but cost, and a number near the seat count every time means the
   * panel is conforming rather than reasoning.
   */
  deliberationChanges: number;
}

/** Minimal structural dependency implemented by OneShotOrchestrator. */
export interface CouncilLLMCaller {
  call(
    input: import('./one-shot-llm.js').OneShotLLMInput,
  ): Promise<import('./one-shot-llm.js').OneShotLLMResult>;
}

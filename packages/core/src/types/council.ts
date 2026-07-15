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
  weight?: number | undefined;
  veto?: boolean | undefined;
}

/** A normalized seat ready for orchestration. */
export interface ResolvedCouncilSeat {
  id: string;
  label: string;
  persona: string;
  target?: CouncilModelTarget | undefined;
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
  approvalFraction?: number | undefined;
  distinctness?: CouncilDistinctness | undefined;
  voterMaxTokens?: number | undefined;
  judgeMaxTokens?: number | undefined;
  perCallTimeoutMs?: number | undefined;
  overallTimeoutMs?: number | undefined;
}

/** Fully validated profile used by the future Council orchestrator. */
export interface ResolvedCouncilProfile {
  id: string;
  name: string;
  description: string;
  seats: readonly ResolvedCouncilSeat[];
  judge: CouncilModelTarget | false;
  quorumFraction: number;
  approvalFraction: number;
  distinctness: CouncilDistinctness;
  voterMaxTokens: number;
  judgeMaxTokens: number;
  perCallTimeoutMs: number;
  overallTimeoutMs: number;
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
}

/** Minimal structural dependency implemented by OneShotOrchestrator. */
export interface CouncilLLMCaller {
  call(
    input: import('./one-shot-llm.js').OneShotLLMInput,
  ): Promise<import('./one-shot-llm.js').OneShotLLMResult>;
}

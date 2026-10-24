/** TypeSafe System One wire contracts. Client implementation: `typesafe/client.ts`. */

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string } | undefined;
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Option id -> rubric text (`null` when the id speaks for itself). */
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /**
   * Ordered level descriptions, lowest first. The API requires at least two,
   * and each level has to describe a concrete situation that stands on its
   * own — a bare "medium" cannot be judged against anything.
   */
  criteria: string[];
}

export type TypeSafeQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  /** Probability the answer is yes, 0..1. */
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  /** The highest-probability option id. */
  choice: string;
  /** Every option id mapped to its probability; sums to 1. */
  probabilities: Record<string, number>;
  /** Distribution concentration, 0..1 — NOT a correctness estimate. */
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted position across the levels we sent. */
  score: number;
  /** Level label -> probability. */
  probabilities: Record<string, number>;
  /** Distribution concentration, 0..1 — NOT a correctness estimate. */
  confidence: number;
  /** Level index -> the criteria text it came from, as the API echoes it. */
  legend: Record<string, string>;
}

export type TypeSafeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResult {
  answers: Record<string, TypeSafeAnswer>;
  usage: { inputTokens: number; outputTokens: number };
  /**
   * The model id the service says answered.
   *
   * Worth keeping even though we sent it: `jev-latest` is an ALIAS, and the
   * version behind it moves. A threshold calibrated against one version and a
   * trace that cannot name the version it was collected under is a silent
   * drift waiting to happen — every eval row records this.
   *
   * Optional rather than required: a response is not obliged to echo it, and
   * forcing every caller that constructs a result — chiefly test stubs — to
   * carry a field they do not exercise buys nothing.
   */
  model?: string | undefined;
}

export interface SystemOneRequest {
  /** Local activity attribution; never sent to the service. */
  activityFeature?: string | undefined;
  activityPurpose?: 'runtime' | 'self-test' | undefined;
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
  model?: string | undefined;
}

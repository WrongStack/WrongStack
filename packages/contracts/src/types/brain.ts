/**
 * Brain decision vocabulary and config contracts (`config.brain.*`).
 * The arbiter, rule engine and heuristics that consume them live in
 * `brain/brain*.ts`, which re-export these names.
 */

export type BrainDecisionSource = 'goal' | 'director' | 'tool' | 'user' | 'system';

export type BrainRisk = 'low' | 'medium' | 'high' | 'critical';

export type BrainFallback = 'ask_human' | 'deny' | 'continue';

export interface BrainDecisionOption {
  id: string;
  label: string;
  consequence?: string | undefined;
  risk?: BrainRisk | undefined;
  recommended?: boolean | undefined;
}

export interface BrainDecisionRequest {
  id: string;
  /** Active host session id for surfaces that multiplex multiple sessions. */
  sessionId?: string | undefined;
  source: BrainDecisionSource;
  question: string;
  context?: string | undefined;
  options?: BrainDecisionOption[] | undefined;
  risk: BrainRisk;
  /** What a non-LLM/default Brain should do when policy cannot decide safely. */
  fallback: BrainFallback;
  /** False when the caller already exhausted its human wait window. */
  allowHumanEscalation?: boolean | undefined;
}

export type BrainDecision =
  | {
      type: 'answer';
      optionId?: string | undefined;
      text: string;
      rationale?: string | undefined;
    }
  | {
      type: 'ask_human';
      prompt: string;
      options?: BrainDecisionOption[] | undefined;
      rationale?: string | undefined;
    }
  | {
      type: 'deny';
      reason: string;
    };

export interface BrainArbiter {
  decide(request: BrainDecisionRequest): Promise<BrainDecision>;
}

/**
 * The tier that produced a decision, cheapest first.
 *
 * - `rule`        — a configured deterministic `BrainRule` matched.
 * - `policy`      — `DefaultBrainArbiter` fallback semantics.
 * - `heuristic`   — a built-in pattern heuristic (quickDecide / blocked-resolved).
 * - `cache`       — a previous identical decision was replayed.
 * - `ledger-guard`— denied deterministically from observed failure history.
 * - `system-one`  — a TypeSafe System One Choice settled it (cheap, not free).
 * - `council`     — the multi-LLM panel decided.
 * - `llm`         — the single-LLM tier decided.
 * - `terminal`    — headless terminal policy (no human available).
 * - `human`       — a person answered the escalation prompt.
 */
export type BrainDecisionTier =
  | 'rule'
  | 'policy'
  | 'heuristic'
  | 'cache'
  | 'ledger-guard'
  | 'system-one'
  | 'council'
  | 'llm'
  | 'terminal'
  | 'human';

/**
 * Toggles for the built-in pattern heuristics.
 *
 * These four patterns plus the low-risk fast path used to be unconditional:
 * an operator could change WHEN the expensive tiers run, but never turn off a
 * cheap guess that was firing wrongly for their workload. Each flag defaults
 * to `true`, so an absent config behaves exactly as before.
 */
export interface BrainHeuristicsConfig {
  /** `DefaultBrainArbiter`: auto-answer low-risk requests that carry a recommended option. */
  lowRiskAutoAnswer?: boolean | undefined;
  /** "blocked … + explicit resolution marker in context" → continue. */
  blockedResolved?: boolean | undefined;
  /** "deadlock" + failed work units in context → skip and continue. */
  deadlockSkip?: boolean | undefined;
  /** "failed"/"retry" + demonstrably exhausted retries → mark failed and move on. */
  retryExhausted?: boolean | undefined;
  /** Bare continue/proceed ping with no competing alternative → continue. */
  continuePing?: boolean | undefined;
  /**
   * Replace the resolution markers the `blockedResolved` heuristic looks for.
   * Entries are matched as whole words, case-insensitively, and are regex
   * ESCAPED — this is a word list, not a pattern, so a stray `(` from config
   * cannot break decision-making. Empty/absent keeps the built-in list.
   */
  blockedResolvedMarkers?: string[] | undefined;
}

/** Predicate over a decision request. All present fields must match (AND). */
export interface BrainRuleMatch {
  /** Request source(s). Omitted = any. */
  source?: BrainDecisionSource | BrainDecisionSource[] | undefined;
  /** Exact request risk(s). Omitted = any. */
  risk?: BrainRisk | BrainRisk[] | undefined;
  /** Inclusive lower bound on request risk. */
  minRisk?: BrainRisk | undefined;
  /** Inclusive upper bound on request risk. */
  maxRisk?: BrainRisk | undefined;
  /** Caller-declared fallback(s). Omitted = any. */
  fallback?: BrainFallback | BrainFallback[] | undefined;
  /** true = request must carry options; false = must carry none. */
  hasOptions?: boolean | undefined;
  /** Request must offer an option with this exact id. */
  offersOption?: string | undefined;
  /** Case-insensitive regex the question must match. */
  question?: string | undefined;
  /** Case-insensitive regex the context must match (no context = no match). */
  context?: string | undefined;
  /** Case-insensitive regex the question must NOT match. */
  notQuestion?: string | undefined;
  /** Case-insensitive regex the context must NOT match (no context = passes). */
  notContext?: string | undefined;
}

/** What a matching rule does. */
export type BrainRuleAction =
  | {
      action: 'answer';
      /** Must name an option the request actually offers, else the rule defers. */
      optionId?: string | undefined;
      text?: string | undefined;
      rationale?: string | undefined;
    }
  | { action: 'deny'; reason?: string | undefined }
  | { action: 'escalate'; prompt?: string | undefined }
  /** Match, but hand the request to the next tier anyway. */
  | { action: 'defer' };

/** One deterministic rule from `config.brain.rules`. */
export interface BrainRule {
  /** Stable identifier, surfaced in rationales and telemetry. */
  id: string;
  /** Default true. */
  enabled?: boolean | undefined;
  /** Free-text note for humans; never interpreted. */
  description?: string | undefined;
  /**
   * Maximum times this rule can fire within `windowMs` before deferring to
   * subsequent tiers (infinite rule loop protection). Optional.
   */
  maxHits?: number | undefined;
  /** Window for `maxHits` in ms. Default 60_000 (1 minute). */
  windowMs?: number | undefined;
  when: BrainRuleMatch;
  then: BrainRuleAction;
}

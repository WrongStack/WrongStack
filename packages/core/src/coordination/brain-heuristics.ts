/**
 * Shared heuristic patterns for Brain decision-making.
 *
 * These regexes are used by both `DefaultBrainArbiter` (coordination/brain.ts)
 * and `quickDecide` (execution/autonomy-brain.ts) to detect the
 * blocked-resolved pattern: a question about a blocked task where the
 * context contains explicit evidence that the blocker has been resolved.
 *
 * Extracted to a single module to prevent drift between the two consumers.
 * If you add or remove a resolution marker, update BOTH the regex and the
 * tests in `tests/execution/brain-quickdecide.test.ts`.
 */

/**
 * Resolution markers: words that indicate a blocking dependency has been
 * explicitly resolved in the context. Word-boundary anchored to avoid
 * false positives on substrings (e.g. "unresolved" should NOT match).
 */
export const BLOCKED_RESOLVED_MARKERS =
  /\b(?:resolved|fixed|completed|unblocked|available|done|merged|landed|shipped)\b/;

/**
 * Competing-alternative guard: rejects questions that offer a choice
 * (e.g. "Should we unblock and continue or wait?"). When "or" is present,
 * the question is offering alternatives — not a simple unblock signal.
 */
export const COMPETING_ALTERNATIVE = /\bor\b/;

/**
 * Evaluate the blocked-resolved heuristic against a question/context pair.
 *
 * Returns `true` when:
 * 1. The question mentions "blocked"
 * 2. The question does NOT contain competing alternatives ("or")
 * 3. The context contains an explicit resolution marker
 *
 * Callers must additionally verify:
 * - `request.fallback === 'continue'` (caller declared continue safe)
 * - `!request.options?.length` (no structured choices to override)
 *
 * @param question - Lowercased question text
 * @param context - Lowercased context text
 */
export function isBlockedResolved(
  question: string,
  context: string,
  markers: RegExp = BLOCKED_RESOLVED_MARKERS,
): boolean {
  return (
    question.includes('blocked') && !COMPETING_ALTERNATIVE.test(question) && markers.test(context)
  );
}

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

/** Every heuristic on — the behaviour that predates `BrainHeuristicsConfig`. */
export const DEFAULT_BRAIN_HEURISTICS: Required<
  Omit<BrainHeuristicsConfig, 'blockedResolvedMarkers'>
> = {
  lowRiskAutoAnswer: true,
  blockedResolved: true,
  deadlockSkip: true,
  retryExhausted: true,
  continuePing: true,
};

/** Resolved, fully-populated heuristic settings. */
export interface ResolvedBrainHeuristics
  extends Required<Omit<BrainHeuristicsConfig, 'blockedResolvedMarkers'>> {
  /** Compiled resolution markers for `isBlockedResolved`. */
  blockedResolvedMarkers: RegExp;
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a whole-word, case-insensitive alternation from a marker word list.
 * Returns the built-in pattern when the list yields nothing usable.
 */
export function compileResolutionMarkers(words: readonly string[] | undefined): RegExp {
  const cleaned = (words ?? []).map((w) => w.trim()).filter((w) => w.length > 0);
  if (cleaned.length === 0) return BLOCKED_RESOLVED_MARKERS;
  return new RegExp(`\\b(?:${cleaned.map(escapeRegex).join('|')})\\b`, 'i');
}

/** Fill a partial heuristics config with the all-on defaults. */
export function resolveBrainHeuristics(
  cfg: BrainHeuristicsConfig | undefined,
): ResolvedBrainHeuristics {
  return {
    lowRiskAutoAnswer: cfg?.lowRiskAutoAnswer ?? DEFAULT_BRAIN_HEURISTICS.lowRiskAutoAnswer,
    blockedResolved: cfg?.blockedResolved ?? DEFAULT_BRAIN_HEURISTICS.blockedResolved,
    deadlockSkip: cfg?.deadlockSkip ?? DEFAULT_BRAIN_HEURISTICS.deadlockSkip,
    retryExhausted: cfg?.retryExhausted ?? DEFAULT_BRAIN_HEURISTICS.retryExhausted,
    continuePing: cfg?.continuePing ?? DEFAULT_BRAIN_HEURISTICS.continuePing,
    blockedResolvedMarkers: compileResolutionMarkers(cfg?.blockedResolvedMarkers),
  };
}

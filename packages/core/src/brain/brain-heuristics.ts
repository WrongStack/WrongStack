/**
 * Shared heuristic patterns for Brain decision-making.
 *
 * These regexes are used by both `DefaultBrainArbiter` (brain/brain.ts)
 * and `quickDecide` (execution/autonomy-brain.ts) to detect the
 * blocked-resolved pattern: a question about a blocked task where the
 * context contains explicit evidence that the blocker has been resolved.
 *
 * Extracted to a single module to prevent drift between the two consumers.
 * If you add or remove a resolution marker, update BOTH the regex and the
 * tests in `tests/execution/brain-quickdecide.test.ts`.
 */

import type { BrainHeuristicsConfig } from '@wrongstack/contracts/types/brain';

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
 * Work-unit failure nouns following "failed " in the context.
 */
export const DEADLOCK_FAILED_WORK_PATTERN =
  /\bfailed\s+(?:task|step|job|build|test|phase|stage|item|unit)s?\b/;

/**
 * Patterns that indicate retries have been demonstrably exhausted in the context.
 */
export const RETRY_EXHAUSTED_PATTERN =
  /\bexhausted\b|\b(?:[3-9]|\d{2,})\s+(?:consecutive\s+)?(?:times|attempts|retries|failures)\b|\b(?:attempt|retr(?:y|ies)|failure)s?\W{0,3}(?:[3-9]|\d{2,})\b/;

/** Keywords indicating execution continuation pings. */
export const CONTINUE_PING_PATTERN = /\b(?:continue|proceed)\b/;

/** Keywords indicating explicit stops or aborts. */
export const STOP_PING_PATTERN = /\b(?:stop|abort|halt|cancel|pause|rollback)\b/;

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
    question.includes('blocked') &&
    !COMPETING_ALTERNATIVE.test(question) &&
    // A resolution keyword is evidence only without a competing unresolved
    // state. Do not turn "not fixed", "never completed" or "still failing"
    // into an assertion that a dependency has been resolved.
    !/\b(?:not|never|isn't|isnt|wasn't|wasnt|hasn't|hasnt|haven't|havent|cannot|can't|cant|unresolved|unavailable)\b|\bstill\s+(?:blocked|failing|broken|pending)\b/i.test(
      context,
    ) &&
    markers.test(context)
  );
}

/**
 * Evaluate the deadlock skip heuristic: question mentions deadlock and
 * context mentions failed work units blocking progress.
 */
export function isDeadlockWithFailedWork(question: string, context: string): boolean {
  return question.includes('deadlock') && DEADLOCK_FAILED_WORK_PATTERN.test(context);
}

/**
 * Evaluate the retry exhaustion heuristic: question mentions failure/retry
 * and context contains explicit retry exhaustion evidence.
 */
export function isRetryExhausted(question: string, context: string): boolean {
  return (
    (question.includes('failed') || question.includes('retry')) &&
    RETRY_EXHAUSTED_PATTERN.test(context)
  );
}

/**
 * Evaluate the continue ping heuristic: bare continue/proceed without
 * stop/abort or competing alternatives.
 */
export function isContinuePing(question: string): boolean {
  return (
    CONTINUE_PING_PATTERN.test(question) &&
    !STOP_PING_PATTERN.test(question) &&
    !COMPETING_ALTERNATIVE.test(question)
  );
}

export type { BrainHeuristicsConfig };
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

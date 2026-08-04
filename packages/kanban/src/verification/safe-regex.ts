/**
 * Conservative compilation of a caller-supplied regex, for the verification
 * plugins that accept a pattern from check config.
 *
 * ## Why this is a copy
 *
 * `packages/tools/src/_regex.ts` is the canonical implementation and every
 * other user-regex site in the repo routes through it. `@wrongstack/kanban`
 * sits **below** `core` and `tools` in the workspace graph — it depends only on
 * `@wrongstack/persistence` (pinned by
 * `packages/core/tests/architecture/package-boundaries.test.ts`) — so it cannot
 * import the canonical helper without inverting the layer DAG.
 *
 * Duplication is the lesser evil here, but only because the drift is pinned:
 * `packages/tools/tests/regex-guard-parity.test.ts` imports both this module
 * and `_regex.ts` (tools depends on both) and fails when their verdicts
 * diverge. **Change both, or that test breaks.**
 *
 * ## What it defends
 *
 * V8's regex engine is backtracking-based and a synchronous match cannot be
 * interrupted, so an outer timeout does not save a worker from `(a+)+$`. The
 * pattern here reaches us from kanban check config, which the agent may author
 * from repo content — untrusted under this project's adversary model. Two
 * coarse bounds, matching the canonical helper:
 *
 *  1. Cap pattern length (256 chars).
 *  2. Reject the obvious super-linear constructs. Biased toward
 *     false-positives, which is the correct bias for hostile input.
 *
 * Callers must also bound the SUBJECT — see {@link capSubject}. Guarding the
 * pattern alone still leaves a linear-time regex scanning an unbounded file.
 */

const MAX_PATTERN_LEN = 256;

/** Keep in sync with `DANGEROUS_PATTERNS` in `packages/tools/src/_regex.ts`. */
const DANGEROUS_PATTERNS: ReadonlyArray<RegExp> = [
  // (a+)+, (.*)+, etc — nested quantifier on a group with internal quantifier
  /(\([^)]*[+*][^)]*\))[+*]/,
  /(\(\?:[^)]*[+*][^)]*\))[+*]/,
  // Adjacent quantifiers: a++ a*+
  /[+*]{2,}/,
  // Quantifier on alternation with length 2+
  /\([^|)]+\|[^)]+\)[+*][+*]/,
  // Greedy quantifier inside lookahead/lookbehind — (?!.*a+)
  /[([][^)\]]*[+*][^)\]]*[)\]][^)]*\?\??/,
];

/** Maximum subject length handed to a user-supplied regex. */
export const MAX_SUBJECT_LEN = 64 * 1024;

/** Truncate a subject to {@link MAX_SUBJECT_LEN} before matching. */
export function capSubject(subject: string): string {
  return subject.length > MAX_SUBJECT_LEN ? subject.slice(0, MAX_SUBJECT_LEN) : subject;
}

export type SafeRegexResult =
  | { ok: true; regex: RegExp }
  | { ok: false; reason: string };

/** Compile `pattern`, refusing anything over-long or obviously catastrophic. */
export function compileSafeRegex(pattern: string, flags = ''): SafeRegexResult {
  if (typeof pattern !== 'string') return { ok: false, reason: 'pattern must be a string' };
  if (pattern.length === 0) return { ok: false, reason: 'pattern is empty' };
  if (pattern.length > MAX_PATTERN_LEN) {
    return { ok: false, reason: `pattern exceeds ${MAX_PATTERN_LEN} characters` };
  }
  for (const rx of DANGEROUS_PATTERNS) {
    if (rx.test(pattern)) {
      return {
        ok: false,
        reason:
          'pattern looks vulnerable to catastrophic backtracking — rewrite without nested quantifiers',
      };
    }
  }
  try {
    return { ok: true, regex: new RegExp(pattern, flags) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'invalid regex' };
  }
}

/**
 * Compile a user-supplied regex with conservative bounds against ReDoS.
 *
 * Duplicated from @wrongstack/tools/_regex.ts to avoid a circular
 * dependency (tools depends on core, not vice versa). There is a THIRD copy —
 * `@wrongstack/kanban/src/verification/safe-regex.ts` — which sits below both
 * in the workspace DAG for the same reason. This header used to say "keep
 * both copies in sync", unaware of the third, and this copy had drifted the
 * furthest: 2 of the 5 heuristics, a 512-character cap instead of 256, and no
 * subject cap at all. `packages/tools/tests/regex-guard-parity.test.ts` now
 * holds all three to the same verdicts — change one, change all three.
 *
 * V8's regex engine is backtracking-based and cannot interrupt a
 * synchronous match — a pattern like `(a+)+$` against a sufficiently
 * long line will pin a worker for seconds.
 */

const MAX_PATTERN_LEN = 256;

// Heuristics for catastrophic-backtracking constructs.
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

export interface CompileResult {
  ok: true;
  regex: RegExp;
}

export interface CompileFail {
  ok: false;
  reason: string;
}

export function compileUserRegex(pattern: string, flags: string): CompileResult | CompileFail {
  if (typeof pattern !== 'string') {
    return { ok: false, reason: 'pattern must be a string' };
  }
  if (pattern.length === 0) {
    return { ok: false, reason: 'pattern is empty' };
  }
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
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'invalid regex',
    };
  }
}

/**
 * Truncate a subject line to a safe length for synchronous regex eval.
 *
 * The canonical copy has always shipped this; this one did not, so callers
 * here bounded the pattern but never the SUBJECT — and a linear-time pattern
 * over a multi-megabyte line is still a stall.
 */
export const MAX_SUBJECT_LEN = 64 * 1024;

export function capSubject(line: string): string {
  return line.length > MAX_SUBJECT_LEN ? line.slice(0, MAX_SUBJECT_LEN) : line;
}

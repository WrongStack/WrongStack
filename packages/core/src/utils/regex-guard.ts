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
  /\(\?<?[!=][^)]*[+*][^)]*\)/,
];

/**
 * Ambiguous quantified alternation — `(a|a)*`, `(a|ab)+` — backtracks
 * exponentially with a SINGLE outer quantifier because two branches can
 * consume the same prefix (measured: 7s on a 27-char subject, synchronous
 * and uninterruptible). The DANGEROUS_PATTERNS rule above only rejects a
 * DOUBLED quantifier after the group, so this class sailed through. Flag
 * a quantified group whose top-level branches are identical, prefix-related,
 * or empty; disjoint branches (`(foo|bar)+`) stay allowed. Character-class
 * overlap (`(\w|a)*`) remains undetected — the durable fix is a
 * step-budgeted matcher.
 *
 * Keep in sync with `packages/tools/src/_regex.ts` and
 * `packages/kanban/src/verification/safe-regex.ts` (regex-guard-parity.test.ts pins
 * all three).
 */
function hasAmbiguousQuantifiedAlternation(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '(') continue;
    if (i > 0 && pattern[i - 1] === '\\') continue;
    let depth = 0;
    let inClass = false;
    let j = i;
    for (; j < pattern.length; j++) {
      const ch = pattern[j];
      if (ch === '\\') {
        j++;
        continue;
      }
      if (inClass) {
        if (ch === ']') inClass = false;
        continue;
      }
      if (ch === '[') {
        inClass = true;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= pattern.length) return false; // unbalanced — RegExp() will reject
    const next = pattern[j + 1];
    if (next !== '+' && next !== '*' && next !== '{') continue;
    let inner = pattern.slice(i + 1, j);
    inner = inner.replace(/^\?(?::|<?[=!])/u, '');
    const branches: string[] = [];
    let current = '';
    let d = 0;
    let cls = false;
    for (let k = 0; k < inner.length; k++) {
      const ch = inner[k];
      if (ch === '\\') {
        current += ch + (inner[k + 1] ?? '');
        k++;
        continue;
      }
      if (cls) {
        if (ch === ']') cls = false;
        current += ch;
        continue;
      }
      if (ch === '[') {
        cls = true;
        current += ch;
        continue;
      }
      if (ch === '(') d++;
      if (ch === ')') d--;
      if (ch === '|' && d === 0) {
        branches.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    branches.push(current);
    if (branches.length < 2) continue;
    for (let a = 0; a < branches.length; a++) {
      for (let b = a + 1; b < branches.length; b++) {
        const x = branches[a] as string;
        const y = branches[b] as string;
        if (x === '' || y === '') return true;
        if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
      }
    }
  }
  return false;
}

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
  if (hasAmbiguousQuantifiedAlternation(pattern)) {
    return {
      ok: false,
      reason:
        'pattern quantifies an alternation with overlapping branches — rewrite so no two branches can match the same text',
    };
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

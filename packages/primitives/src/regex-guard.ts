/**
 * Compile a user-supplied regex with conservative bounds against ReDoS.
 *
 * Canonical home (card #5 first slice): previously three drifted copies —
 * `core/src/utils/regex-guard.ts`, `tools/src/_regex.ts`, and
 * `kanban/src/verification/safe-regex.ts` — held in sync only by
 * `tools/tests/regex-guard-parity.test.ts` because kanban sits below both
 * packages in the workspace DAG. This package is a dependency leaf (no
 * workspace deps), so all three import tiers can share one implementation
 * without inverting the layer graph.
 *
 * V8's regex engine is backtracking-based and cannot interrupt a
 * synchronous match — a pattern like `(a+)+$` against a sufficiently
 * long line will pin a worker for seconds. Two coarse bounds:
 *
 *  1. Cap pattern length — practically all legitimate user patterns are
 *     under 256 characters.
 *  2. Reject patterns containing the most obvious super-linear structures.
 *     This is a coarse filter (false-positives are likely; we accept that
 *     for hostile-input contexts).
 *
 * Callers should additionally bound the *subject* length via `capSubject`.
 */

const MAX_PATTERN_LEN = 256;

// Heuristics for catastrophic-backtracking constructs. Not exhaustive; bias
// toward false-positives in tools that accept LLM-generated input.
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
 */
function hasAmbiguousQuantifiedAlternation(pattern: string): boolean {
  // Character-class and escape state tracked across the WHOLE scan, not just
  // per group probe. A `(` inside `[...]` is literal — a probe started there
  // runs off the end of the pattern and aborts the scan with `false` before a
  // real `(a|a)+` later in the string is ever examined. And `(` after an ODD
  // escape run is a literal `\(`, while `\\(` (escaped backslash) still opens
  // a real group — the old one-character lookbehind misclassified the latter.
  let outerInClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++; // escape pair — the following character belongs to it
      continue;
    }
    if (outerInClass) {
      if (ch === ']') outerInClass = false;
      continue;
    }
    if (ch === '[') {
      outerInClass = true;
      continue;
    }
    if (ch !== '(') continue;
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

export type CompileUserRegexResult = CompileResult | CompileFail;

const COMPILED_CACHE = new Map<string, CompileUserRegexResult>();
const CACHE_MAX_SIZE = 500;

export function compileUserRegex(
  pattern: string,
  flags: string = '',
): CompileResult | CompileFail {
  if (typeof pattern !== 'string') {
    return { ok: false, reason: 'pattern must be a string' };
  }
  const cacheKey = `${flags}\u0000${pattern}`;
  const cached = COMPILED_CACHE.get(cacheKey);
  if (cached !== undefined) {
    // The cache stores the VERDICT only — never the instance that is handed
    // out. RegExp is mutable (`lastIndex`), and this cache is process-global:
    // returning the same object to every consumer of a pattern would let one
    // caller's match state (a `g`/`y` flag, an exec loop) silently leak into
    // another caller's results. Reconstruct a fresh instance from the
    // validated source on every call; the expensive ReDoS heuristics are
    // already skipped by the cache hit.
    return cached.ok ? { ok: true, regex: new RegExp(pattern, flags) } : cached;
  }

  if (COMPILED_CACHE.size >= CACHE_MAX_SIZE) {
    let evicted = 0;
    const target = Math.floor(CACHE_MAX_SIZE / 4);
    for (const key of COMPILED_CACHE.keys()) {
      COMPILED_CACHE.delete(key);
      if (++evicted >= target) break;
    }
  }

  const result = compileUncached(pattern, flags);
  COMPILED_CACHE.set(cacheKey, result);
  // Same instance-isolation as the cache-hit path above: callers get a fresh
  // RegExp, so mutating `lastIndex` on one result cannot corrupt another.
  return result.ok ? { ok: true, regex: new RegExp(pattern, flags) } : result;
}

function compileUncached(pattern: string, flags: string): CompileUserRegexResult {
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
 * Maximum subject length handed to a user-supplied regex before matching.
 * A linear-time pattern over a multi-megabyte line is still a stall; tools
 * that need exact-line matching against very long lines should use ripgrep
 * externally rather than the native walker.
 */
export const MAX_SUBJECT_LEN = 64 * 1024;

/** Truncate a subject line to {@link MAX_SUBJECT_LEN} for synchronous regex eval. */
export function capSubject(line: string): string {
  return line.length > MAX_SUBJECT_LEN ? line.slice(0, MAX_SUBJECT_LEN) : line;
}

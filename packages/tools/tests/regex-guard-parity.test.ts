/**
 * Shim-integrity pin (card #5) — retired from drift duty.
 *
 * Historically this suite guarded three INDEPENDENT implementations against
 * drift; since 07577d9f8 all three entry points (@wrongstack/core/utils,
 * @wrongstack/tools/_regex, @wrongstack/kanban verification/safe-regex)
 * re-export one canonical implementation in @wrongstack/primitives. The
 * suite is kept deliberately: if any shim is ever reverted to a local copy,
 * these assertions fail again. It no longer proves parity of distinct code
 * — it pins the delegation wiring itself.
 */
import {
  MAX_SUBJECT_LEN as CORE_MAX_SUBJECT,
  capSubject as coreCapSubject,
  compileUserRegex as coreCompileUserRegex,
} from '@wrongstack/core/utils';
import { compileSafeRegex, MAX_SUBJECT_LEN as KANBAN_MAX_SUBJECT } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import { capSubject, compileUserRegex, MAX_SUBJECT_LEN } from '../src/_regex.js';

/**
 * Security scan 2026-08-04, findings M4/M5 — and the structural item behind
 * them.
 *
 * The canonical ReDoS guard is `packages/tools/src/_regex.ts`. Kanban needs the
 * same guard for `file_matches` check patterns, but `@wrongstack/kanban` sits
 * BELOW core and tools in the workspace graph (pinned by
 * `packages/core/tests/architecture/package-boundaries.test.ts`), so it cannot
 * import the canonical helper without inverting the layer DAG. It carries a
 * copy in `src/verification/safe-regex.ts`.
 *
 * A copy that nobody checks is how the *first* set of these findings happened:
 * a guard written once, adopted broadly, and missed or drifted in one or two
 * places. `@wrongstack/tools` depends on both packages, so this is the one
 * place that can hold them to the same verdicts. If you change either
 * implementation, change both — this test is the alarm.
 */
/** Shared by every parity block below. */
const CORPUS = [
  // classic catastrophic forms
  '(a+)+$',
  '(?:a+)+$',
  '(a|a)**',
  'a++',
  'a**',
  '(.*)+',
  '(?!.*a+)x',
  '(x+x+)+y',
  // ambiguous quantified alternation — a SINGLE outer quantifier is enough
  // to backtrack exponentially when branches overlap (measured 7s on a
  // 27-char subject before the detector existed; the corpus only carried
  // the doubled-quantifier form above, which was false confidence)
  '(a|a)*$',
  '(a|a)+',
  '(?:a|a)*',
  '(a|ab)+x',
  '(ab|a)*$',
  '(x|)+',
  // …while DISJOINT branches stay allowed
  '(foo|bar)+',
  '(GET|POST) /api/\\w+',
  // ordinary patterns a check might legitimately use
  'TODO',
  '^export function \\w+',
  'foo|bar',
  '\\d{3}-\\d{4}',
  '[A-Za-z_][A-Za-z0-9_]*',
  'const .* = require\\(',
  '',
  '(unclosed',
  '[z-a]',
  '\\',
];

describe('regex guard parity — tools/_regex.ts vs kanban/safe-regex.ts', () => {
  /**
   * Parity corpus. The point is that both implementations return the SAME
   * verdict — not that any particular pattern is caught. The guard is an
   * admitted heuristic (`_regex.ts`: "Not exhaustive; bias toward
   * false-positives"), so asserting a specific verdict here would pin the
   * heuristic's current reach rather than the property under test, and would
   * fail the day someone legitimately tunes it. Tuning it in ONE package is
   * exactly what this test exists to catch.
   */

  it('returns identical verdicts across the whole corpus', () => {
    for (const pattern of CORPUS) {
      const canonical = compileUserRegex(pattern, '');
      const copy = compileSafeRegex(pattern, '');
      expect(copy.ok, `verdict diverged for ${JSON.stringify(pattern)}`).toBe(canonical.ok);
    }
  });

  it('both still reject the nested-quantifier forms the guard exists for', () => {
    for (const pattern of ['(a+)+$', '(?:a+)+$', 'a++', '(.*)+']) {
      expect(compileUserRegex(pattern, '').ok, `canonical: ${pattern}`).toBe(false);
      expect(compileSafeRegex(pattern, '').ok, `kanban copy: ${pattern}`).toBe(false);
    }
  });

  it('agrees on the empty pattern and the length cap', () => {
    expect(compileUserRegex('', '').ok).toBe(false);
    expect(compileSafeRegex('', '').ok).toBe(false);

    const overLong = 'a'.repeat(257);
    expect(compileUserRegex(overLong, '').ok).toBe(false);
    expect(compileSafeRegex(overLong, '').ok).toBe(false);

    const atLimit = 'a'.repeat(256);
    expect(compileUserRegex(atLimit, '').ok).toBe(true);
    expect(compileSafeRegex(atLimit, '').ok).toBe(true);
  });

  it('agrees on invalid regex syntax', () => {
    for (const pattern of ['(unclosed', '[z-a]', '\\']) {
      expect(compileUserRegex(pattern, '').ok).toBe(false);
      expect(compileSafeRegex(pattern, '').ok).toBe(false);
    }
  });

  it('uses the same subject cap', () => {
    expect(KANBAN_MAX_SUBJECT).toBe(MAX_SUBJECT_LEN);
    const long = 'x'.repeat(MAX_SUBJECT_LEN + 10);
    expect(capSubject(long).length).toBe(MAX_SUBJECT_LEN);
  });
});

/**
 * The THIRD copy: `@wrongstack/core/src/utils/regex-guard.ts`.
 *
 * Core sits below tools, so it cannot import the canonical helper either. Its
 * header said "keep both copies in sync" — unaware that kanban carried a third
 * — and it had drifted the furthest of the three: 2 of the 5 heuristics, a
 * 512-character pattern cap instead of 256, and no subject cap at all, so its
 * callers bounded the pattern and never the subject. It was also the one copy
 * the parity test above did not cover, which is precisely why it drifted.
 */
describe('regex guard parity — tools/_regex.ts vs core/utils/regex-guard.ts', () => {
  it('returns the same verdict for every pattern in the corpus', () => {
    for (const pattern of CORPUS) {
      const canonical = compileUserRegex(pattern, '');
      const copy = coreCompileUserRegex(pattern, '');
      expect(copy.ok, `verdict diverged for ${JSON.stringify(pattern)}`).toBe(canonical.ok);
    }
  });

  it('rejects every heuristic the canonical copy rejects', () => {
    // Forms core's two-rule list used to ADMIT, plus the two it already had.
    //
    // Note: `(?!.*a+)x` is deliberately absent. The canonical guard's fifth
    // heuristic is commented "Greedy quantifier inside lookahead/lookbehind —
    // (?!.*a+)" but does not in fact match that pattern, so pinning it here
    // would assert a reach the guard does not have. The corpus test above
    // still covers it — for that pattern the property under test is that all
    // three copies AGREE, whatever the shared verdict is.
    for (const pattern of ['a++', '(ab|cd)++', '(a+)+$', '(?:a+)+$', '(.*)+']) {
      expect(compileUserRegex(pattern, '').ok, `canonical: ${pattern}`).toBe(false);
      expect(coreCompileUserRegex(pattern, '').ok, `core copy: ${pattern}`).toBe(false);
    }
  });

  it('uses the same pattern-length cap', () => {
    // Core allowed 512, so a 300-character pattern passed there and failed here.
    const overLong = 'a'.repeat(257);
    expect(compileUserRegex(overLong, '').ok).toBe(false);
    expect(coreCompileUserRegex(overLong, '').ok).toBe(false);

    const atLimit = 'a'.repeat(256);
    expect(compileUserRegex(atLimit, '').ok).toBe(true);
    expect(coreCompileUserRegex(atLimit, '').ok).toBe(true);
  });

  it('ships the same subject cap', () => {
    expect(CORE_MAX_SUBJECT).toBe(MAX_SUBJECT_LEN);
    const long = 'x'.repeat(MAX_SUBJECT_LEN + 10);
    expect(coreCapSubject(long).length).toBe(MAX_SUBJECT_LEN);
  });
});

import { describe, expect, it } from 'vitest';
import { compileSafeRegex, MAX_SUBJECT_LEN as KANBAN_MAX_SUBJECT } from '@wrongstack/kanban';
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

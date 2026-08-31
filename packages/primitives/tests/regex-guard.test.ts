/**
 * Regression tests for `compileUserRegex` and `capSubject`.
 *
 * This is the ReDoS gate for every user/LLM-supplied pattern in the repo
 * (grep, logs, replace, json, kanban file-matches all funnel through it). A
 * regression that lets `(a|a)*`-style patterns through pins a worker for
 * seconds, uninterruptibly — so each rejection class below is load-bearing.
 */

import { describe, expect, it } from 'vitest';
import { capSubject, compileUserRegex, MAX_SUBJECT_LEN } from '../src/regex-guard.js';

describe('compileUserRegex — accepted patterns', () => {
  it('compiles a plain pattern and preserves its flags', () => {
    const result = compileUserRegex('foo.bar', 'iu');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.regex).toBeInstanceOf(RegExp);
      expect(result.regex.flags).toContain('i');
      expect(result.regex.flags).toContain('u');
      expect(result.regex.test('FOO bar')).toBe(true);
    }
  });

  it('allows disjoint alternations with a quantifier', () => {
    const result = compileUserRegex('(foo|bar)+', '');
    expect(result.ok).toBe(true);
  });

  it('flags quantifier characters inside character classes too (coarse heuristic)', () => {
    // Documented false positive: the adjacent-quantifier scan is a raw text
    // check, so even class-wrapped quantifier pairs trip it. Accepted bias
    // for hostile-input contexts — pin it so a silent loosening is noticed.
    expect(compileUserRegex('[+*]+', '').ok).toBe(false);
    expect(compileUserRegex('a[+*]b', '').ok).toBe(false);
  });

  it('allows character classes without quantifier pairs', () => {
    expect(compileUserRegex('[+]', '').ok).toBe(true);
    expect(compileUserRegex('[a-z]+', '').ok).toBe(true);
  });

  it('allows escaped parentheses so literal groups are not treated as regex groups', () => {
    expect(compileUserRegex(String.raw`\(a\)\+`, '').ok).toBe(true);
  });

  it('compiles a pattern at the length boundary', () => {
    expect(compileUserRegex('a'.repeat(256), '').ok).toBe(true);
  });
});

describe('compileUserRegex — rejected patterns', () => {
  it('rejects non-string patterns', () => {
    const result = compileUserRegex(42 as unknown as string, '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pattern must be a string');
  });

  it('rejects the empty pattern', () => {
    const result = compileUserRegex('', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pattern is empty');
  });

  it('rejects patterns beyond 256 characters', () => {
    const result = compileUserRegex('a'.repeat(257), '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pattern exceeds 256 characters');
  });

  it('rejects nested quantifiers — the classic (a+)+$', () => {
    const result = compileUserRegex('(a+)+$', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('catastrophic backtracking');
  });

  it('rejects non-capturing nested quantifiers — (?:a+)+', () => {
    expect(compileUserRegex('(?:a+)+', '').ok).toBe(false);
  });

  it('rejects adjacent quantifiers — a++ and a*+', () => {
    expect(compileUserRegex('a++', '').ok).toBe(false);
    expect(compileUserRegex('a*+', '').ok).toBe(false);
  });

  it('rejects doubled quantifiers on alternation groups', () => {
    expect(compileUserRegex('(a|b)++', '').ok).toBe(false);
  });

  it('rejects greedy quantifiers inside lookarounds', () => {
    expect(compileUserRegex('(?=(a+))', '').ok).toBe(false);
  });

  it('rejects ambiguous quantified alternations with identical branches', () => {
    const result = compileUserRegex('(a|a)*', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('overlapping branches');
  });

  it('rejects ambiguous quantified alternations with prefix-related branches', () => {
    expect(compileUserRegex('(a|ab)+', '').ok).toBe(false);
  });

  it('rejects ambiguous alternations containing an empty branch', () => {
    expect(compileUserRegex('(a|)+', '').ok).toBe(false);
  });

  it('rejects ambiguous alternations hidden behind an escaped backslash', () => {
    // `\\(a|a)+` — `\\` matches a literal backslash, so the `(` IS a real
    // group. The old detector's one-character lookbehind (`pattern[i-1]`)
    // misread it as escaped `\(` and let the catastrophic form through.
    expect(compileUserRegex(String.raw`\\(a|a)+`, '').ok).toBe(false);
    expect(compileUserRegex(String.raw`x\\(a|a)+y`, '').ok).toBe(false);
  });

  it('rejects ambiguous alternations after a character class', () => {
    // `[(](a|a)+` — the `(` inside `[(]` is literal, but the old scanner
    // probed from it, found no matching `)` before the string ended, and took
    // the unbalanced-pattern early return — never reaching the REAL `(a|a)+`
    // later in the string.
    expect(compileUserRegex('[(](a|a)+', '').ok).toBe(false);
    expect(compileUserRegex('[ab](a|a)*', '').ok).toBe(false);
  });

  it('still allows disjoint alternations and literal parens after the fix', () => {
    // Disjoint branches stay allowed even with an escape-pair or class before
    // them; and a class containing only literal parens is not a group.
    expect(compileUserRegex(String.raw`\\(foo|bar)+`, '').ok).toBe(true);
    expect(compileUserRegex('[(](foo|bar)+', '').ok).toBe(true);
    expect(compileUserRegex('[()]', '').ok).toBe(true);
    expect(compileUserRegex(String.raw`\(a\)\+`, '').ok).toBe(true);
  });

  it('reports the RegExp engine error for syntactically invalid patterns', () => {
    const result = compileUserRegex('([unclosed', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe('capSubject', () => {
  it('exposes the documented 64 KiB subject bound', () => {
    expect(MAX_SUBJECT_LEN).toBe(64 * 1024);
  });

  it('returns short subjects untouched', () => {
    const line = 'a'.repeat(1000);
    expect(capSubject(line)).toBe(line);
  });

  it('returns a subject at exactly the bound untouched', () => {
    const line = 'b'.repeat(MAX_SUBJECT_LEN);
    expect(capSubject(line)).toBe(line);
  });

  it('truncates subjects beyond the bound to exactly MAX_SUBJECT_LEN characters', () => {
    const line = 'c'.repeat(MAX_SUBJECT_LEN + 100);
    const capped = capSubject(line);
    expect(capped.length).toBe(MAX_SUBJECT_LEN);
    expect(capped).toBe(line.slice(0, MAX_SUBJECT_LEN));
  });
});

describe('compileUserRegex — instance independence (shared-cache regression)', () => {
  // The module-level cache used to hand EVERY caller the SAME RegExp instance
  // for a given (pattern, flags). RegExp carries mutable state — `lastIndex`
  // — and `g`/`y`-flagged regexes advance it on every exec/test, so one
  // consumer's iterative scan silently corrupted every other consumer's
  // results for that pattern in the same process. This suite pins the
  // contract that each call returns an independent, pristine instance.

  it('returns a fresh RegExp per call even for cached patterns', () => {
    const a = compileUserRegex('ab', 'g');
    const b = compileUserRegex('ab', 'g');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.regex).not.toBe(b.regex);
  });

  it('does not leak lastIndex between callers of the same pattern', () => {
    const first = compileUserRegex('ab', 'g');
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Consumer 1 iterates its regex (a normal find-all loop).
    expect(first.regex.exec('ab xx ab')?.index).toBe(0);
    expect(first.regex.exec('ab xx ab')?.index).toBe(6);
    expect(first.regex.lastIndex).toBeGreaterThan(0);

    // Consumer 2 compiles the same pattern and must start clean at index 0.
    const second = compileUserRegex('ab', 'g');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.regex.lastIndex).toBe(0);
    expect(second.regex.exec('ab xx ab')?.index).toBe(0);
  });

  it('keeps the returned regex behaviorally equivalent to new RegExp', () => {
    const pattern = '(foo|bar)+';
    const flags = 'gi';
    const compiled = compileUserRegex(pattern, flags);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const reference = new RegExp(pattern, flags);
    // Same semantics, source, and flags as a direct compile.
    expect(compiled.regex.source).toBe(reference.source);
    expect(compiled.regex.flags).toBe(reference.flags);
    for (const subject of ['BAR bar', 'foo', 'baz qux', '']) {
      expect(compiled.regex.test(subject), `subject ${JSON.stringify(subject)}`).toBe(
        reference.test(subject),
      );
    }
    // `lastIndex` is per-instance: mutating the caller's copy advances only
    // that copy, exactly as it would with new RegExp.
    compiled.regex.lastIndex = 1;
    expect(compiled.regex.test('bar bar')).toBe(reference.test('bar bar'));
  });

  it('caches rejected verdicts without caching a regex at all', () => {
    const first = compileUserRegex('(a|a)*', '');
    const second = compileUserRegex('(a|a)*', '');
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) return;
    expect(first.reason).toBe(second.reason);
  });
});

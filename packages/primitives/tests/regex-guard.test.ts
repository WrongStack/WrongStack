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

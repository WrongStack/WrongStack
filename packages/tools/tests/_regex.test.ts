import { describe, expect, it } from 'vitest';
import { capSubject, compileUserRegex, MAX_SUBJECT_LEN } from '../src/_regex.js';

describe('compileUserRegex (ReDoS guard for grep/replace/logs)', () => {
  it('compiles a simple pattern', () => {
    const r = compileUserRegex('foo', '');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.regex.test('foobar')).toBe(true);
  });

  it('rejects a non-string pattern', () => {
    const r = compileUserRegex(123 as never as string, '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/must be a string/);
  });

  it('rejects empty patterns', () => {
    const r = compileUserRegex('', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty/);
  });

  it('rejects patterns above the length cap', () => {
    const huge = 'a'.repeat(513);
    const r = compileUserRegex(huge, '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/exceeds/);
  });

  it('rejects classic catastrophic-backtracking pattern (a+)+', () => {
    const r = compileUserRegex('(a+)+', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/backtracking|nested/i);
  });

  it('rejects nested non-capturing super-linear pattern', () => {
    const r = compileUserRegex('(?:x+)*', '');
    expect(r.ok).toBe(false);
  });

  it('returns a useful reason on invalid regex syntax', () => {
    const r = compileUserRegex('(unbalanced', '');
    expect(r.ok).toBe(false);
  });

  it('honors flags', () => {
    const r = compileUserRegex('foo', 'i');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.regex.test('FOO')).toBe(true);
      expect(r.regex.flags).toContain('i');
    }
  });
});

describe('ambiguous quantified alternation (single outer quantifier)', () => {
  // The measured hole: `(a|a)*$` passed every DANGEROUS_PATTERNS rule (rule 4
  // requires a DOUBLED quantifier) and took 7s on a 27-char subject —
  // synchronous and uninterruptible, so it kills a daemon event loop.
  it.each(['(a|a)*$', '(a|a)+', '(?:a|a)*', '(a|ab)+x', '(ab|a)*$', '(x|)+', '(a|a){2,}'])(
    'rejects %s',
    (pattern) => {
      const r = compileUserRegex(pattern, '');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('overlapping branches');
    },
  );

  it.each(['(foo|bar)+', '(GET|POST) /api/\\w+', '(a|b)*c', 'foo|bar', '(a|ab)x'])(
    'still allows disjoint or unquantified alternation %s',
    (pattern) => {
      expect(compileUserRegex(pattern, '').ok).toBe(true);
    },
  );

  it('the previously-measured attack pattern now fails fast instead of backtracking', () => {
    const start = Date.now();
    const r = compileUserRegex('(a|a)*$', '');
    expect(r.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe('capSubject', () => {
  it('passes through short lines unchanged', () => {
    expect(capSubject('hello')).toBe('hello');
  });

  it('caps oversized lines at MAX_SUBJECT_LEN', () => {
    const huge = 'a'.repeat(MAX_SUBJECT_LEN + 100);
    const capped = capSubject(huge);
    expect(capped.length).toBe(MAX_SUBJECT_LEN);
  });
});

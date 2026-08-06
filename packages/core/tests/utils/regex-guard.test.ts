import { describe, expect, it } from 'vitest';
import { compileUserRegex } from '../../src/utils/regex-guard.js';

describe('regex-guard / compileUserRegex', () => {
  it('compiles a simple valid pattern', () => {
    const r = compileUserRegex('foo', 'i');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.regex).toBeInstanceOf(RegExp);
      expect(r.regex.test('FOO')).toBe(true);
      expect(r.regex.flags).toContain('i');
    }
  });

  it('compiles with empty flags', () => {
    const r = compileUserRegex('^bar$', '');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.regex.test('bar')).toBe(true);
      expect(r.regex.test('Bar')).toBe(false);
    }
  });

  it('rejects empty pattern', () => {
    const r = compileUserRegex('', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty/);
  });

  it('rejects non-string pattern', () => {
    // @ts-expect-error - deliberate misuse to verify runtime guard
    const r = compileUserRegex(123, '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/string/);
  });

  // The cap was 512 here and 256 in the canonical guard
  // (`tools/src/_regex.ts`), so a 300-character pattern this copy accepted was
  // rejected by the other two. All three now agree on 256 — see
  // `tools/tests/regex-guard-parity.test.ts`, which is what holds them there.
  it('rejects oversized pattern (> 256 chars)', () => {
    const r = compileUserRegex('a'.repeat(257), '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/256/);
  });

  it('accepts pattern at exactly 256 chars', () => {
    const r = compileUserRegex('a'.repeat(256), '');
    expect(r.ok).toBe(true);
  });

  it('rejects nested quantifier (a+)+', () => {
    const r = compileUserRegex('(a+)+', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/backtracking/);
  });

  it('rejects nested quantifier with star (.*)+', () => {
    const r = compileUserRegex('(.*)+', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/backtracking/);
  });

  it('rejects nested quantifier in non-capturing group (?:a+)+', () => {
    const r = compileUserRegex('(?:a+)+', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/backtracking/);
  });

  it('rejects nested quantifier with star inside non-capturing group', () => {
    const r = compileUserRegex('(?:a*)*', '');
    expect(r.ok).toBe(false);
  });

  it('returns reason on syntactically invalid regex', () => {
    const r = compileUserRegex('[unclosed', '');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBeDefined();
      expect(typeof r.reason).toBe('string');
    }
  });

  it('accepts a safe quantifier that is not nested', () => {
    const r = compileUserRegex('a+b*c?', '');
    expect(r.ok).toBe(true);
  });

  it('accepts alternation', () => {
    const r = compileUserRegex('foo|bar', '');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.regex.test('foo')).toBe(true);
      expect(r.regex.test('bar')).toBe(true);
      expect(r.regex.test('baz')).toBe(false);
    }
  });

  it('passes through multiple flags', () => {
    const r = compileUserRegex('hi', 'gim');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.regex.flags).toContain('g');
      expect(r.regex.flags).toContain('i');
      expect(r.regex.flags).toContain('m');
    }
  });

  it('returns error for invalid flags', () => {
    const r = compileUserRegex('foo', 'Z');
    expect(r.ok).toBe(false);
  });
});

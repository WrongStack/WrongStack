import { describe, expect, it } from 'vitest';
import { detectQuantifiedAmbiguity } from '../src/regex-ambiguity.js';
import { compileUserRegex } from '../src/regex-guard.js';

const emptyClass = String.raw`[^\u0000-\uffff]`;
const content = emptyClass + '{1,2}|a';
const pattern = '(?:' + content + ')+';

describe('legacy regex character-set universe', () => {
  it.each(['', 'i', 's'])('does not invent out-of-alphabet ambiguity with flags %s', (flags) => {
    const native = new RegExp('^' + pattern + '$', flags);
    expect(native.test('aaa')).toBe(true);
    expect(native.test('b')).toBe(false);
    expect(detectQuantifiedAmbiguity(content, flags).verdict).toBe('unambiguous');
    expect(compileUserRegex(pattern, flags).ok).toBe(true);
  });

  it.each(['u', 'v'])('preserves real supplementary-character ambiguity with flags %s', (flags) => {
    const supplementary = String.fromCodePoint(0x10000);
    expect(new RegExp('^' + emptyClass + '$', flags).test(supplementary)).toBe(true);
    expect(detectQuantifiedAmbiguity(content, flags).verdict).toBe('ambiguous');
    expect(compileUserRegex(pattern, flags).ok).toBe(false);
  });

  it('keeps complements of disjoint halves disjoint in the legacy alphabet', () => {
    const halves = String.raw`[^\u0000-\u7fff]|[^\u8000-\uffff]`;
    expect(detectQuantifiedAmbiguity(halves).verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity(halves, 'u').verdict).toBe('ambiguous');
  });

  it('retains the inclusive upper code-unit boundary', () => {
    const lastUnit = String.raw`[^\u0000-\ufffe]`;
    expect(new RegExp('^' + lastUnit + '$').test('\uffff')).toBe(true);
    expect(detectQuantifiedAmbiguity(lastUnit).verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity(lastUnit + '{1,2}').verdict).toBe('ambiguous');
  });

  it('still finds in-alphabet ambiguity in named complements and dot', () => {
    for (const input of [String.raw`\D{1,2}`, String.raw`[\D]{1,2}`, '.{1,2}']) {
      expect(detectQuantifiedAmbiguity(input).verdict).toBe('ambiguous');
    }
  });
});

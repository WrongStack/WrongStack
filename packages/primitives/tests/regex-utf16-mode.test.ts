import { describe, expect, it } from 'vitest';
import { detectQuantifiedAmbiguity } from '../src/regex-ambiguity.js';
import { compileUserRegex } from '../src/regex-guard.js';

const astral = String.fromCodePoint(0x1f600);

describe('UTF-16 versus Unicode regex ambiguity', () => {
  it.each(['', 'i', 's'])(
    'keeps non-Unicode optional low surrogates unambiguous with flags %s',
    (flags) => {
      for (const quantifier of ['?', '{0,1}']) {
        const content = astral + quantifier;
        const native = new RegExp('^(?:' + content + ')$', flags);
        expect(native.test('')).toBe(false);
        expect(native.test(astral.slice(0, 1))).toBe(true);
        expect(native.test(astral)).toBe(true);
        expect(detectQuantifiedAmbiguity(content, flags).verdict).toBe('unambiguous');
        expect(compileUserRegex('(?:' + content + ')+', flags).ok).toBe(true);
      }
    },
  );

  it.each(['u', 'v'])('retains optional-code-point ambiguity with flags %s', (flags) => {
    expect(new RegExp('^(?:' + astral + '?)$', flags).test('')).toBe(true);
    expect(detectQuantifiedAmbiguity(astral + '?', flags).verdict).toBe('ambiguous');
    expect(compileUserRegex('(?:' + astral + '?)+', flags).ok).toBe(false);
  });

  it('models raw astral character classes according to the mode', () => {
    const content = '[' + astral + ']|\\uD83D';
    expect(new RegExp('^[' + astral + ']$').test(astral.slice(0, 1))).toBe(true);
    expect(new RegExp('^[' + astral + ']$', 'u').test(astral.slice(0, 1))).toBe(false);
    expect(detectQuantifiedAmbiguity(content).verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity(content, 'u').verdict).toBe('unambiguous');
  });

  it('uses UTF-16 units for raw astral range endpoints without a Unicode flag', () => {
    const range = '[a-' + astral + ']';
    const content = range + '|\\uDE01';
    expect(new RegExp('^' + range + '$').test('\uDE01')).toBe(false);
    expect(new RegExp('^' + range + '$', 'u').test('\uDE01')).toBe(true);
    expect(detectQuantifiedAmbiguity(content).verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity(content, 'u').verdict).toBe('ambiguous');
  });

  it('keeps the ordinary optional-ASCII ambiguity control', () => {
    expect(detectQuantifiedAmbiguity('a?').verdict).toBe('ambiguous');
  });
});

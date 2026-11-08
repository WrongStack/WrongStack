import { describe, expect, it } from 'vitest';
import { detectQuantifiedAmbiguity } from '../src/regex-ambiguity.js';
import { compileUserRegex } from '../src/regex-guard.js';

describe('ECMAScript empty character classes', () => {
  it('does not give a dead legacy branch literal members after its closing bracket', () => {
    // biome-ignore lint/correctness/noEmptyCharacterClassInRegex: native empty-set semantics are the regression control.
    const dead = /^(?:[]a])$/;
    for (const input of ['', 'a', ']', 'a]', 'aa']) expect(dead.test(input)).toBe(false);
    const pattern = '(?:[]a]|a)+$';
    expect(new RegExp(`^${pattern}`).test('aaa')).toBe(true);
    expect(detectQuantifiedAmbiguity('[]a]|a').verdict).toBe('unambiguous');
    expect(compileUserRegex(pattern).ok).toBe(true);
  });

  it.each(['', 'u', 'v'])('models [] as the empty set in %s mode', (flags) => {
    expect(new RegExp('^[]$', flags).test('a')).toBe(false);
    expect(detectQuantifiedAmbiguity('[]|a', flags).verdict).toBe('unambiguous');
    expect(compileUserRegex('(?:[]|a)+$', flags).ok).toBe(true);
  });

  it.each(['', 'u', 'v'])('recognizes ambiguity through [^] in %s mode', (flags) => {
    expect(new RegExp('^[^]$', flags).test('a')).toBe(true);
    expect(detectQuantifiedAmbiguity('[^]|a', flags).verdict).toBe('ambiguous');
    expect(compileUserRegex('(?:[^]|a)+$', flags).ok).toBe(false);
  });

  it('retains epsilon when an empty class is optional', () => {
    // biome-ignore lint/correctness/noEmptyCharacterClassInRegex: an optional empty set must match epsilon.
    expect(/^(?:[]?)$/.test('')).toBe(true);
    expect(detectQuantifiedAmbiguity('[]?').verdict).toBe('ambiguous');
  });

  it('keeps escaped closing brackets literal', () => {
    expect(/^[\]]$/.test(']')).toBe(true);
    expect(detectQuantifiedAmbiguity(String.raw`[\]]|a`).verdict).toBe('unambiguous');
    expect(compileUserRegex(String.raw`(?:[\]]|a)+$`).ok).toBe(true);
    expect(detectQuantifiedAmbiguity(String.raw`[\]a]|a`).verdict).toBe('ambiguous');
    expect(compileUserRegex(String.raw`(?:[\]a]|a)+$`).ok).toBe(false);
  });
});

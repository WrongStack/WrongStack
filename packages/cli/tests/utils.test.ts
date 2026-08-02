import { describe, expect, it } from 'vitest';
import { fmtTok, patchConfig } from '../src/utils.js';

describe('fmtTok', () => {
  it('renders sub-1k counts verbatim', () => {
    expect(fmtTok(0)).toBe('0');
    expect(fmtTok(1)).toBe('1');
    expect(fmtTok(999)).toBe('999');
  });

  it('renders thousands with one decimal under 10k', () => {
    expect(fmtTok(1000)).toBe('1.0k');
    expect(fmtTok(1234)).toBe('1.2k');
    expect(fmtTok(9999)).toBe('10.0k');
  });

  it('drops the decimal at 10k and up', () => {
    expect(fmtTok(10_000)).toBe('10k');
    expect(fmtTok(12_345)).toBe('12k');
    expect(fmtTok(999_999)).toBe('1000k');
  });

  it('switches to millions above 1M', () => {
    expect(fmtTok(1_000_000)).toBe('1.0M');
    expect(fmtTok(1_500_000)).toBe('1.5M');
    expect(fmtTok(12_345_678)).toBe('12.3M');
  });
});

describe('patchConfig', () => {
  it('returns a new frozen object with the patch merged', () => {
    const base: Record<string, number> = Object.freeze({ a: 1, b: 2 });
    const patched = patchConfig(base, { b: 99 });
    expect(patched).toEqual({ a: 1, b: 99 });
    expect(patched).not.toBe(base);
    expect(Object.isFrozen(patched)).toBe(true);
  });

  it('does not mutate the input', () => {
    const base = { a: 1, b: 2 };
    patchConfig(base, { b: 99 });
    expect(base).toEqual({ a: 1, b: 2 });
  });
});

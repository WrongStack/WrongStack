import { describe, expect, it } from 'vitest';
import { displayDecimal } from '../src/lib/i18n';

describe('displayDecimal bounds', () => {
  it('clamps invalid digits and guards non-finite values', () => {
    expect(displayDecimal(1.5, 2)).toBe('1.50');
    expect(displayDecimal(1.5, 2, true)).toBe('1.5');
    expect(() => displayDecimal(1.5, -1)).not.toThrow();
    expect(displayDecimal(1.5, -1)).toBe('2');
    expect(displayDecimal(1.5, Number.NaN)).toBe('2');
    expect(() => displayDecimal(1.5, 999)).not.toThrow();
    expect(displayDecimal(Number.NaN, 2)).toBe('0');
    expect(displayDecimal(Number.POSITIVE_INFINITY, 2)).toBe('0');
  });
});

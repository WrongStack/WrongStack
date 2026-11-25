import { describe, expect, it } from 'vitest';
import { formatDelay } from '../src/utils/delay-format.js';

describe('formatDelay non-finite and negative inputs (F1860)', () => {
  it('returns disabled for NaN, Infinity, zero, and negative values', () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
      -60_000,
    ]) {
      expect(formatDelay(bad)).toBe('disabled');
    }
  });

  it('formats positive finite delays in seconds or minutes', () => {
    expect(formatDelay(1000)).toBe('1s');
    expect(formatDelay(59_700)).toBe('1m');
    expect(formatDelay(120_000)).toBe('2m');
  });
});

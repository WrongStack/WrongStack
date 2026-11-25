import { describe, expect, it } from 'vitest';
import { relativeTime, remainingLabel } from '../src/features/attention/model.js';

describe('attention model time formatting non-finite inputs (F1874)', () => {
  it('guards NaN and Infinity in remainingLabel and relativeTime', () => {
    expect(remainingLabel(Number.NaN)).toBe('0s left');
    expect(remainingLabel(Number.POSITIVE_INFINITY)).toBe('0s left');
    expect(remainingLabel(-5000)).toBe('0s left');
    expect(remainingLabel(30_000)).toBe('30s left');
    expect(remainingLabel(125_000)).toBe('2m 05s left');

    expect(relativeTime(1000, Number.NaN)).toBe('');
    expect(relativeTime(1000, Number.POSITIVE_INFINITY)).toBe('');
    expect(relativeTime(1000, 10_000)).toBe('just now');
  });
});

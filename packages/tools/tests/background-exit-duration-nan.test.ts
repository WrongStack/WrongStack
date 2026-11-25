import { describe, expect, it } from 'vitest';
import { formatNoticeDuration } from '../src/background-exit-notice.js';

describe('formatNoticeDuration non-finite guard (F2001)', () => {
  it('returns 0s for NaN and Infinity instead of NaNh NaNm', () => {
    expect(formatNoticeDuration(65_000)).toBe('1m 5s');
    expect(formatNoticeDuration(Number.NaN)).toBe('0s');
    expect(formatNoticeDuration(Number.POSITIVE_INFINITY)).toBe('0s');
  });
});

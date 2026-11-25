import { describe, expect, it } from 'vitest';
import { fmtContextWindow, sparkline } from '../src/lib/dashboard-primitives.js';

describe('dashboard-primitives non-finite inputs (F1883)', () => {
  it('guards NaN/negative/Infinity in fmtContextWindow and sparkline', () => {
    expect(fmtContextWindow(Number.NaN)).toBe('0k');
    expect(fmtContextWindow(-1000)).toBe('0k');
    expect(fmtContextWindow(Number.POSITIVE_INFINITY)).toBe('0k');
    expect(fmtContextWindow(200_000)).toBe('200k');

    const sp = sparkline([0, Number.NaN, 1], Number.NaN);
    expect(sp).toHaveLength(3);
    expect(sp).not.toContain('·');
  });
});

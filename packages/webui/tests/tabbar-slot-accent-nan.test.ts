import { describe, expect, it } from 'vitest';
import { formatTokens, slotAccent } from '../src/components/SessionTabBar/summaries';

describe('SessionTabBar slotAccent and formatTokens guards', () => {
  it('wraps negative/NaN slots safely and clamps non-finite/negative token counts to 0', () => {
    expect(slotAccent(-1).name).toBe('success');
    expect(slotAccent(Number.NaN).name).toBe('primary');
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(-5)).toBe('0');
  });
});

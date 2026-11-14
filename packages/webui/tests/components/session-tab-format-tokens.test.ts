import { describe, expect, it } from 'vitest';
import { formatTokens } from '../../src/components/SessionTabBar/summaries';

describe('formatTokens', () => {
  it('keeps small counts verbatim and abbreviates thousands and millions', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_000)).toBe('1.0k');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });

  it('rolls a count that rounds up to 1000k into the next unit', () => {
    // (999_950 / 1000).toFixed(1) === "1000.0" — must not render "1000.0k".
    expect(formatTokens(999_950)).toBe('1.0M');
    expect(formatTokens(999_999)).toBe('1.0M');
    expect(formatTokens(999_949)).toBe('999.9k');
  });
});

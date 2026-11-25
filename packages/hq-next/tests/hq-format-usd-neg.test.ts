import { describe, expect, it } from 'vitest';
import { formatUsd } from '../src/hq/lib/format';

describe('formatUsd negative amount formatting', () => {
  it('places the minus sign before the dollar sign and uses magnitude for precision', () => {
    expect(formatUsd(-5)).toBe('-$5.00');
    expect(formatUsd(-0.005)).toBe('-$0.0050');
    expect(formatUsd(5)).toBe('$5.00');
  });
});

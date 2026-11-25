import { describe, expect, it } from 'vitest';
import { formatUptime } from '../src/features/machines/health.js';

describe('formatUptime non-finite and negative inputs (F1868)', () => {
  it('returns em-dash for NaN, Infinity, and negative seconds', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -3600]) {
      expect(formatUptime(bad)).toBe('—');
    }
    expect(formatUptime(0)).toBe('0m');
    expect(formatUptime(90)).toBe('1m');
    expect(formatUptime(7260)).toBe('2h 1m');
  });
});

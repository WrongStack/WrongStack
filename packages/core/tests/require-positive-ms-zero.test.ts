import { describe, expect, it } from 'vitest';
import { requirePositiveMs } from '../src/execution/brain-runtime-normalize.js';

describe('requirePositiveMs (F2161)', () => {
  it('never rounds small positive sub-millisecond values down to 0', () => {
    expect(requirePositiveMs(0.1, 'decisionTimeoutMs')).toBe(1);
    expect(requirePositiveMs(0.49, 'decisionTimeoutMs')).toBe(1);
    expect(requirePositiveMs(250, 'decisionTimeoutMs')).toBe(250);
  });

  it('rejects non-positive and non-finite inputs', () => {
    expect(() => requirePositiveMs(0, 'decisionTimeoutMs')).toThrow();
    expect(() => requirePositiveMs(-1, 'decisionTimeoutMs')).toThrow();
    expect(() => requirePositiveMs(Number.NaN, 'decisionTimeoutMs')).toThrow();
  });
});

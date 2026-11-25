import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtTok } from '../src/utils.js';

describe('CLI formatters non-finite and negative guards', () => {
  it('clamps non-finite and negative values to 0', () => {
    expect(fmtTok(1200)).toBe('1.2k');
    expect(fmtTok(Number.NaN)).toBe('0');
    expect(fmtTok(-10)).toBe('0');
    expect(fmtDuration(1500)).toBe('1.5s');
    expect(fmtDuration(Number.NaN)).toBe('0ms');
    expect(fmtDuration(-10)).toBe('0ms');
  });
});

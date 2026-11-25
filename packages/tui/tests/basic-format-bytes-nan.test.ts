import { describe, expect, it } from 'vitest';
import { fmtBytes } from '../src/components/history/basic-format.js';

describe('fmtBytes non-finite and negative guards', () => {
  it('clamps NaN and negative byte counts to 0B', () => {
    expect(fmtBytes(512)).toBe('512B');
    expect(fmtBytes(Number.NaN)).toBe('0B');
    expect(fmtBytes(-10)).toBe('0B');
  });
});

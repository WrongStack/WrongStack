import { describe, expect, it } from 'vitest';
import { fmtTok } from '../src/components/ChatView/utils';

describe('ChatView fmtTok non-finite and negative guards', () => {
  it('returns 0 for NaN and negative counts', () => {
    expect(fmtTok(1500)).toBe('1.5k');
    expect(fmtTok(Number.NaN)).toBe('0');
    expect(fmtTok(-5)).toBe('0');
  });
});

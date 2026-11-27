import { describe, expect, it } from 'vitest';
import { fmtTok } from '../src/components/ChatView/utils';

// Unit carry at the rounding boundary — the same contract the sibling display
// formatters honour (formatBytes "promote on the rounded value", commit
// 4aaad98879 "carry byte, token and duration units at their rounding
// boundaries"). A k value that rounds to 1000 must read as the next unit, so a
// session just under a 1M context window shows "1.0M", never "1000k".
describe('ChatView fmtTok unit carry at the rounding boundary', () => {
  it('promotes a k value that rounds to 1000 into M', () => {
    expect(fmtTok(999_500)).toBe('1.0M');
    expect(fmtTok(999_950)).toBe('1.0M');
    expect(fmtTok(999_999)).toBe('1.0M');
  });

  it('keeps values below the boundary and exact M inputs unchanged', () => {
    expect(fmtTok(999_499)).toBe('999k');
    expect(fmtTok(1_000_000)).toBe('1.0M');
    expect(fmtTok(1500)).toBe('1.5k');
    expect(fmtTok(10_000)).toBe('10k');
  });
});

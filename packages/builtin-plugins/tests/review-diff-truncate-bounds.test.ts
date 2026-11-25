import { describe, expect, it } from 'vitest';
import { truncateDiffSurrogateSafe } from '../src/review-diff.js';

describe('truncateDiffSurrogateSafe non-finite/negative maxChars', () => {
  it('clamps negative and NaN maxChars to 0 instead of slicing from the end or emitting NaN', () => {
    const neg = truncateDiffSurrogateSafe('abcdef', -1);
    expect(neg.truncated).toBe(true);
    expect(neg.text.startsWith('\n... (diff truncated at 0 bytes')).toBe(true);

    const nan = truncateDiffSurrogateSafe('abcdef', Number.NaN);
    expect(nan.truncated).toBe(true);
    expect(nan.text.startsWith('\n... (diff truncated at 0 bytes')).toBe(true);
    expect(nan.text).not.toContain('NaN');
  });
});

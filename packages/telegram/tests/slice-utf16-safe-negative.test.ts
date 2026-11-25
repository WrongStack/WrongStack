import { describe, expect, it } from 'vitest';
import { sliceUtf16Safe } from '../src/text-format.js';

describe('sliceUtf16Safe negative and NaN bounds', () => {
  it('returns empty string for negative, zero, or NaN end indices', () => {
    expect(sliceUtf16Safe('hello', 3)).toBe('hel');
    expect(sliceUtf16Safe('secret', -1)).toBe('');
    expect(sliceUtf16Safe('secret', 0)).toBe('');
    expect(sliceUtf16Safe('secret', Number.NaN)).toBe('');
  });
});

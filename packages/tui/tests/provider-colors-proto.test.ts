import { describe, expect, it } from 'vitest';
import { colorForFamily, dimColorForFamily } from '../src/components/provider-colors.js';

describe('provider-colors (F2191)', () => {
  it('returns fallback hex colors for prototype property names', () => {
    expect(colorForFamily('toString')).toBe('#89dceb');
    expect(dimColorForFamily('constructor')).toBe('#585b70');
    expect(colorForFamily('openai')).toBe('#a6e3a1');
  });
});

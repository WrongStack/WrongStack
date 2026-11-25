import { describe, expect, it } from 'vitest';
import { clipInline } from '../src/utils/tool-output-compact.js';

describe('clipInline small and non-positive max bounds', () => {
  it('does not slice from the end when max < 15 and returns empty string for max <= 0 or NaN', () => {
    expect(clipInline('hello', 20)).toBe('hello');
    expect(clipInline('abcdefghijklmnopqrst', 0)).toBe('');
    expect(clipInline('abcdefghijklmnopqrst', -5)).toBe('');
    expect(clipInline('abcdefghijklmnopqrst', Number.NaN)).toBe('');
    expect(clipInline('abcdefghijklmnopqrst', 10)).toBe('...(20 chars)');
  });
});

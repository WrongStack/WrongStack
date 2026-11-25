import { describe, expect, it } from 'vitest';
import { compactDescription } from '../src/utils/tool-wire-compact.js';

describe('compactDescription maxChars bounds', () => {
  it('returns empty string for negative, zero, fractional < 1, or NaN maxChars', () => {
    expect(compactDescription('hello world', 5)).toBe('hello');
    expect(compactDescription('secret description text', 0)).toBe('');
    expect(compactDescription('secret description text', -1)).toBe('');
    expect(compactDescription('secret description text', 0.5)).toBe('');
    expect(compactDescription('secret description text', Number.NaN)).toBe('');
  });
});

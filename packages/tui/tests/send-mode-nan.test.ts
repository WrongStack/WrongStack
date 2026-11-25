import { describe, expect, it } from 'vitest';
import {
  formatSendModeMessagePreview,
  nextSendModeIndex,
} from '../src/components/send-mode-model.js';

describe('send-mode-model non-finite guards', () => {
  it('sanitizes non-finite indices and maxChars', () => {
    expect(nextSendModeIndex(Number.NaN, 1, 3)).toBe(1);
    expect(nextSendModeIndex(1, Number.NaN, 3)).toBe(1);
    expect(nextSendModeIndex(0, 1, Number.NaN)).toBe(0);
    expect(formatSendModeMessagePreview('hello world', Number.NaN)).toBe('hello world');
    expect(formatSendModeMessagePreview('hello world', 0)).toBe('');
    expect(formatSendModeMessagePreview('hello world', 6)).toBe('hello…');
  });
});

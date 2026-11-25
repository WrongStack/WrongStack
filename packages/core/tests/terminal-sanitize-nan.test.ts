import { describe, expect, it } from 'vitest';
import { sanitizeTerminalPreview, sanitizeTerminalText } from '../src/utils/terminal-sanitize.js';

describe('terminal-sanitize non-finite and negative bounds (F1972)', () => {
  it('falls back to default tabWidth when non-finite', () => {
    expect(sanitizeTerminalText('a\tb', Number.NaN)).toBe('a  b');
    expect(sanitizeTerminalText('a\tb', 4)).toBe('a    b');
  });

  it('clamps negative or non-finite preview limits to 0', () => {
    expect(sanitizeTerminalPreview('abcdef', { maxChars: -2 }).text).toBe('');
    expect(sanitizeTerminalPreview('abcdef', { maxChars: Number.NaN }).text).toBe('');
    expect(sanitizeTerminalPreview('l1\nl2\nl3', { maxLines: -1 }).text).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { getLanguage } from '../src/lib/completion.js';

describe('completion getLanguage extensionless files (F1882)', () => {
  it('returns plaintext for extensionless or dotfile names that match a LANG_MAP key', () => {
    expect(getLanguage('bin/go')).toBe('plaintext');
    expect(getLanguage('ts')).toBe('plaintext');
    expect(getLanguage('.ts')).toBe('plaintext');
    expect(getLanguage('dir.ts/Makefile')).toBe('plaintext');
    expect(getLanguage('src/app.ts')).toBe('typescript');
    expect(getLanguage('main.go')).toBe('go');
  });
});

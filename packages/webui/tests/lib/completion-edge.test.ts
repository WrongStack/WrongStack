/**
 * Edge-case tests for src/lib/completion.ts — file without extension,
 * undefined versionId fallback, and trigger character branches.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCompletionCacheKey,
  getLanguage,
  shouldAllowCompletionLlm,
  shouldAskCompletionServer,
} from '../../src/lib/completion';

describe('getLanguage — fallback branch', () => {
  it('returns plaintext for a file with no extension (line 55 ?? branch)', () => {
    expect(getLanguage('Makefile')).toBe('plaintext');
    expect(getLanguage('Dockerfile')).toBe('plaintext');
    expect(getLanguage('.gitignore')).toBe('plaintext');
  });

  it('returns plaintext for empty string', () => {
    expect(getLanguage('')).toBe('plaintext');
  });

  it('falls back for extension names that collide with Object.prototype', () => {
    for (const ext of ['constructor', 'CONSTRUCTOR', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(getLanguage(`src/file.${ext}`)).toBe('plaintext');
    }
  });
});

describe('buildCompletionCacheKey — versionId fallback (line 88)', () => {
  it('uses empty string when versionId is undefined', () => {
    const key = buildCompletionCacheKey({
      filePath: 'test.ts',
      language: 'typescript',
      lineNumber: 1,
      column: 1,
      linePrefix: '',
      suffix: '',
    });
    // The key format: filePath NUL language NUL lineNumber NUL column NUL versionId NUL triggerChar NUL prefix NUL suffix
    // The empty versionId and triggerChar show as adjacent NUL separators
    expect(key).toBe('test.ts\x00typescript\x001\x001\x00\x00\x00\x00');
  });

  it('uses empty string when triggerCharacter is undefined', () => {
    const key = buildCompletionCacheKey({
      filePath: 'test.ts',
      language: 'typescript',
      lineNumber: 1,
      column: 1,
      versionId: 3,
      linePrefix: '',
      suffix: '',
    });
    // versionId=3 and empty triggerChar: "3\x00\x00" = "3" then two NUL separators
    expect(key).toContain('3\x00\x00\x00');
  });
});

describe('shouldAllowCompletionLlm — dot vs other triggers', () => {
  it('only allows dot trigger character, rejects others', () => {
    expect(shouldAllowCompletionLlm({ triggerCharacter: '.' }, '')).toBe(true);
    expect(shouldAllowCompletionLlm({ triggerCharacter: '_' }, 'any')).toBe(false);
    expect(shouldAllowCompletionLlm({ triggerCharacter: '>' }, 'any')).toBe(false);
  });
});

describe('shouldAskCompletionServer — trigger char vs token length', () => {
  it('asks on trigger char even for short token', () => {
    expect(shouldAskCompletionServer({ triggerCharacter: '.' }, 'a')).toBe(true);
  });

  it('rejects when no trigger and short token', () => {
    expect(shouldAskCompletionServer({}, 'ab')).toBe(false);
  });

  it('accepts when token is 3+ characters', () => {
    expect(shouldAskCompletionServer({}, 'abc')).toBe(true);
  });
});

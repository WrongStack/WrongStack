/**
 * Regression tests for the Chimera review citation-gating pipeline.
 *
 * Bug-hunt cascade (Chimera review) flagged:
 *   - Finding 3 (MEDIUM): absolute-path and case-variant citations were
 *     silently counted as "dropped" because normalization only handled
 *     `\` → `/` and leading `./`, not absolute→relative resolution or
 *     case folding on win32.
 *
 * These tests target the extracted `normalizeFileKeyForCitation` helper,
 * which is the only reachable seam in the otherwise-closure-locked
 * gating pipeline.
 */
import { describe, expect, it } from 'vitest';
import { normalizeFileKeyForCitation } from '../src/execution-chimera-review.js';

describe('normalizeFileKeyForCitation', () => {
  it('passes repo-relative forward slashes through unchanged on POSIX', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      expect(normalizeFileKeyForCitation('packages/cli/src/foo.ts', '/home/user/proj')).toBe(
        'packages/cli/src/foo.ts',
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('resolves an absolute POSIX path against cwd', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      expect(
        normalizeFileKeyForCitation('/home/user/proj/packages/cli/src/foo.ts', '/home/user/proj'),
      ).toBe('packages/cli/src/foo.ts');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('normalises leading ./ on a relative path', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      expect(normalizeFileKeyForCitation('./packages/cli/src/foo.ts', '/home/user/proj')).toBe(
        'packages/cli/src/foo.ts',
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('lowercases on win32 so case-variant citations match changed files', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(
        normalizeFileKeyForCitation('Packages/Cli/Src/Foo.TS', 'D:\\Codebox\\PROJECTS\\Proj'),
      ).toBe('packages/cli/src/foo.ts');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('preserves case on non-win32 platforms', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      expect(normalizeFileKeyForCitation('Packages/Foo.TS', '/home/user/proj')).toBe(
        'Packages/Foo.TS',
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('strips a cwd prefix from an absolute Windows path on win32', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(
        normalizeFileKeyForCitation(
          'D:\\Codebox\\PROJECTS\\Proj\\packages\\cli\\foo.ts',
          'D:\\Codebox\\PROJECTS\\Proj',
        ),
      ).toBe('packages/cli/foo.ts');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('produces identical keys for an absolute Windows path and its relative form on win32', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const cwd = 'D:\\Codebox\\PROJECTS\\Proj';
      const absolute = 'D:\\Codebox\\PROJECTS\\Proj\\packages\\cli\\foo.ts';
      const relative = 'packages/cli/foo.ts';
      const mixedCase = 'Packages/Cli/Foo.ts';
      expect(normalizeFileKeyForCitation(absolute, cwd)).toBe(
        normalizeFileKeyForCitation(relative, cwd),
      );
      expect(normalizeFileKeyForCitation(absolute, cwd)).toBe(
        normalizeFileKeyForCitation(mixedCase, cwd),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});

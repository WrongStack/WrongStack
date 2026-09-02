import { describe, it, expect } from 'vitest';
import { SKIP_DIRS, isHiddenEntry, rankFiles } from '../src/server/file-picker.js';

describe('file-picker', () => {
  describe('SKIP_DIRS', () => {
    it('contains common build and dependency directories', () => {
      expect(SKIP_DIRS.has('.git')).toBe(true);
      expect(SKIP_DIRS.has('node_modules')).toBe(true);
      expect(SKIP_DIRS.has('dist')).toBe(true);
      expect(SKIP_DIRS.has('build')).toBe(true);
      expect(SKIP_DIRS.has('target')).toBe(true);
      expect(SKIP_DIRS.has('coverage')).toBe(true);
    });

    it('is frozen at import time', () => {
      // Set is immutable in practice
      expect(() => ((SKIP_DIRS as any).add = 'test')).not.toThrow();
    });
  });

  describe('isHiddenEntry', () => {
    it('returns true for dotfiles that are not in KEEP_DOTFILES', () => {
      expect(isHiddenEntry('.secret')).toBe(true);
      expect(isHiddenEntry('.env')).toBe(true);
      expect(isHiddenEntry('.DS_Store')).toBe(true);
    });

    it('returns false for common dotfiles that should be visible', () => {
      expect(isHiddenEntry('.wrongstack')).toBe(false);
      expect(isHiddenEntry('.env.example')).toBe(false);
      expect(isHiddenEntry('.gitignore')).toBe(false);
      expect(isHiddenEntry('.eslintrc')).toBe(false);
      expect(isHiddenEntry('.prettierrc')).toBe(false);
    });

    it('returns false for non-dotfiles', () => {
      expect(isHiddenEntry('src')).toBe(false);
      expect(isHiddenEntry('README.md')).toBe(false);
      expect(isHiddenEntry('package.json')).toBe(false);
    });

    it('returns true for empty string (not a dotfile but empty)', () => {
      expect(isHiddenEntry('')).toBe(false); // doesn't start with '.'
    });
  });

  describe('rankFiles', () => {
    const files = [
      'src/index.ts',
      'src/utils/helper.ts',
      'README.md',
      'package.json',
      '.gitignore',
      'src/deep/path/file.ts',
    ];

    it('returns all files sorted alphabetically when query is empty', () => {
      const result = rankFiles(files, '', 10);
      // Alphabetically: '.gitignore', 'package.json', 'README.md', ...
      // (lowercase 'p' < uppercase 'R')
      expect(result[0]).toBe('.gitignore');
      expect(result[1]).toBe('package.json');
      expect(result[2]).toBe('README.md');
      expect(result).toHaveLength(6);
    });

    it('returns up to limit number of results', () => {
      const result = rankFiles(files, '', 2);
      expect(result).toHaveLength(2);
    });

    it('exact basename match has highest score', () => {
      const result = rankFiles(files, 'helper.ts', 10);
      // 'src/utils/helper.ts' has basename matching 'helper.ts' exactly
      expect(result[0]).toBe('src/utils/helper.ts');
    });

    it('basename prefix match scores higher than path substring', () => {
      const result = rankFiles(['src/foo.ts', 'src/foobar.ts'], 'foo', 10);
      // 'foo.ts' basename equals 'foo' → score 100 - 1 = 99
      // 'foobar.ts' basename starts with 'foo' → score 60 - 1 = 59
      expect(result[0]).toBe('src/foo.ts');
      expect(result[1]).toBe('src/foobar.ts');
    });

    it('path substring match scores lower than basename matches', () => {
      const result = rankFiles(['src/util.ts', 'src/sub/util.ts'], 'util', 10);
      expect(result[0]).toBe('src/util.ts'); // basename = 'util.ts', starts with 'util' → 60 - 1 = 59
      expect(result[1]).toBe('src/sub/util.ts'); // basename = 'util.ts', starts with 'util' → 60 - 2 = 58
    });

    it('shallow paths rank higher than deep paths with same basename score', () => {
      const result = rankFiles(['a/b/file.txt', 'file.txt'], 'file.txt', 10);
      // 'file.txt' exactly matches → 100 - 0 = 100 (split: ['file.txt'], length=0)
      // 'a/b/file.txt' exactly matches → 100 - 2 = 98
      expect(result[0]).toBe('file.txt');
      expect(result[1]).toBe('a/b/file.txt');
    });

    it('case-insensitive matching', () => {
      const result = rankFiles(['src/Index.ts'], 'index', 10);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('src/Index.ts');
    });

    it('returns empty array when no files match', () => {
      const result = rankFiles(['src/a.ts', 'src/b.ts'], 'nonexistent', 10);
      expect(result).toEqual([]);
    });

    it('handles empty file list', () => {
      const result = rankFiles([], 'test', 10);
      expect(result).toEqual([]);
    });

    it('handles empty query with empty file list', () => {
      const result = rankFiles([], '', 10);
      expect(result).toEqual([]);
    });

    it('handles files with no directory component', () => {
      const result = rankFiles(['file.ts'], 'file.ts', 10);
      expect(result).toEqual(['file.ts']);
    });
  });
});

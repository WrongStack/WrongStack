import { expect, it } from 'vitest';
import { compileGitignore } from '../src/codebase-index/gitignore.js';

// F1346: git skips a UTF-8 BOM at the start of `.gitignore`. Kept, it glued
// itself to the first rule, which then never matched — the ignore failed open.
it('ignores a leading UTF-8 BOM the way git does (F1346)', () => {
  const lines = '\uFEFFsecret.env\nbuild/\n'.split('\n');
  const matcher = compileGitignore(lines);
  expect(matcher('secret.env', false)).toBe(true);
  expect(matcher('nested/secret.env', false)).toBe(true);
  expect(matcher('build', true)).toBe(true);
  expect(matcher('keep.ts', false)).toBe(false);
  // Only a leading BOM is file framing; one inside a later line stays literal.
  expect(compileGitignore(['a.txt', '\uFEFFb.txt'])('b.txt', false)).toBe(false);
});

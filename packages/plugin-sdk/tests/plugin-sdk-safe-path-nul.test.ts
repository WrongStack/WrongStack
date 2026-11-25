import { describe, expect, it } from 'vitest';
import { safePath } from '../src/runtime/sandbox.js';

describe('safePath NUL byte and whitespace guard', () => {
  it('rejects paths containing NUL bytes or only whitespace', () => {
    expect(
      safePath('foo\0bar.txt', { projectRoot: process.cwd(), followSymlinks: false }),
    ).toBeNull();
    expect(safePath('   ', { projectRoot: process.cwd(), followSymlinks: false })).toBeNull();
    expect(
      safePath('README.md', { projectRoot: process.cwd(), followSymlinks: false }),
    ).not.toBeNull();
  });
});

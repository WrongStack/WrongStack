import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { postToolWritePaths } from '../src/execution/post-tool-write-paths.js';

describe('postToolWritePaths whitespace handling', () => {
  it('omits whitespace-only paths and ignores blank directory overrides', () => {
    const blank = postToolWritePaths(
      'patch',
      { directory: '   ' },
      { dry_run: false, files: ['   '] },
      { projectRoot: '/repo', cwd: '/repo/sub' },
      (s) => s,
    );
    expect(blank.modifiedPaths).toEqual([]);
    expect(blank.modifiedPathsOmitted).toBe(1);

    const valid = postToolWritePaths(
      'patch',
      { directory: '   ' },
      { dry_run: false, files: ['a.ts'] },
      { projectRoot: '/repo', cwd: '/repo/sub' },
      (s) => s,
    );
    expect(valid.modifiedPaths).toEqual([path.resolve('/repo/sub', 'a.ts')]);
  });
});

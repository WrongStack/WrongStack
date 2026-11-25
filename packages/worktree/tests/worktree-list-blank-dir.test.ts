import { describe, expect, it } from 'vitest';
import { listGitWorktrees } from '../src/git-worktree-list.js';

describe('listGitWorktrees blank porcelain directory guard', () => {
  it('skips porcelain records with whitespace-only worktree paths', async () => {
    const entries = await listGitWorktrees('/repo', async () => ({
      code: 0,
      stdout: ['worktree    ', 'HEAD 123456', 'branch refs/heads/main', ''].join('\n'),
      stderr: '',
    }));
    expect(entries).toEqual([]);
  });
});

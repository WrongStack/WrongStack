import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { listGitWorktrees } from '../src/git-worktree-list.js';

it.each(['main', 'linked', 'subdirectory'])(
  'recognizes the current %s checkout through a directory alias',
  async (mode) => {
    const fixture = mkdtempSync(join(realpathSync.native(tmpdir()), 'worktree-list-alias-'));
    const repo = join(fixture, 'repo');
    const linked = join(repo, 'nested-checkout');
    const alias = join(fixture, 'alias');
    mkdirSync(repo, { recursive: true });
    let aliasCreated = false;
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10_000 });
      git(['init', '-q', '-b', 'main']);
      git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'core.hooksPath=',
        'commit',
        '--allow-empty',
        '-qm',
        'fixture',
      ]);
      git(['worktree', 'add', '-q', '-b', 'feature', linked]);
      mkdirSync(join(linked, 'src'));
      const checkout = mode === 'main' ? repo : linked;
      symlinkSync(checkout, alias, process.platform === 'win32' ? 'junction' : 'dir');
      aliasCreated = true;
      const directRoot = mode === 'subdirectory' ? join(checkout, 'src') : checkout;
      const aliasRoot = mode === 'subdirectory' ? join(alias, 'src') : alias;
      const direct = await listGitWorktrees(directRoot);
      expect(direct).toHaveLength(2);
      expect(direct.filter((entry) => entry.current)).toEqual([
        {
          root: realpathSync.native(checkout),
          branch: mode === 'main' ? 'main' : 'feature',
          current: true,
        },
      ]);
      // A nested linked checkout must win over its containing main checkout,
      // regardless of which directory spelling the user opened.
      const throughAlias = await listGitWorktrees(aliasRoot);
      expect(throughAlias).toEqual(direct);
    } finally {
      if (aliasCreated) unlinkSync(alias);
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);

it('retains a successful listing when the project path has disappeared', async () => {
  const fixture = mkdtempSync(join(realpathSync.native(tmpdir()), 'worktree-list-missing-'));
  const repo = join(fixture, 'gone');
  try {
    const entries = await listGitWorktrees(repo, async () => ({
      code: 0,
      stdout: `worktree ${repo}\nbranch refs/heads/main\n\n`,
      stderr: '',
    }));
    expect(entries).toEqual([{ root: repo, branch: 'main', current: true }]);
    await expect(
      listGitWorktrees(repo, async () => ({ code: 1, stdout: '', stderr: 'not a repository' })),
    ).resolves.toEqual([]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

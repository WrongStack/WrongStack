import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { listGitWorktrees } from '../src/git-worktree-list.js';

it.each(['linked', 'linked\u00a0'])(
  'preserves the Git worktree path for %j',
  async (checkoutName) => {
    const fixture = mkdtempSync(join(realpathSync.native(tmpdir()), 'worktree-list-path-'));
    const repo = join(fixture, 'main');
    const linked = join(fixture, checkoutName);
    mkdirSync(repo);
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

      const entries = await listGitWorktrees(linked);
      expect(entries).toEqual([
        { root: realpathSync.native(repo), branch: 'main', current: false },
        { root: realpathSync.native(linked), branch: 'feature', current: true },
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);

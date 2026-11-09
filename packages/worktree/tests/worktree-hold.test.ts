import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdManagedWorktree, WorktreeManager } from '../src/index.js';
import { parseConflictPaths } from '../src/worktree-manager.js';

let root: string;
const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-hold-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 't');
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

// The handle-free sweeps could not tell a crashed run's leftover from a live
// isolated Goal's checkout, so an SDD run's stale sweep deleted a running
// Goal's workspace and its unmerged branch.
describe('managed worktree holds', () => {
  it('keeps a checkout held in this process and sweeps it once released', async () => {
    const manager = new WorktreeManager({ projectRoot: root });
    const held = await manager.allocate('goal:a', { slugHint: 'goal-a' });
    const leftover = await manager.allocate('crashed', { slugHint: 'crashed' });
    const release = await holdManagedWorktree(path.dirname(held.dir), held.dir, 'goal:a');

    await new WorktreeManager({ projectRoot: root }).cleanupAllManaged();
    expect(await exists(held.dir)).toBe(true);
    expect(await exists(leftover.dir)).toBe(false);
    expect(
      execFileSync('git', ['branch', '--list', held.branch], { cwd: root }).toString(),
    ).toContain(held.branch);
    expect(await new WorktreeManager({ projectRoot: root }).removeOne(held.dir)).toEqual({
      removed: false,
    });

    await release();
    await new WorktreeManager({ projectRoot: root }).cleanupAllManaged();
    expect(await exists(held.dir)).toBe(false);
  });

  it('honours a live holder in another process and ignores a dead one', async () => {
    const other = await new WorktreeManager({ projectRoot: root }).allocate('goal:b', {
      slugHint: 'goal-b',
    });
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    await new Promise((resolve) => child.once('spawn', resolve));
    const holds = path.join(path.dirname(other.dir), '.holds');
    await fs.mkdir(holds, { recursive: true });
    await fs.writeFile(
      path.join(holds, `${path.basename(other.dir)}.json`),
      JSON.stringify({ pid: child.pid, ownerId: 'goal:b', at: '' }),
    );

    await new WorktreeManager({ projectRoot: root }).cleanupAllManaged();
    expect(await exists(other.dir)).toBe(true);

    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await new WorktreeManager({ projectRoot: root }).cleanupAllManaged();
    expect(await exists(other.dir)).toBe(false);
  });

  it('cleanupStale ignores held checkouts and removeOne cleans handle branch while refusing non-managed branches (F674)', async () => {
    const events: string[] = [];
    const manager = new WorktreeManager({
      projectRoot: root,
      events: { emit: (name: string) => events.push(name) } as never,
    });
    const held = await manager.allocate('goal:held', { slugHint: 'goal-held' });
    const release = await holdManagedWorktree(path.dirname(held.dir), held.dir, 'goal:held');
    events.length = 0;

    // When only a held worktree exists, cleanupStale must be a true no-op
    expect(await manager.cleanupStale()).toEqual({ removed: 0, detected: 0 });
    expect(events).toEqual([]);
    await release();

    // removeOne without branch argument deletes the handle's wstack/ap/* branch and frees its slug
    const unheld = await manager.allocate('goal:unheld', { slugHint: 'goal-unheld' });
    expect(await manager.removeOne(unheld.dir)).toEqual({ removed: true });
    expect(
      execFileSync('git', ['branch', '--list', unheld.branch], { cwd: root }).toString().trim(),
    ).toBe('');
    expect(manager.get('goal:unheld')).toBeUndefined();
  });

  it('rejects leading-dash or blank Git ref/SHA arguments in revertBaseTo, revertCommits, and mergeBranch (F817)', async () => {
    const calls: string[][] = [];
    const manager = new WorktreeManager({
      projectRoot: root,
      run: async (args) => {
        calls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const handle = {
      id: 'wt-1',
      ownerId: 'owner-1',
      ownerLabel: 'Owner 1',
      slug: 'wt-1',
      branch: 'wstack/ap/wt-1',
      baseBranch: 'main',
      dir: path.join(root, '.wstack', 'wt-1'),
      status: 'active' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      insertions: 0,
      deletions: 0,
      files: 0,
    };

    expect(await manager.revertBaseTo(handle, '-q')).toBe(false);
    expect(await manager.revertBaseTo(handle, '   ')).toBe(false);
    expect(await manager.revertBaseTo({ ...handle, baseBranch: '-f' }, 'abc1234')).toBe(false);
    expect(await manager.revertCommits('main', ['--no-commit'])).toEqual({
      ok: false,
      reverted: 0,
      reason: 'invalid ref',
    });
    expect(await manager.revertCommits('-f', ['abc1234'])).toEqual({
      ok: false,
      reverted: 0,
      reason: 'invalid ref',
    });
    expect(await manager.mergeBranch(' -f', 'main')).toEqual({
      ok: false,
      reason: 'invalid ref',
    });
    await expect(manager.allocate('owner-flag', { baseBranch: '--detach' })).rejects.toThrow(
      /Invalid worktree base branch/,
    );
    await expect(
      manager.adopt('owner-adopt-flag', {
        dir: path.join(root, '.wrongstack', 'worktrees', 'wt-1'),
        branch: 'wstack/ap/wt-1',
        baseBranch: '--orphan',
      }),
    ).rejects.toThrow(/outside the managed checkout root/);
    expect(calls).toEqual([]);
  });

  it('protects branches of held checkouts in detached-HEAD state during cleanupStale/cleanupAllManaged and accumulates multi-commit stats (F28/F29)', async () => {
    const worktreesRoot = path.join(root, '.wrongstack', 'worktrees');
    const heldDetachedDir = path.join(worktreesRoot, 'goal-detached-111111');
    const releaseHold = await holdManagedWorktree(worktreesRoot, heldDetachedDir, 'goal-owner');
    const deletedBranches: string[] = [];
    let commitCount = 0;

    try {
      const manager = new WorktreeManager({
        projectRoot: root,
        run: async (args) => {
          if (args[0] === 'worktree' && args[1] === 'list') {
            return {
              code: 0,
              stdout: `worktree ${heldDetachedDir}\nHEAD 111111\ndetached\n\n`,
              stderr: '',
            };
          }
          if (args[0] === 'branch' && args[1] === '--list') {
            return { code: 0, stdout: 'wstack/ap/goal-detached-111111\n', stderr: '' };
          }
          if (args[0] === 'branch' && args[1] === '-D') {
            deletedBranches.push(args[args.length - 1]!);
            return { code: 0, stdout: '', stderr: '' };
          }
          if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') {
            return { code: 1, stdout: '', stderr: '' };
          }
          if (args[0] === 'config') {
            return { code: 0, stdout: 'Test User\n', stderr: '' };
          }
          if (args.includes('commit')) {
            commitCount++;
            return { code: 0, stdout: '[branch abc] commit\n', stderr: '' };
          }
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
            return { code: 0, stdout: `sha-${commitCount}\n`, stderr: '' };
          }
          if (args[0] === 'show' && args[1] === '--numstat') {
            return {
              code: 0,
              stdout: commitCount === 1 ? '5\t2\tsrc/a.ts\n5\t1\tsrc/b.ts\n' : '4\t1\tsrc/c.ts\n',
              stderr: '',
            };
          }
          return { code: 0, stdout: 'main\n', stderr: '' };
        },
      });

      expect(await manager.cleanupStale()).toEqual({ removed: 0, detected: 0 });
      expect(deletedBranches).toEqual([]);

      const handle = await manager.allocate('multi-commit', { baseBranch: 'main' });
      await manager.commitAll(handle, 'commit 1');
      await manager.commitAll(handle, 'commit 2');
      expect(handle.files).toBe(3);
      expect(handle.insertions).toBe(14);
      expect(handle.deletions).toBe(4);

      expect(
        parseConflictPaths(
          [
            'CONFLICT (modify/delete): src/config.ts deleted in HEAD and modified in wstack/ap/task-1. Version wstack/ap/task-1 of src/config.ts left in tree.',
            'CONFLICT (rename/delete): src/old.ts renamed to src/new.ts in wstack/ap/task-1, but deleted in HEAD.',
          ].join('\n'),
        ),
      ).toEqual(['src/config.ts', 'src/new.ts']);
    } finally {
      await releaseHold();
    }
  });

  it('fails closed in cleanupStale/cleanupAllManaged/diffSummary when git commands exit non-zero and rejects invalid hold markers (F143)', async () => {
    const deletedBranches: string[] = [];
    const manager = new WorktreeManager({
      projectRoot: root,
      run: async (args) => {
        if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
        if (args[0] === 'worktree' && args[1] === 'add') return { code: 0, stdout: '', stderr: '' };
        if (args[0] === 'worktree' && args[1] === 'list') {
          return { code: 1, stdout: '', stderr: 'fatal: worktree list failed' };
        }
        if (args[0] === 'branch' && args[1] === '--list') {
          return { code: 0, stdout: 'wstack/ap/live-owner-123456\n', stderr: '' };
        }
        if (args[0] === 'branch' && args[1] === '-D') {
          deletedBranches.push(args[args.length - 1]!);
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'diff') {
          return { code: 128, stdout: '5\t3\tcorrupt.ts\0', stderr: 'fatal: bad revision' };
        }
        if (args[0] === 'rev-list') {
          return { code: 128, stdout: '-4\n', stderr: 'fatal: bad revision' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const handle = await manager.allocate('live-owner', { slugHint: 'live-owner' });
    expect(await manager.cleanupStale()).toEqual({ removed: 0, detected: 0 });
    expect(await manager.cleanupAllManaged()).toEqual({ removed: 0 });
    expect(deletedBranches).toEqual([]);
    expect(manager.get('live-owner')).toBe(handle);
    expect(await manager.diffSummary(root, 'main')).toEqual({
      files: [],
      insertions: 0,
      deletions: 0,
      commits: 0,
    });
  });
});

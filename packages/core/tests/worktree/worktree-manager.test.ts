import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import {
  normalizeWorktreeEvent,
  projectWorktreeTimeline,
  WORKTREE_EVENT_NAMES,
  type WorktreeTimelineEvent,
} from '@wrongstack/contracts/types/worktree-timeline';
import { describe, expect, it } from 'vitest';
import {
  assertSafePath,
  parseConflictPaths,
  type RunResult,
  WorktreeManager,
} from '../../src/worktree/worktree-manager.js';

/** Records every git invocation and returns scripted results. */
function stubRunner(
  script: (args: string[]) => RunResult = () => ({ code: 0, stdout: '', stderr: '' }),
) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const run = async (args: string[], cwd: string): Promise<RunResult> => {
    calls.push({ args, cwd });
    return script(args);
  };
  return { calls, run };
}

// Stub-git tests still hit the real filesystem for the worktrees-root mkdir,
// so the fake project root must be writable on every platform — a literal
// '/proj' EACCES-fails on POSIX CI (and silently "works" on Windows only
// because D:\proj happens to be creatable).
const PROJ = path.join(os.tmpdir(), `wm-proj-${process.pid}`);

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t',
};

describe('WorktreeManager (stubbed git)', () => {
  it('adopts only the exact managed checkout and branch after restart', async () => {
    const dir = path.join(PROJ, '.wrongstack', 'worktrees', 'build-abc123');
    const branch = 'wstack/ap/build-abc123';
    const { calls, run } = stubRunner((args) =>
      args[0] === 'worktree' && args[1] === 'list'
        ? { code: 0, stdout: `worktree ${dir}\nbranch refs/heads/${branch}\n\n`, stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const handle = await wm.adopt('phase-1', { dir, branch, baseBranch: 'main' });
    expect(handle).toMatchObject({ ownerId: 'phase-1', dir, branch, status: 'active' });
    expect(wm.get('phase-1')).toBe(handle);
    expect(calls.some((call) => call.args[1] === 'add')).toBe(false);
    await expect(
      wm.adopt('phase-2', {
        dir: path.join(PROJ, '..', 'outside'),
        branch,
        baseBranch: 'main',
      }),
    ).rejects.toThrow('outside the managed checkout root');
  });

  it('allocates with `worktree add -b <branch> <dir> <base>` (path before commit-ish)', async () => {
    const { calls, run } = stubRunner((args) =>
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'main\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const h = await wm.allocate('phase-1', { slugHint: 'Build API' });

    const add = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(add).toBeTruthy();
    expect(add!.args).toEqual(['worktree', 'add', '-b', h.branch, h.dir, 'main']);
    // path comes before the base ref
    expect(add!.args.indexOf(h.dir)).toBeLessThan(add!.args.indexOf('main'));
  });

  it('namespaces the branch and sanitizes the slug', async () => {
    const { run } = stubRunner((args) =>
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'main\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const h = await wm.allocate('p', { slugHint: 'Feature: Auth/API!!' });
    expect(h.branch.startsWith('wstack/ap/')).toBe(true);
    expect(h.slug).toMatch(/^feature-auth-api-[0-9a-f]{6}$/);
    expect(h.dir).toContain(path.join('.wrongstack', 'worktrees'));
  });

  it('emits worktree.allocated on success and marks active', async () => {
    const events: Array<{ name: string; payload: any }> = [];
    const fakeBus = { emit: (name: string, payload: any) => events.push({ name, payload }) } as any;
    const { run } = stubRunner((args) =>
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'main\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({
      projectRoot: PROJ,
      events: fakeBus,
      sessionId: () => '2026-06-29/sess_worktree',
      run,
    });
    const h = await wm.allocate('p1', { slugHint: 'x' });
    expect(h.status).toBe('active');
    expect(events.map((e) => e.name)).toContain('worktree.allocated');
    expect(events.find((e) => e.name === 'worktree.allocated')?.payload.sessionId).toBe(
      '2026-06-29/sess_worktree',
    );
  });

  it('marks failed (and emits) when `worktree add` fails', async () => {
    const events: string[] = [];
    const fakeBus = { emit: (name: string) => events.push(name) } as any;
    const { run } = stubRunner((args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[1] === 'add') return { code: 1, stdout: '', stderr: 'fatal: branch exists' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, events: fakeBus, run });
    const h = await wm.allocate('p1');
    expect(h.status).toBe('failed');
    expect(h.lastError).toMatch(/branch exists/);
    expect(events).toContain('worktree.failed');
  });

  it('commitAll injects a fallback identity when git has no user.name/email', async () => {
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      // diff --cached --quiet exits 1 → there ARE staged changes to commit
      if (args[0] === 'diff' && args.includes('--cached'))
        return { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'config') return { code: 0, stdout: '', stderr: '' }; // no identity set
      if (args[0] === 'show') return { code: 0, stdout: '2\t1\tnew.txt\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const h = await wm.allocate('p', { slugHint: 'x' });
    const res = await wm.commitAll(h, 'msg');
    expect(res.committed).toBe(true);
    const commit = calls.map((c) => c.args).find((a) => a.includes('commit'));
    expect(commit).toBeTruthy();
    expect(commit!).toContain('-c');
    expect(commit!.join(' ')).toMatch(/user\.name=/);
    expect(commit!.join(' ')).toMatch(/user\.email=/);
    // -c flags must precede the `commit` subcommand
    expect(commit!.indexOf('-c')).toBeLessThan(commit!.indexOf('commit'));
  });

  it('merge with squash:false threads the fallback identity into the merge argv', async () => {
    // `git merge --no-ff` creates its merge commit directly, so the identity
    // fallback must ride along on the merge invocation itself.
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'config') return { code: 0, stdout: '', stderr: '' }; // no identity
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const h = await wm.allocate('p', { slugHint: 'noff' });
    const res = await wm.merge(h, { squash: false });
    expect(res.ok).toBe(true);
    const merge = calls.map((c) => c.args).find((a) => a.includes('merge'));
    expect(merge).toBeTruthy();
    expect(merge!).toEqual([
      '-c',
      'user.name=Goal',
      '-c',
      'user.email=goal@agent.local',
      'merge',
      '--no-ff',
      h.branch,
    ]);
  });

  it('commitAll does NOT override an existing git identity', async () => {
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'diff' && args.includes('--cached'))
        return { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'config')
        return { code: 0, stdout: args.includes('user.email') ? 'me@x\n' : 'Me\n', stderr: '' };
      if (args[0] === 'show') return { code: 0, stdout: '1\t0\tf\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const h = await wm.allocate('p', { slugHint: 'x' });
    await wm.commitAll(h, 'msg');
    const commit = calls.map((c) => c.args).find((a) => a.includes('commit'));
    expect(commit).toEqual(['commit', '-m', 'msg']);
  });

  it('list()/get() reflect the registry', async () => {
    const { run } = stubRunner((args) =>
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'main\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    await wm.allocate('a', { slugHint: 'a' });
    await wm.allocate('b', { slugHint: 'b' });
    expect(wm.list()).toHaveLength(2);
    expect(wm.get('a')?.ownerId).toBe('a');
  });

  it('currentBase() returns the detected branch + HEAD sha', async () => {
    const { run } = stubRunner((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { code: 0, stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { code: 0, stdout: 'abc123\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    expect(await wm.currentBase()).toEqual({ branch: 'main', sha: 'abc123' });
  });

  it('cleanupAllManaged() removes worktrees under the root + wstack/ap branches, then prunes', async () => {
    const root = path.join(path.resolve(PROJ), '.wrongstack', 'worktrees');
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          code: 0,
          // The main checkout (kept) + two managed worktrees (removed).
          stdout: [
            `worktree ${path.resolve(PROJ)}`,
            '',
            `worktree ${path.join(root, 'a-111111')}`,
            '',
            `worktree ${path.join(root, 'b-222222')}`,
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (args[0] === 'branch' && args[1] === '--list') {
        return { code: 0, stdout: 'wstack/ap/a-111111\nwstack/ap/b-222222\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const res = await wm.cleanupAllManaged();

    expect(res.removed).toBe(2);
    const removes = calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(removes).toHaveLength(2);
    // The main checkout must NOT be removed.
    expect(removes.some((c) => c.args.includes(path.resolve(PROJ)))).toBe(false);
    expect(calls.filter((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toHaveLength(2);
    expect(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'prune')).toBe(true);
  });

  it('cleanupStale() sweeps when a worktree dir is detected', async () => {
    const root = path.join(path.resolve(PROJ), '.wrongstack', 'worktrees');
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          code: 0,
          stdout: [
            `worktree ${path.resolve(PROJ)}`,
            '',
            `worktree ${path.join(root, 'a-111111')}`,
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const res = await wm.cleanupStale();
    expect(res.detected).toBe(1);
    expect(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
  });

  it('cleanupStale() also detects branch-only orphans (no worktree dir)', async () => {
    const { calls, run } = stubRunner((args) => {
      // No managed worktree dirs (only the main checkout) …
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { code: 0, stdout: `worktree ${path.resolve(PROJ)}\n`, stderr: '' };
      }
      // … but a dangling wstack/ap branch remains.
      if (args[0] === 'branch' && args[1] === '--list') {
        return { code: 0, stdout: 'wstack/ap/ghost-abcdef\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const res = await wm.cleanupStale();
    expect(res.detected).toBe(1);
    // The sweep deletes the dangling branch.
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toBe(true);
  });

  it('listManaged() returns managed worktrees (with branch) + wstack/ap branches, removes nothing', async () => {
    const root = path.join(path.resolve(PROJ), '.wrongstack', 'worktrees');
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          code: 0,
          stdout: [
            `worktree ${path.resolve(PROJ)}`,
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            `worktree ${path.join(root, 'a-111111')}`,
            'HEAD bbb',
            'branch refs/heads/wstack/ap/a-111111',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (args[0] === 'branch' && args[1] === '--list') {
        return { code: 0, stdout: 'wstack/ap/a-111111\nwstack/ap/ghost-222222\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const res = await wm.listManaged();

    // Only the managed checkout (not the main one) is returned, with its branch.
    expect(res.worktrees).toEqual([
      { dir: path.join(root, 'a-111111'), branch: 'wstack/ap/a-111111' },
    ]);
    expect(res.branches).toEqual(['wstack/ap/a-111111', 'wstack/ap/ghost-222222']);
    // Read-only: never removes/prunes.
    expect(
      calls.some((c) => c.args[1] === 'remove' || c.args[1] === 'prune' || c.args[1] === '-D'),
    ).toBe(false);
  });

  it('removeOne() force-removes a managed worktree + its branch, refuses paths outside root', async () => {
    const root = path.join(path.resolve(PROJ), '.wrongstack', 'worktrees');
    const { calls, run } = stubRunner(() => ({ code: 0, stdout: '', stderr: '' }));
    const wm = new WorktreeManager({ projectRoot: PROJ, run });

    const ok = await wm.removeOne(path.join(root, 's1'), 'wstack/ap/s1');
    expect(ok.removed).toBe(true);
    expect(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toBe(true);

    // A path outside the worktrees root is refused without any git remove.
    calls.length = 0;
    const bad = await wm.removeOne(path.resolve(PROJ), 'main');
    expect(bad.removed).toBe(false);
    expect(calls.some((c) => c.args[1] === 'remove')).toBe(false);
  });

  it('removeBranch() deletes one managed branch and refuses anything else', async () => {
    const { calls, run } = stubRunner((args) =>
      args[3] === 'wstack/ap/busy'
        ? { code: 1, stdout: '', stderr: "error: cannot delete branch 'wstack/ap/busy'" }
        : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: PROJ, run });

    expect(await wm.removeBranch('wstack/ap/ghost-1')).toEqual({ removed: true });
    expect(calls.at(-1)?.args).toEqual(['branch', '-D', '--', 'wstack/ap/ghost-1']);
    expect(await wm.removeBranch('wstack/ap/busy')).toEqual({ removed: false });

    calls.length = 0;
    expect(await wm.removeBranch('main')).toEqual({ removed: false });
    expect(await wm.removeBranch('--force')).toEqual({ removed: false });
    expect(calls).toEqual([]);

    const throwing = new WorktreeManager({
      projectRoot: PROJ,
      run: async () => {
        throw new Error('spawn git ENOENT');
      },
    });
    expect(await throwing.removeBranch('wstack/ap/x')).toEqual({ removed: false });
  });

  it('mergeBranch() squash-merges + commits on success', async () => {
    const { calls, run } = stubRunner((args) =>
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'main\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const res = await wm.mergeBranch('wstack/ap/s1', 'main');
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.args.includes('merge') && c.args.includes('--squash'))).toBe(true);
    expect(calls.some((c) => c.args.includes('commit'))).toBe(true);
  });

  it('mergeBranch() refuses on a dirty base tree (no merge attempted)', async () => {
    const { calls, run } = stubRunner((args) =>
      args[0] === 'status'
        ? { code: 0, stdout: ' M f.ts\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const res = await wm.mergeBranch('wstack/ap/s1', 'main');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/uncommitted/i);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('merge() refuses on a dirty base tree before checkout or squash merge', async () => {
    const events: string[] = [];
    const fakeBus = { emit: (name: string) => events.push(name) } as any;
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'status') return { code: 0, stdout: ' M f.ts\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, events: fakeBus, run });
    const h = await wm.allocate('p', { slugHint: 'dirty' });
    const res = await wm.merge(h, { squash: true });

    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/uncommitted/i);
    expect(h.status).toBe('failed');
    expect(events).toContain('worktree.failed');
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(false);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('merge() names conflicted files by their markers when git reports none', async () => {
    // The shape Linux CI produces: a failed squash merge whose output carries
    // no CONFLICT line and whose index lists nothing unmerged.
    await fs.mkdir(PROJ, { recursive: true });
    await fs.writeFile(path.join(PROJ, 'seed.txt'), 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n');
    await fs.writeFile(path.join(PROJ, 'clean.txt'), 'Title\n=======\n');
    try {
      const { run } = stubRunner((args) => {
        if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
        if (args.includes('merge')) return { code: 1, stdout: '', stderr: 'merge failed' };
        if (args[0] === 'diff' && args.includes('HEAD')) {
          return { code: 0, stdout: 'seed.txt\0clean.txt\0', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });
      const wm = new WorktreeManager({ projectRoot: PROJ, run });
      const h = await wm.allocate('p', { slugHint: 'marker-fallback' });
      const res = await wm.merge(h, { squash: true });

      expect(res.ok).toBe(false);
      expect(res.conflict).toBe(true);
      expect(res.conflictFiles).toEqual(['seed.txt']);
      expect(h.status).toBe('needs-review');
    } finally {
      await fs.rm(path.join(PROJ, 'seed.txt'), { force: true });
      await fs.rm(path.join(PROJ, 'clean.txt'), { force: true });
    }
  });

  it('merge() fails without calling the resolver when git failed but nothing conflicts', async () => {
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args.includes('merge')) {
        return { code: 128, stdout: '', stderr: 'Committer identity unknown' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const h = await wm.allocate('p', { slugHint: 'no-conflict-fail' });
    let resolverCalled = false;
    const res = await wm.merge(h, {
      squash: true,
      resolve: async () => {
        resolverCalled = true;
        return true;
      },
    });

    expect(resolverCalled).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.conflict).toBeUndefined();
    expect(h.status).toBe('failed');
    expect(calls.some((c) => c.args[0] === 'add')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'reset' && c.args.includes('--hard'))).toBe(true);
  });

  it('mergeBranch() aborts cleanly on conflict and reports paths', async () => {
    const { calls, run } = stubRunner((args) => {
      if (args.includes('merge')) {
        return { code: 1, stdout: 'CONFLICT (content): Merge conflict in db.sql\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const res = await wm.mergeBranch('wstack/ap/s1', 'main');
    expect(res.ok).toBe(false);
    expect(res.conflict).toBe(true);
    expect(res.conflictFiles).toContain('db.sql');
    // Hard-reset to undo the squash (never leave base dirty).
    expect(calls.some((c) => c.args[0] === 'reset' && c.args.includes('--hard'))).toBe(true);
  });

  it('diffSummary() parses numstat + commit count', async () => {
    const { run } = stubRunner((args) => {
      // -z keeps non-ASCII names unquoted; a rename names its old and new
      // paths in the two fields after an empty path.
      if (args[0] === 'diff' && args.includes('--numstat') && args.includes('-z')) {
        return {
          code: 0,
          stdout: '4\t1\tsrc/a.ts\0-\t-\timg.png\x002\t0\t\0old.ts\0şema.ts\0',
          stderr: '',
        };
      }
      if (args[0] === 'rev-list') return { code: 0, stdout: '3\n', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const s = await wm.diffSummary('/proj/.wrongstack/worktrees/s1', 'main');
    expect(s.insertions).toBe(6);
    expect(s.deletions).toBe(1);
    expect(s.files.map((f) => f.path)).toEqual(['src/a.ts', 'img.png', 'şema.ts']);
    expect(s.commits).toBe(3);
  });

  it('cleanupStale() is a no-op when nothing is managed', async () => {
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { code: 0, stdout: `worktree ${path.resolve(PROJ)}\n`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const res = await wm.cleanupStale();
    expect(res).toEqual({ removed: 0, detected: 0 });
    expect(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
  });

  it('revertCommits() reverts each sha newest→oldest on the base branch', async () => {
    const { calls, run } = stubRunner(() => ({ code: 0, stdout: '', stderr: '' }));
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const res = await wm.revertCommits('main', ['old', 'mid', 'new']);

    expect(res).toEqual({ ok: true, reverted: 3 });
    const reverts = calls.filter((c) => c.args.includes('revert')).map((c) => c.args.at(-1));
    expect(reverts).toEqual(['new', 'mid', 'old']); // reverse landing order
    expect(calls.some((c) => c.args[0] === 'checkout' && c.args[1] === 'main')).toBe(true);
  });

  it('revertCommits() refuses on a dirty working tree', async () => {
    const { calls, run } = stubRunner((args) =>
      args[0] === 'status'
        ? { code: 0, stdout: ' M file.ts\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const res = await wm.revertCommits('main', ['a']);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/uncommitted/i);
    expect(calls.some((c) => c.args.includes('revert'))).toBe(false);
  });

  it('revertCommits() aborts on a conflicting revert and reports the sha', async () => {
    const { calls, run } = stubRunner((args) => {
      if (args.includes('revert') && args.at(-1) === 'bad') {
        return { code: 1, stdout: '', stderr: 'CONFLICT' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const res = await wm.revertCommits('main', ['bad']);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/revert of bad/);
    expect(calls.some((c) => c.args[0] === 'revert' && c.args[1] === '--abort')).toBe(true);
  });

  it('revertCommits() with no shas is a no-op success', async () => {
    const { run } = stubRunner();
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    expect(await wm.revertCommits('main', [])).toEqual({
      ok: true,
      reverted: 0,
      reason: 'nothing to revert',
    });
  });
});

describe.skipIf(!gitAvailable)('WorktreeManager (real repo)', () => {
  async function makeRepo(): Promise<string> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-real-'));
    spawnSync('git', ['init', '-q', base], { stdio: 'ignore' });
    await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nline2\nline3\n');
    spawnSync('git', ['-C', base, 'add', '-A'], { stdio: 'ignore', env: GIT_ENV });
    spawnSync('git', ['-C', base, 'commit', '-q', '-m', 'init'], { stdio: 'ignore', env: GIT_ENV });
    spawnSync('git', ['-C', base, 'branch', '-M', 'main'], { stdio: 'ignore', env: GIT_ENV });
    return base;
  }

  it('allocate → commitAll → squash-merge lands the change on base', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('phase-1', { slugHint: 'feature' });
      expect(h.status).toBe('active');
      const dotGit = await fs.stat(path.join(h.dir, '.git'));
      expect(dotGit.isFile()).toBe(true);

      await fs.writeFile(path.join(h.dir, 'new.txt'), 'hello\n');
      const c = await wm.commitAll(h, 'feat: add new.txt');
      expect(c.committed).toBe(true);
      expect(h.files).toBeGreaterThanOrEqual(1);
      expect(h.insertions).toBeGreaterThanOrEqual(1);

      const m = await wm.merge(h, { squash: true });
      expect(m.ok).toBe(true);
      expect(h.status).toBe('merged');

      // file is present on the base branch working tree
      const onBase = await fs.readFile(path.join(base, 'new.txt'), 'utf8');
      expect(onBase.replace(/\r/g, '')).toBe('hello\n');

      await wm.release(h, { keep: false });
      // Removed from the registry (deterministic). The on-disk removal is
      // `git worktree remove --force`, whose timing is OS-dependent on Windows,
      // so we don't assert the directory is gone here.
      expect(wm.get('phase-1')).toBeUndefined();
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('no-ff merge (squash:false) succeeds with no git identity configured', async () => {
    const base = await makeRepo();
    // Hide identity the way a fresh CI container looks: empty GIT_CONFIG_GLOBAL
    // + no system config + no GIT_AUTHOR_*/GIT_COMMITTER_* env. The manager's
    // git children inherit process.env via buildChildEnv, so this makes the
    // in-test manager identity-less. Restored in `finally` (vitest's default
    // forks pool = per-file process, so the mutation cannot leak across files).
    const saved = { ...process.env };
    const emptyGlobalConfig = path.join(base, 'empty-gitconfig');
    await fs.writeFile(emptyGlobalConfig, '', 'utf8');
    delete process.env['GIT_AUTHOR_NAME'];
    delete process.env['GIT_AUTHOR_EMAIL'];
    delete process.env['GIT_COMMITTER_NAME'];
    delete process.env['GIT_COMMITTER_EMAIL'];
    process.env['GIT_CONFIG_GLOBAL'] = emptyGlobalConfig;
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'noff-identity' });
      await fs.writeFile(path.join(h.dir, 'new.txt'), 'hello\n', 'utf8');
      const c = await wm.commitAll(h, 'feat: add new.txt');
      expect(c.committed).toBe(true);

      const m = await wm.merge(h, { squash: false });
      // Regression: `git merge --no-ff` creates its merge commit directly.
      // Without the identity fallback on the merge argv it failed with
      // "Committer identity unknown" and was misreported as
      // { conflict: true } with the handle parked needs-review.
      expect(m.ok).toBe(true);
      expect(m.conflict).not.toBe(true);
      expect(h.status).toBe('merged');
      const onBase = await fs.readFile(path.join(base, 'new.txt'), 'utf8');
      expect(onBase.replace(/\r/g, '')).toBe('hello\n');

      await wm.release(h, { keep: false });
      expect(wm.get('p')).toBeUndefined();
    } finally {
      process.env = saved;
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('release({keep:false}) on a removal failure keeps the handle and reports kept:true', async () => {
    const base = await makeRepo();
    try {
      const events: Array<{ name: string; payload: any }> = [];
      const fakeBus = {
        emit: (name: string, payload: any) => events.push({ name, payload }),
      } as any;
      const wm = new WorktreeManager({ projectRoot: base, events: fakeBus });
      const h = await wm.allocate('p', { slugHint: 'locked-release' });
      await fs.writeFile(path.join(h.dir, 'work.txt'), 'precious\n', 'utf8');
      await wm.commitAll(h, 'feat: still on disk');

      // A locked worktree fails `worktree remove --force` on real git
      // ("cannot remove a locked working tree; use 'remove -f -f'"), so the
      // checkout, branch, and commits all remain on disk. Regression: the
      // handle used to be dropped and worktree.released reported kept:false
      // while nothing had actually been removed.
      spawnSync('git', ['-C', base, 'worktree', 'lock', h.dir], { stdio: 'ignore' });
      await wm.release(h, { keep: false });

      expect(wm.get('p')).toBeDefined();
      const rel = events.find((e) => e.name === 'worktree.released');
      expect(rel?.payload['kept']).toBe(true);
      expect(
        await fs
          .stat(h.dir)
          .then(() => true)
          .catch(() => false),
      ).toBe(true);
      // git refuses to delete a branch checked out in a registered worktree,
      // so the branch must survive a failed removal too.
      const ref = spawnSync(
        'git',
        ['-C', base, 'rev-parse', '--verify', '--quiet', `${h.branch}^{commit}`],
        { stdio: 'ignore' },
      );
      expect(ref.status).toBe(0);

      spawnSync('git', ['-C', base, 'worktree', 'unlock', h.dir], { stdio: 'ignore' });
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('removeOne keeps the handle and branch when the removal fails (locked worktree)', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const locked = await wm.allocate('locked', { slugHint: 'locked-rm' });
      spawnSync('git', ['-C', base, 'worktree', 'lock', locked.dir], { stdio: 'ignore' });

      const r = await wm.removeOne(locked.dir, locked.branch);
      expect(r.removed).toBe(false);
      expect(wm.get('locked')).toBeDefined();
      const ref = spawnSync(
        'git',
        ['-C', base, 'rev-parse', '--verify', '--quiet', `${locked.branch}^{commit}`],
        { stdio: 'ignore' },
      );
      expect(ref.status).toBe(0);

      // Control: an unlocked worktree is removed normally, handle dropped.
      const free = await wm.allocate('free', { slugHint: 'free-rm' });
      const ok = await wm.removeOne(free.dir, free.branch);
      expect(ok.removed).toBe(true);
      expect(wm.get('free')).toBeUndefined();

      spawnSync('git', ['-C', base, 'worktree', 'unlock', locked.dir], { stdio: 'ignore' });
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('removeBranch deletes a branch-only orphan but not a checked-out branch', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      spawnSync('git', ['-C', base, 'branch', 'wstack/ap/leftover'], { stdio: 'ignore' });
      const held = await wm.allocate('held', { slugHint: 'held-br' });
      const hasRef = (b: string) =>
        spawnSync('git', ['-C', base, 'rev-parse', '--verify', '--quiet', `${b}^{commit}`], {
          stdio: 'ignore',
        }).status === 0;

      expect(await wm.removeBranch('wstack/ap/leftover')).toEqual({ removed: true });
      expect(hasRef('wstack/ap/leftover')).toBe(false);
      // git refuses a branch a worktree still has checked out.
      expect(await wm.removeBranch(held.branch)).toEqual({ removed: false });
      expect(hasRef(held.branch)).toBe(true);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('allocate after commitAll returns the same worktree (committing is a live state)', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h1 = await wm.allocate('p', { slugHint: 'idem' });
      await fs.writeFile(path.join(h1.dir, 'work.txt'), 'work\n', 'utf8');
      await wm.commitAll(h1, 'feat: committed, not yet merged');

      // Regression: 'committing' is a live, owned state (webui-server's
      // ACTIVE_STATUSES already includes it). Re-allocation used to fall
      // through the reuse guard and mint a duplicate checkout + branch while
      // the manager forgot the original — orphaning the committed-but-
      // unmerged first checkout until /worktree clean.
      const h2 = await wm.allocate('p', { slugHint: 'idem' });
      expect(h2.id).toBe(h1.id);
      expect(h2.dir).toBe(h1.dir);
      expect(h2.branch).toBe(h1.branch);
      expect(wm.get('p')?.id).toBe(h1.id);

      // Boundary: once the unit of work is merged, a repeat allocate mints a
      // fresh worktree — the merged one is complete.
      const m = await wm.merge(h1, { squash: true });
      expect(m.ok).toBe(true);
      const h3 = await wm.allocate('p', { slugHint: 'idem' });
      expect(h3.id).not.toBe(h1.id);
      expect(h3.status).toBe('active');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('gated concurrent allocate() for one owner shares a single checkout', async () => {
    // Regression: the reuse guard ran before the base-branch detection await,
    // so two concurrent allocate() calls for the same owner both passed it
    // and each minted its own worktree + branch — the first checkout/branch
    // orphaned on disk and invisible to release(). The guard re-runs after
    // the await, so the second caller adopts the in-flight handle.
    const calls: Array<{ args: string[]; cwd: string }> = [];
    let parked: (() => void) | undefined;
    const wm = new WorktreeManager({
      projectRoot: PROJ,
      run: async (args, cwd): Promise<RunResult> => {
        calls.push({ args, cwd });
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && !parked) {
          // Park the first caller inside base-branch detection until the test
          // confirms the second call is in flight.
          await new Promise<void>((resolve) => {
            parked = resolve;
          });
        }
        return { code: 0, stdout: 'main', stderr: '' };
      },
    });
    const first = wm.allocate('owner', { slugHint: 'gated' });
    await new Promise((r) => setImmediate(r));
    expect(parked).toBeTypeOf('function');
    const second = wm.allocate('owner', { slugHint: 'gated' });
    await new Promise((r) => setImmediate(r));
    parked?.();
    const [h1, h2] = await Promise.all([first, second]);

    expect(h1.id).toBe(h2.id);
    const adds = calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(adds).toHaveLength(1);
    expect(wm.list()).toHaveLength(1);
    expect(wm.get('owner')?.status).toBe('active');
  });

  it('commitAll on a clean tree returns committed:false', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'noop' });
      const c = await wm.commitAll(h, 'nothing');
      expect(c.committed).toBe(false);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('conflicting merge → needs-review, run not aborted, worktree kept', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'conflict' });

      // Worktree edits line2.
      await fs.writeFile(path.join(h.dir, 'seed.txt'), 'line1\nWORKTREE\nline3\n');
      await wm.commitAll(h, 'edit on branch');

      // Base also edits line2 → conflict on squash-merge.
      await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nBASE\nline3\n');
      spawnSync('git', ['-C', base, 'commit', '-aqm', 'edit on base'], {
        stdio: 'ignore',
        env: GIT_ENV,
      });

      const m = await wm.merge(h, { squash: true });
      // Critical semantics: the conflict is detected, the run is not aborted,
      // and the worktree is parked for review.
      expect(m.ok).toBe(false);
      expect(m.conflict).toBe(true);
      expect(h.status).toBe('needs-review');
      // Conflict-FILE listing is best-effort — git's machine-readable conflict
      // reporting varies by version/config/runner — so we only require it to
      // name seed.txt when it reported anything at all. (parseConflictPaths is
      // unit-tested separately for the documented output format.)
      if (m.conflictFiles && m.conflictFiles.length > 0) {
        expect(m.conflictFiles).toContain('seed.txt');
      }

      // release keeps a needs-review worktree on disk regardless of keep flag
      await wm.release(h, { keep: false });
      const stat = await fs.stat(h.dir);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('resolve callback clears the conflict → merge lands on base (resolved)', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'resolve-ok' });

      await fs.writeFile(path.join(h.dir, 'seed.txt'), 'line1\nWORKTREE\nline3\n');
      await wm.commitAll(h, 'edit on branch');
      await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nBASE\nline3\n');
      spawnSync('git', ['-C', base, 'commit', '-aqm', 'edit on base'], {
        stdio: 'ignore',
        env: GIT_ENV,
      });

      let sawConflict: string[] | undefined;
      const m = await wm.merge(h, {
        squash: true,
        resolve: async ({ conflictFiles, cwd }) => {
          sawConflict = conflictFiles;
          // Resolve by combining both sides and removing every marker.
          await fs.writeFile(path.join(cwd, 'seed.txt'), 'line1\nBASE+WORKTREE\nline3\n');
          return true;
        },
      });

      expect(m.ok).toBe(true);
      expect(m.resolved).toBe(true);
      expect(h.status).toBe('merged');
      // `resolved: true` only comes from opts.resolve, so the callback ran.
      expect(sawConflict).toContain('seed.txt');
      const onBase = await fs.readFile(path.join(base, 'seed.txt'), 'utf8');
      expect(onBase.replace(/\r/g, '')).toBe('line1\nBASE+WORKTREE\nline3\n');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('baseHead + revertBaseTo undo a resolved squash-merge back to the captured tip', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'revert-resolved' });

      await fs.writeFile(path.join(h.dir, 'seed.txt'), 'line1\nWORKTREE\nline3\n');
      await wm.commitAll(h, 'edit on branch');
      await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nBASE\nline3\n');
      spawnSync('git', ['-C', base, 'commit', '-aqm', 'edit on base'], {
        stdio: 'ignore',
        env: GIT_ENV,
      });

      // Capture the base tip BEFORE the merge (the revert target).
      const preSha = await wm.baseHead(h);
      expect(preSha).toBeTruthy();

      const m = await wm.merge(h, {
        squash: true,
        resolve: async ({ cwd }) => {
          await fs.writeFile(path.join(cwd, 'seed.txt'), 'line1\nBASE+WORKTREE\nline3\n');
          return true;
        },
      });
      expect(m.ok).toBe(true);
      expect(m.resolved).toBe(true);
      // The squash-resolution commit advanced base.
      const after = spawnSync('git', ['-C', base, 'log', '-1', '--pretty=%H'], {
        encoding: 'utf8',
        env: GIT_ENV,
      });
      expect(after.stdout.trim()).not.toBe(preSha);

      // Revert undoes it: base tip + tree are back to the pre-merge state.
      expect(await wm.revertBaseTo(h, preSha!)).toBe(true);
      const reverted = spawnSync('git', ['-C', base, 'log', '-1', '--pretty=%H'], {
        encoding: 'utf8',
        env: GIT_ENV,
      });
      expect(reverted.stdout.trim()).toBe(preSha);
      const onBase = await fs.readFile(path.join(base, 'seed.txt'), 'utf8');
      expect(onBase.replace(/\r/g, '')).toBe('line1\nBASE\nline3\n');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('revertBaseTo restores the captured tip when only untracked files dirty the tree', async () => {
    // Post-merge verification writes an untracked artifact and then fails.
    // Untracked files survive `reset --hard`, so the rollback must still
    // restore the captured base SHA — and leave the artifact on disk for
    // inspection (the regression scenario the dirty-tree guard regressed on).
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'revert-untracked' });

      await fs.writeFile(path.join(h.dir, 'seed.txt'), 'line1\nWORKTREE\nline3\n');
      await wm.commitAll(h, 'edit on branch');
      await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nBASE\nline3\n');
      spawnSync('git', ['-C', base, 'commit', '-aqm', 'edit on base'], {
        stdio: 'ignore',
        env: GIT_ENV,
      });

      const preSha = await wm.baseHead(h);
      expect(preSha).toBeTruthy();

      const m = await wm.merge(h, {
        squash: true,
        resolve: async ({ cwd }) => {
          await fs.writeFile(path.join(cwd, 'seed.txt'), 'line1\nBASE+WORKTREE\nline3\n');
          return true;
        },
      });
      expect(m.ok).toBe(true);
      expect(m.resolved).toBe(true);

      // Verification dirties the tree with an untracked artifact before failing.
      await fs.writeFile(path.join(base, 'verify-artifact.log'), 'regression evidence\n');
      expect(await wm.revertBaseTo(h, preSha!)).toBe(true);

      // Base tip is back at the captured pre-merge commit…
      const reverted = spawnSync('git', ['-C', base, 'log', '-1', '--pretty=%H'], {
        encoding: 'utf8',
        env: GIT_ENV,
      });
      expect(reverted.stdout.trim()).toBe(preSha);
      const onBase = await fs.readFile(path.join(base, 'seed.txt'), 'utf8');
      expect(onBase.replace(/\r/g, '')).toBe('line1\nBASE\nline3\n');
      // …while the untracked verification output is preserved.
      const artifact = await fs.readFile(path.join(base, 'verify-artifact.log'), 'utf8');
      expect(artifact).toContain('regression evidence');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('revertBaseTo refuses on tracked edits so verification output is never destroyed', async () => {
    // When verification MODIFIES a tracked file before failing, the hard reset
    // would silently destroy those edits — the guard must refuse (false), which
    // the SDD caller treats as a hard-stop, leaving the base tip untouched.
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'revert-tracked' });

      await fs.writeFile(path.join(h.dir, 'seed.txt'), 'line1\nWORKTREE\nline3\n');
      await wm.commitAll(h, 'edit on branch');
      await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nBASE\nline3\n');
      spawnSync('git', ['-C', base, 'commit', '-aqm', 'edit on base'], {
        stdio: 'ignore',
        env: GIT_ENV,
      });

      const preSha = await wm.baseHead(h);
      expect(preSha).toBeTruthy();

      const m = await wm.merge(h, {
        squash: true,
        resolve: async ({ cwd }) => {
          await fs.writeFile(path.join(cwd, 'seed.txt'), 'line1\nBASE+WORKTREE\nline3\n');
          return true;
        },
      });
      expect(m.ok).toBe(true);

      // Verification edits a TRACKED file before failing — rollback must refuse.
      await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nEDITED BY VERIFICATION\nline3\n');
      expect(await wm.revertBaseTo(h, preSha!)).toBe(false);

      // The base tip is NOT rolled back (the merge commit is still in place)
      // and the tracked edit survives untouched.
      const tip = spawnSync('git', ['-C', base, 'log', '-1', '--pretty=%H'], {
        encoding: 'utf8',
        env: GIT_ENV,
      });
      expect(tip.stdout.trim()).not.toBe(preSha);
      const onBase = await fs.readFile(path.join(base, 'seed.txt'), 'utf8');
      expect(onBase).toContain('EDITED BY VERIFICATION');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  // #249: git merge on Windows CI can behave differently with auto-crlf and
  // other git-config defaults, causing the merge to succeed (no conflict)
  // instead of leaving markers. Skip on Windows until the root cause is found.
  it.skipIf(process.platform === 'win32')(
    'resolve callback that leaves markers → aborts to needs-review (never commits)',
    async () => {
      const base = await makeRepo();
      try {
        const wm = new WorktreeManager({ projectRoot: base });
        const h = await wm.allocate('p', { slugHint: 'resolve-bad' });

        await fs.writeFile(path.join(h.dir, 'seed.txt'), 'line1\nWORKTREE\nline3\n');
        await wm.commitAll(h, 'edit on branch');
        await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nBASE\nline3\n');
        spawnSync('git', ['-C', base, 'commit', '-aqm', 'edit on base'], {
          stdio: 'ignore',
          env: GIT_ENV,
        });

        // Resolver claims success but leaves the conflict markers in place.
        // The resolver WRITES the markers itself rather than relying on merge
        // leftovers: decisive-arm evidence (run 31831273637) showed a Linux
        // runner entering the conflict branch with both probes empty AND no
        // markers anywhere in the tree (git auto-resolved), which made the
        // "leaves markers" premise runner-dependent and the test flaky.
        // Writing them makes the premise hold on every runner shape.
        let resolverConflictFiles: string[] | null = null;
        const m = await wm.merge(h, {
          squash: true,
          resolve: async ({ conflictFiles, cwd }) => {
            resolverConflictFiles = conflictFiles;
            await fs.writeFile(
              path.join(cwd, 'seed.txt'),
              'line1\n<<<<<<< HEAD\nBASE\n=======\nWORKTREE\n>>>>>>> wstack/ap/resolve-bad\nline3\n',
            );
            return true;
          },
        });

        if (m.ok) {
          // Fourth capture round (after 1d51da80e, de7bb9be8, 51a4ca708 and
          // the disproven 31825862195 evidence gate, reverted in b6b002492).
          // The prior arm could not distinguish the tolerance escape
          // (resolver ran, staged nothing, "nothing to commit" was tolerated)
          // from a genuinely clean merge — this one can.
          const diag = spawnSync('git', ['-C', base, 'log', '-3', '--oneline'], {
            encoding: 'utf8',
            env: GIT_ENV,
          });
          const probe = spawnSync('git', ['-C', base, 'diff', '--name-only', '--diff-filter=U'], {
            encoding: 'utf8',
            env: GIT_ENV,
          });
          const committedSeed = await fs
            .readFile(path.join(base, 'seed.txt'), 'utf8')
            .catch(() => '<unreadable>');
          throw new Error(
            `merge returned ok:true — decisive arm fired. ` +
              `resolverConflictFiles: ${JSON.stringify(resolverConflictFiles)} ` +
              `(null = resolver never called → clean-merge escape; ` +
              `[] = conflict path with empty probe → tolerance escape; ` +
              `seed.txt = marker scan missed known files); ` +
              `result: ok=${m.ok} conflict=${String(m.conflict)} resolved=${String(m.resolved)}; ` +
              `unmerged probe now: [${probe.stdout.trim()}]; ` +
              `committed seed.txt still has markers: ${/<{7}(?: |$)|>{7}(?: |$)/m.test(committedSeed)}; ` +
              `recent history:\n${diag.stdout}`,
          );
        }

        expect(m.ok).toBe(false);
        expect(m.conflict).toBe(true);
        expect(m.resolved).toBeFalsy();
        expect(h.status).toBe('needs-review');
        // base HEAD is still the pre-merge commit (nothing was committed)
        const head = spawnSync('git', ['-C', base, 'log', '-1', '--pretty=%s'], {
          encoding: 'utf8',
          env: GIT_ENV,
        });
        expect(head.stdout.trim()).toBe('edit on base');
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    },
    120_000,
  );

  // Regression: `hasConflictMarkers` used a regex that matched any line
  // consisting of 7+ `=` characters. Markdown setext-heading underlines
  // (`Heading\n=======\n`) satisfy that pattern, so a legitimately-
  // resolved worktree that staged a markdown file with a setext heading
  // would be flagged as having conflict markers and discarded. The
  // tighter predicate requires the `=======` line to be preceded by a
  // `<<<<<<<` or `|||||||` line within the same file — i.e. only the
  // middle divider of an actual conflict block counts.
  it('hasConflictMarkers returns false for a file with a markdown setext heading (======= underline, no <<<<<<< or ||||||| above)', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'setext-fp' });

      // Stage a markdown file with a setext heading whose underline is
      // 7+ `=` chars. The first character above the underline is
      // ordinary text (the heading), NOT a `<<<<<<<` or `|||||||` marker.
      await fs.writeFile(
        path.join(h.dir, 'doc.md'),
        '# Overview\nSection\n========\n\nBody text.\n',
      );
      await wm.commitAll(h, 'add doc with setext heading');

      // Drive the post-merge path: a successful squash merge of a
      // clean worktree must land on base. If `hasConflictMarkers` were
      // false-positive on the setext underline, it would treat the
      // resolution as still conflicted and abort to needs-review.
      const m = await wm.merge(h, { squash: true });
      expect(m.ok).toBe(true);
      expect(m.conflict).toBeFalsy();
      expect(h.status).toBe('merged');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  // With an untracked file in the base tree (the worktrees' own `.wrongstack/`
  // unless the project ignores it) git reports an empty commit as "nothing
  // ADDED to commit but untracked files present". Only "nothing to commit"
  // was accepted, so an already-landed change failed the handle and a
  // keep-base resolution was parked needs-review.
  it('an empty squash with untracked files present still merges', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'already-landed' });
      await fs.writeFile(path.join(h.dir, 'seed.txt'), 'changed\n');
      await wm.commitAll(h, 'worker change');
      await fs.writeFile(path.join(base, 'seed.txt'), 'changed\n');
      spawnSync('git', ['-C', base, 'commit', '-q', '-am', 'same change on base'], {
        env: GIT_ENV,
      });
      await fs.writeFile(path.join(base, 'scratch.log'), 'untracked\n');

      const m = await wm.merge(h, { squash: true });
      expect(m.ok).toBe(true);
      expect(h.status).toBe('merged');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  // `git diff --name-only` without -z C-quotes non-ASCII names, so the
  // resolver was ALSO handed `"\305\237ema.ts"` as a path: unwritable on
  // Windows (merge refused), a junk file staged and committed on POSIX.
  it('hands the resolver real non-ASCII conflict paths', async () => {
    const base = await makeRepo();
    try {
      const name = 'şema.ts';
      await fs.writeFile(path.join(base, name), 'base\n');
      spawnSync('git', ['-C', base, 'add', '-A'], { env: GIT_ENV });
      spawnSync('git', ['-C', base, 'commit', '-q', '-m', 'add'], { env: GIT_ENV });
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'non-ascii' });
      await fs.writeFile(path.join(h.dir, name), 'theirs\n');
      await wm.commitAll(h, 'worker change');
      await fs.writeFile(path.join(base, name), 'ours\n');
      spawnSync('git', ['-C', base, 'commit', '-q', '-am', 'base change'], { env: GIT_ENV });

      let seen: string[] = [];
      const m = await wm.merge(h, {
        squash: true,
        resolve: async ({ conflictFiles, cwd }) => {
          seen = conflictFiles;
          for (const f of conflictFiles) await fs.writeFile(path.join(cwd, f), 'resolved\n');
          return true;
        },
      });
      expect(seen).toEqual([name]);
      expect(m.ok).toBe(true);
      expect(await fs.readFile(path.join(base, name), 'utf8')).toBe('resolved\n');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('a resolution that keeps the base side verbatim still merges', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'keep-base' });
      await fs.writeFile(path.join(h.dir, 'seed.txt'), 'theirs\n');
      await wm.commitAll(h, 'worker change');
      await fs.writeFile(path.join(base, 'seed.txt'), 'ours\n');
      spawnSync('git', ['-C', base, 'commit', '-q', '-am', 'base change'], { env: GIT_ENV });

      const m = await wm.merge(h, {
        squash: true,
        resolve: async ({ cwd }) => {
          await fs.writeFile(path.join(cwd, 'seed.txt'), 'ours\n');
          return true;
        },
      });
      expect(m.ok).toBe(true);
      expect(h.status).toBe('merged');
      expect(await fs.readFile(path.join(base, 'seed.txt'), 'utf8')).toBe('ours\n');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  // Hooks live in the common git dir, so a repo's lint-staged/husky hook runs
  // for commits inside the managed worktrees too.
  async function installPreCommitHook(base: string, body: string): Promise<void> {
    const hook = path.join(base, '.git', 'hooks', 'pre-commit');
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  it('commitAll reports a hook-refused commit as an error, not as "nothing to commit"', async () => {
    const base = await makeRepo();
    try {
      await installPreCommitHook(base, 'echo "lint failed" >&2\nexit 1');
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'hooked' });
      await fs.writeFile(path.join(h.dir, 'feature.txt'), 'work\n');

      const c = await wm.commitAll(h, 'worker change');
      expect(c.committed).toBe(false);
      expect(c.error).toContain('lint failed');
      expect(h.status).toBe('failed');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  // The Goal/SDD sequence is commitAll → merge → release(keep: !ok). A refused
  // commit made the squash an empty "success" and release force-removed the
  // checkout holding the only copy of the work.
  it('merge refuses a worktree with uncommitted work, so release keeps it', async () => {
    const base = await makeRepo();
    try {
      await installPreCommitHook(
        base,
        'git diff --cached --name-only | grep -q feature.txt && { echo "lint failed" >&2; exit 1; }\nexit 0',
      );
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'unsaved' });
      await fs.writeFile(path.join(h.dir, 'feature.txt'), 'agent work\n');
      await wm.commitAll(h, 'worker change');

      const m = await wm.merge(h, { squash: true });
      expect(m.ok).toBe(false);
      expect(m.stderr).toContain('uncommitted changes');
      await wm.release(h, { keep: !m.ok });
      expect(wm.get('p')).toBe(h);
      expect(await fs.readFile(path.join(h.dir, 'feature.txt'), 'utf8')).toBe('agent work\n');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('a hook-refused squash commit rolls base back (merge and mergeBranch)', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'refused' });
      await fs.writeFile(path.join(h.dir, 'seed.txt'), 'changed\n');
      expect((await wm.commitAll(h, 'worker change')).committed).toBe(true);
      // Installed after the worktree commit, so only the squash on base is refused.
      await installPreCommitHook(base, 'echo "hook says no" >&2\nexit 1');
      const status = () =>
        spawnSync('git', ['-C', base, 'status', '--porcelain', '--untracked-files=no'], {
          encoding: 'utf8',
        }).stdout;

      const viaBranch = await wm.mergeBranch(h.branch);
      expect(viaBranch.ok).toBe(false);
      expect(viaBranch.reason).toContain('hook says no');
      expect(status()).toBe('');

      const viaHandle = await wm.merge(h, { squash: true });
      expect(viaHandle.ok).toBe(false);
      expect(status()).toBe('');
      // Nothing left staged on base, so a retry is not blocked by "uncommitted changes".
      expect((await wm.mergeBranch(h.branch)).reason).toContain('hook says no');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('emits a timestamped lifecycle the timeline projects into working → queued → merging', async () => {
    const base = await makeRepo();
    try {
      const events = new EventBus();
      const seen: WorktreeTimelineEvent[] = [];
      for (const name of WORKTREE_EVENT_NAMES) {
        events.on(name, (p) => {
          const e = normalizeWorktreeEvent(name, p, -1);
          if (e) seen.push(e);
        });
      }
      const wm = new WorktreeManager({ projectRoot: base, events, sessionId: 'sess-1' });
      const h = await wm.allocate('p', { slugHint: 'timeline' });
      await fs.writeFile(path.join(h.dir, 'new.txt'), 'hello\n');
      await wm.commitAll(h, 'work');
      expect((await wm.merge(h, { squash: true })).ok).toBe(true);
      await wm.release(h, { keep: false });

      expect(seen.map((e) => e.kind)).toEqual([
        'allocated',
        'committed',
        'merging',
        'merged',
        'released',
      ]);
      // Stamped by the manager (never the -1 fallback), monotonic, session-tagged.
      for (const [i, e] of seen.entries()) {
        expect(e.at).toBeGreaterThan(0);
        if (i > 0) expect(e.at).toBeGreaterThanOrEqual(seen[i - 1]!.at);
        expect(e.sessionId).toBe('sess-1');
      }
      const lane = projectWorktreeTimeline(seen, { now: Date.now() }).lanes[0]!;
      expect(lane.outcome).toBe('merged');
      expect(lane.segments.map((s) => s.phase)).toEqual(['working', 'queued', 'merging']);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('a hook-refused commit emits failed with stage "commit"', async () => {
    const base = await makeRepo();
    try {
      await installPreCommitHook(base, 'exit 1');
      const events = new EventBus();
      const failed: Array<{ stage?: string | undefined }> = [];
      events.on('worktree.failed', (p) => failed.push(p));
      const wm = new WorktreeManager({ projectRoot: base, events });
      const h = await wm.allocate('p', { slugHint: 'staged-fail' });
      await fs.writeFile(path.join(h.dir, 'x.txt'), 'x\n');
      await wm.commitAll(h, 'work');
      expect(failed.map((f) => f.stage)).toEqual(['commit']);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('mergeBranch is not blocked by untracked files on base', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'untracked-base' });
      await fs.writeFile(path.join(h.dir, 'new.txt'), 'hello\n');
      await wm.commitAll(h, 'worker change');
      await fs.writeFile(path.join(base, 'scratch.log'), 'untracked\n');

      expect(await wm.mergeBranch(h.branch)).toEqual({ ok: true });
      expect(await fs.readFile(path.join(base, 'scratch.log'), 'utf8')).toBe('untracked\n');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('merge refuses an unreadable worktree status before checkout', async () => {
    const calls: string[][] = [];
    const { run } = stubRunner((args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'status' && !args.includes('--untracked-files=no')) {
        return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const h = await wm.allocate('owner', { slugHint: 'wt-status' });
    calls.length = 0;
    const merged = await wm.merge(h);
    expect(merged.ok).toBe(false);
    expect(merged.stderr).toContain('could not read worktree status');
    expect(calls.some((args) => args[0] === 'checkout')).toBe(false);
    expect(h.status).toBe('failed');
  });

  it('merge refuses an unreadable base status before checkout', async () => {
    const calls: string[][] = [];
    const { run } = stubRunner((args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'status' && args.includes('--untracked-files=no')) {
        return { code: 128, stdout: '', stderr: 'fatal: unable to read index' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const h = await wm.allocate('owner', { slugHint: 'base-status' });
    calls.length = 0;
    const merged = await wm.merge(h);
    expect(merged.ok).toBe(false);
    expect(merged.stderr).toContain('could not read working tree status');
    expect(calls.some((args) => args[0] === 'checkout')).toBe(false);
    expect(h.status).toBe('failed');
  });

  it('revertCommits refuses an unreadable status before checkout', async () => {
    const calls: string[][] = [];
    const { run } = stubRunner((args) => {
      calls.push(args);
      if (args[0] === 'status') {
        return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const reverted = await wm.revertCommits('main', ['a'.repeat(40)]);
    expect(reverted).toEqual({
      ok: false,
      reverted: 0,
      reason: 'could not read working tree status — commit or stash first',
    });
    expect(calls.some((args) => args[0] === 'checkout')).toBe(false);
    expect(calls.some((args) => args.includes('revert'))).toBe(false);
  });
});

describe('parseConflictPaths', () => {
  it('extracts conflicted files from git merge stdout', () => {
    const output = [
      'Auto-merging seed.txt',
      'CONFLICT (content): Merge conflict in seed.txt',
      'Auto-merging dir/app.ts',
      'CONFLICT (add/add): Merge conflict in dir/app.ts',
      'Squash commit -- not updating HEAD',
    ].join('\n');
    expect(parseConflictPaths(output)).toEqual(['seed.txt', 'dir/app.ts']);
  });

  it('returns [] when there are no conflict lines', () => {
    expect(parseConflictPaths('Auto-merging x\nFast-forward')).toEqual([]);
  });

  it('dedupes repeated paths and trims trailing whitespace', () => {
    const output =
      'CONFLICT (content): Merge conflict in a.txt  \nCONFLICT (content): Merge conflict in a.txt';
    expect(parseConflictPaths(output)).toEqual(['a.txt']);
  });
});

describe('assertSafePath', () => {
  it('allows paths inside the root', () => {
    expect(() =>
      assertSafePath(path.join(PROJ, '.wrongstack', 'worktrees', 'x'), PROJ),
    ).not.toThrow();
  });
  it('rejects escapes', () => {
    expect(() => assertSafePath('/etc/evil', PROJ)).toThrow(/escapes project root/);
  });
});

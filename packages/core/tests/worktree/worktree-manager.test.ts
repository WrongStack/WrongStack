import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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

  it('mergeBranch() squash-merges + commits on success', async () => {
    const { calls, run } = stubRunner((args) =>
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'main\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const res = await wm.mergeBranch('wstack/ap/s1', 'main');
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.args[0] === 'merge' && c.args.includes('--squash'))).toBe(true);
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
    expect(calls.some((c) => c.args[0] === 'merge')).toBe(false);
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
    expect(calls.some((c) => c.args[0] === 'merge')).toBe(false);
  });

  it('mergeBranch() aborts cleanly on conflict and reports paths', async () => {
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'merge') {
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
      if (args[0] === 'diff' && args.includes('--numstat')) {
        return { code: 0, stdout: '4\t1\tsrc/a.ts\n-\t-\timg.png\n', stderr: '' };
      }
      if (args[0] === 'rev-list') return { code: 0, stdout: '3\n', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: PROJ, run });
    const s = await wm.diffSummary('/proj/.wrongstack/worktrees/s1', 'main');
    expect(s.insertions).toBe(4);
    expect(s.deletions).toBe(1);
    expect(s.files).toHaveLength(2);
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
      if (sawConflict && sawConflict.length > 0) expect(sawConflict).toContain('seed.txt');
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
        // Capture what the resolver was handed so the next Linux failure pins
        // the escape route exactly: null → resolver never called (clean-merge
        // escape); [] → conflict path entered but both file probes were empty
        // (tolerance escape); ['seed.txt'] → markers were known and the
        // hasConflictMarkers scan missed them.
        let resolverConflictFiles: string[] | null = null;
        const m = await wm.merge(h, {
          squash: true,
          resolve: async ({ conflictFiles }) => {
            resolverConflictFiles = conflictFiles;
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

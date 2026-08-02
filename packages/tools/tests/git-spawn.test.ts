import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive buildArgs for every git subcommand (incl. push/pull/reset/worktree)
// WITHOUT running real git: the spawn mock captures args and returns a fake
// child. Side-effecting commands therefore never touch the real repo.
let capturedArgs: string[] = [];
const cfg: { stdout: string; code: number } = { stdout: '', code: 0 };

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (_cmd: string, args: string[]) => {
      capturedArgs = args;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        if (cfg.stdout) child.stdout.emit('data', Buffer.from(cfg.stdout));
        child.emit('close', cfg.code);
      });
      return child;
    },
  };
});

import { gitTool } from '../src/git.js';

// process.cwd() is the repo root, so findGitDir resolves a real .git without
// the mock ever executing git.
const ctx = () => ({ cwd: process.cwd(), tools: [], projectRoot: process.cwd() }) as any;
const opts = () => ({ signal: new AbortController().signal });
const run = (input: Record<string, unknown>) => gitTool.execute(input as never, ctx(), opts());

beforeEach(() => {
  capturedArgs = [];
  cfg.stdout = '';
  cfg.code = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('gitTool buildArgs (mocked spawn, real .git)', () => {
  it('builds branch args and rejects flag-injection names', async () => {
    await run({ command: 'branch', branch: 'feature-x' });
    expect(capturedArgs).toEqual(['branch', 'feature-x']);

    // WS-090: a dash-prefixed branch used to be silently DROPPED, which turned
    // `branch -D evil` into a plain `git branch` listing — the caller was told
    // nothing and got a different command than it asked for. It is now
    // rejected before spawn, so no git process runs at all.
    capturedArgs = [];
    const rejected = await run({ command: 'branch', branch: '-D evil' });
    expect(capturedArgs).toEqual([]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toMatch(/unsafe branch/);

    await run({ command: 'branch' });
    expect(capturedArgs).toEqual(['branch']);
  });

  it('builds stash / push / pull / reset args', async () => {
    await run({ command: 'stash' });
    expect(capturedArgs).toEqual(['stash', 'push']);
    await run({ command: 'push' });
    expect(capturedArgs).toEqual(['push']);
    await run({ command: 'pull' });
    expect(capturedArgs).toEqual(['pull']);
    await run({ command: 'reset', files: 'a.ts,b.ts' });
    expect(capturedArgs).toEqual(['reset', '--', 'a.ts', 'b.ts']);
  });

  it('builds fetch args with and without a branch', async () => {
    await run({ command: 'fetch' });
    expect(capturedArgs).toEqual(['fetch', '--all']);
    await run({ command: 'fetch', branch: 'origin' });
    expect(capturedArgs).toEqual(['fetch', 'origin']);
  });

  it('builds log args for each format', async () => {
    for (const [format, expected] of [
      ['oneline', '--oneline'],
      ['stat', '--stat'],
      ['graph', '--graph'],
    ] as const) {
      await run({ command: 'log', format, limit: 3 });
      expect(capturedArgs).toContain(expected);
    }
  });

  it('builds worktree list / prune / remove args', async () => {
    await run({ command: 'worktree', worktreeAction: 'list' });
    expect(capturedArgs).toEqual(['worktree', 'list']);
    await run({ command: 'worktree', worktreeAction: 'prune' });
    expect(capturedArgs).toEqual(['worktree', 'prune']);
    await run({
      command: 'worktree',
      worktreeAction: 'remove',
      worktreePath: 'wt',
      force: true,
    });
    expect(capturedArgs).toEqual(['worktree', 'remove', '--force', 'wt']);
  });

  it('builds worktree add with new branch (path before -b branch)', async () => {
    await run({
      command: 'worktree',
      worktreeAction: 'add',
      worktreePath: 'wt',
      branch: 'feat',
      newBranch: true,
    });
    expect(capturedArgs).toEqual(['worktree', 'add', '-b', 'feat', 'wt']);
  });

  it('builds worktree add checking out an existing branch (path then branch)', async () => {
    await run({
      command: 'worktree',
      worktreeAction: 'add',
      worktreePath: 'wt',
      branch: 'main',
    });
    expect(capturedArgs).toEqual(['worktree', 'add', 'wt', 'main']);
  });

  it('falls back to worktree list when add has no path / action is unknown', async () => {
    await run({ command: 'worktree', worktreeAction: 'add' }); // no worktreePath
    expect(capturedArgs).toEqual(['worktree', 'list']);
    await run({ command: 'worktree' }); // no worktreeAction → default
    expect(capturedArgs).toEqual(['worktree', 'list']);
  });

  it('builds diff args with a files filter', async () => {
    await run({ command: 'diff', files: 'x.ts' });
    expect(capturedArgs).toEqual(['diff', '--no-color', '--', 'x.ts']);
  });

  it('falls back to the raw command for an unknown subcommand', async () => {
    await run({ command: 'gc' });
    expect(capturedArgs).toEqual(['gc']);
  });

  it('captures the staged diff before a non-dry-run commit', async () => {
    cfg.stdout = 'diff --git a/x b/x\n+change';
    const result = await run({ command: 'commit', message: 'msg' });
    expect(result.diff).toContain('change');
  });

  it('truncates a very large staged diff', async () => {
    cfg.stdout = 'x'.repeat(25_000); // > MAX_DIFF (20_000)
    const result = await run({ command: 'commit', message: 'big' });
    expect(result.diff).toMatch(/diff truncated/);
  });

  it('surfaces the child exit code from runGit', async () => {
    cfg.code = 3;
    const result = await run({ command: 'status' });
    expect(result.exitCode).toBe(3);
  });
});

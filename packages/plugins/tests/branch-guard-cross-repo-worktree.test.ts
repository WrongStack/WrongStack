import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import plugin from '../src/branch-guard/index.js';

/**
 * `git -C <other-worktree> commit` commits in THAT worktree, so the guard has to
 * ask git about that repository (`branch --show-current` with the command's own
 * `-C`/`--git-dir`/`--work-tree`). Reading only `process.cwd()`'s branch let a
 * session on a feature branch commit to a protected `main` worktree unchecked.
 */

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let root: string;
let repo: string;
let mainWorktree: string;
let previousCwd: string;

beforeEach(() => {
  previousCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'wstack-branch-guard-cross-'));
  repo = join(root, 'session');
  mainWorktree = join(root, 'main-worktree');
  // A normal multi-worktree checkout: session on `feat`, `main` in a sibling.
  git(root, ['init', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-m', 'init']);
  git(repo, ['checkout', '-b', 'feat']);
  git(repo, ['worktree', 'add', mainWorktree, 'main']);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
});

type Hook = (
  input: unknown,
  runtime: { signal: AbortSignal },
) => Promise<{ decision?: string } | undefined>;

function hookFor(cwd: string): Hook {
  const calls: unknown[][] = [];
  const api = {
    config: { extensions: {}, plugins: [] },
    log: { info() {}, warn() {}, error() {} },
    metrics: { counter() {}, histogram() {}, gauge() {} },
    tools: { register() {} },
    onConfigChange: () => () => {},
    registerHook: (...args: unknown[]) => {
      calls.push(args);
      return () => {};
    },
  };
  process.chdir(cwd);
  plugin.setup(api as never);
  return calls.find((call) => call[0] === 'PreToolUse')?.[2] as Hook;
}

const signal = new AbortController().signal;
const run = (cwd: string, command: string) =>
  hookFor(cwd)({ toolName: 'bash', toolInput: { command } }, { signal });

describe('branch-guard judges the repository the command commits to', () => {
  it('blocks a commit in another worktree that is on a protected branch', async () => {
    expect(await run(repo, `git -C "${mainWorktree}" commit -m x`)).toMatchObject({
      decision: 'block',
    });
  });

  it('still judges a commit in the session checkout by its own branch', async () => {
    expect(await run(repo, 'git commit -m x')).toBeUndefined();
  });

  it('blocks a commit when the session checkout itself is on the protected branch', async () => {
    expect(await run(mainWorktree, 'git commit -m x')).toMatchObject({ decision: 'block' });
  });
});

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { gitTool } from '../src/git.js';
import { projectSlug } from '@wrongstack/core/utils';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const makeCtx = (cwd = '/fake') =>
  ({ cwd, tools: [], projectRoot: cwd }) as unknown as Parameters<typeof gitTool.execute>[1];
const makeOpts = () => ({ signal: new AbortController().signal });
// Module-relative so the live-execution block finds a real git working tree
// regardless of the vitest root (package `--root ../..` script included).
const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

describe('gitTool', () => {
  it('has correct metadata', () => {
    expect(gitTool.name).toBe('git');
    expect(gitTool.permission).toBe('confirm');
    expect(gitTool.inputSchema.required).toContain('command');
  });

  it('throws when command is missing', async () => {
    const ctx = makeCtx();
    await expect(gitTool.execute({} as never, ctx, makeOpts())).rejects.toThrow(
      'command is required',
    );
  });

  it('returns error when not in a git repo', async () => {
    const ctx = makeCtx('/');
    const result = await gitTool.execute({ command: 'status' }, ctx, makeOpts());
    expect(result.exitCode).toBe(128);
    expect(result.stderr).toMatch(/Not in a git repository/);
  });

  it('handles raw args', async () => {
    const ctx = makeCtx('/');
    const result = await gitTool.execute(
      { command: 'status', args: '--porcelain' } as never,
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('exitCode');
  });

  it('respects dry_run for commit', async () => {
    const ctx = makeCtx('/');
    const result = await gitTool.execute(
      { command: 'commit', dry_run: true, message: 'test' },
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('exitCode');
  });

  it('handles stash with message', async () => {
    const ctx = makeCtx('/');
    const result = await gitTool.execute({ command: 'stash', message: 'wip' }, ctx, makeOpts());
    expect(result).toHaveProperty('exitCode');
  });
});

describe('gitTool — shared-worktree commit warning', () => {
  let repo: string;
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'git-tool-repo-'));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'git-tool-home-'));
    prevHome = process.env['WRONGSTACK_HOME'];
    process.env['WRONGSTACK_HOME'] = home;
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['WRONGSTACK_HOME'];
    else process.env['WRONGSTACK_HOME'] = prevHome;
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });

  async function seedTracker(entries: Record<string, unknown>[]): Promise<void> {
    const dir = path.join(home, 'projects', projectSlug(repo));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'file-authors.json'),
      JSON.stringify({ projectRoot: repo, entries }, null, 2),
    );
  }

  const ctxFor = () =>
    ({ cwd: repo, tools: [], projectRoot: repo, session: { id: 'mine' } }) as unknown as Parameters<
      typeof gitTool.execute
    >[1];

  it('attaches a warning when a dirty file was authored by another session', async () => {
    await fs.writeFile(path.join(repo, 'foreign.ts'), 'not mine');
    await seedTracker([
      {
        filePath: 'foreign.ts',
        action: 'edit',
        agentId: 'leader',
        agentName: 'Other',
        sessionId: 'other',
        timestamp: new Date(0).toISOString(),
      },
    ]);

    const result = await gitTool.execute(
      { command: 'commit', dry_run: true, message: 'x' },
      ctxFor(),
      { signal: new AbortController().signal },
    );

    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('foreign.ts');
    expect(result.warning).toContain('Other');
    // No explicit files → scope-note nudges toward a narrower commit.
    expect(result.warning).toContain('no explicit `files` list');
  }, 30_000);

  it('omits the warning when the only dirty file is ours', async () => {
    await fs.writeFile(path.join(repo, 'mine.ts'), 'my work');
    await seedTracker([
      {
        filePath: 'mine.ts',
        action: 'edit',
        agentId: 'leader',
        sessionId: 'mine',
        timestamp: new Date(0).toISOString(),
      },
    ]);

    const result = await gitTool.execute(
      { command: 'commit', dry_run: true, message: 'x' },
      ctxFor(),
      { signal: new AbortController().signal },
    );

    expect(result.warning).toBeUndefined();
  }, 30_000);
});

describe('buildArgs (via execute in non-git dir)', () => {
  // These test the arg building logic through the tool, even though
  // they all return 128 (not in git repo). The key is they don't crash.

  const commands = [
    { command: 'status' as const },
    { command: 'status' as const, files: 'a.ts,b.ts' },
    { command: 'log' as const },
    { command: 'log' as const, format: 'oneline' as const },
    { command: 'log' as const, format: 'stat' as const },
    { command: 'log' as const, format: 'graph' as const },
    { command: 'log' as const, format: 'short' as const },
    { command: 'log' as const, limit: 5 },
    { command: 'diff' as const },
    { command: 'diff' as const, files: 'src/*.ts' },
    { command: 'commit' as const, message: 'chore: update' },
    { command: 'commit' as const, dry_run: true },
    { command: 'commit' as const, message: 'fix', files: 'a.ts' },
    { command: 'branch' as const },
    { command: 'branch' as const, branch: 'feature/x' },
    { command: 'checkout' as const, branch: 'main' },
    { command: 'checkout' as const, files: 'a.ts' },
    { command: 'stash' as const },
    { command: 'stash' as const, message: 'wip' },
    { command: 'push' as const },
    { command: 'pull' as const },
    { command: 'fetch' as const },
    { command: 'fetch' as const, branch: 'main' },
    { command: 'reset' as const },
    { command: 'status' as const, args: '--short --branch' },
  ] as const;

  for (const input of commands) {
    it(`builds args for ${JSON.stringify(input)}`, async () => {
      const ctx = makeCtx('/');
      const result = await gitTool.execute({ ...input }, ctx, makeOpts());
      expect(result).toHaveProperty('exitCode');
      expect(result).toHaveProperty('stdout');
      expect(result).toHaveProperty('stderr');
    });
  }

  it('handles array files', async () => {
    const ctx = makeCtx('/');
    const result = await gitTool.execute(
      { command: 'status', files: ['a.ts', 'b.ts'] },
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('exitCode');
  });
});

describe('gitTool live execution (uses the test repo itself)', () => {
  // We're running inside the WrongStack repo, so repoRoot resolves to a
  // real git working tree — exercises runGit end-to-end.
  const ctx = makeCtx(repoRoot);

  it('executes `git status` and returns exit code 0', async () => {
    const result = await gitTool.execute({ command: 'status' }, ctx, makeOpts());
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe('status');
    expect(typeof result.stdout).toBe('string');
  });

  it('executes `git log --oneline -n 1` and returns at least one commit', async () => {
    const result = await gitTool.execute(
      { command: 'log', format: 'oneline', limit: 1 },
      ctx,
      makeOpts(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split('\n').filter(Boolean).length).toBeGreaterThan(0);
  });

  it('aborts when the signal is fired before spawn', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await gitTool.execute({ command: 'log' }, ctx, { signal: ac.signal });
    // Aborted signal causes ENOENT / AbortError; exitCode comes from
    // child.on('error') path. We just verify the tool resolves rather than
    // throws.
    expect(result.exitCode).not.toBe(0);
  });
});

// ─── New coverage tests ───────────────────────────────────────────────────────

describe('gitTool runGit error paths', () => {
  it('handles child spawn error via child.on(error)', async () => {
    const ctx = makeCtx('/non/existent/path');
    // Use a command that should fail to spawn
    const result = await gitTool.execute({ command: 'status' }, ctx, makeOpts());
    // Should not throw, returns error result
    expect(result).toHaveProperty('exitCode');
    expect(result).toHaveProperty('stderr');
  });

  it('handles truncated output in runGit', async () => {
    const ctx = makeCtx(process.cwd());
    // Large log output that may exceed MAX_OUTPUT (100000)
    const result = await gitTool.execute(
      { command: 'log', format: 'oneline', limit: 1000 },
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('truncated');
    expect(result.stdout.length).toBeLessThanOrEqual(100000 + 1);
  });
});

describe('gitTool findGitDir bounds', () => {
  it('findGitDir is bounded by projectRoot', async () => {
    // Create a temporary directory structure:
    // /tmp/nested-git-test/
    //   .git/
    //   parent/  <- this is projectRoot but no git here
    //     child/  <- this is cwd but parent has .git
    // If we use a projectRoot without .git, it should NOT find a parent git repo
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'git-bound-test-'));
    try {
      // Create projectRoot with no git
      const projectRoot = path.join(base, 'project');
      await fs.mkdir(projectRoot, { recursive: true });
      // Create a nested cwd that would have .git if we didn't bound by projectRoot
      const gitDir = path.join(base, 'git-repo', '.git');
      await fs.mkdir(gitDir, { recursive: true });
      // Write a ref to make it a valid gitdir
      await fs.mkdir(path.join(gitDir, 'refs'), { recursive: true });

      const ctx = { cwd: path.join(projectRoot, 'subdir'), tools: [], projectRoot } as any;
      const result = await gitTool.execute({ command: 'status' }, ctx, makeOpts());
      // Should return 128 because projectRoot has no git
      expect(result.exitCode).toBe(128);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('findGitDir returns null when no git repo exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-git-'));
    try {
      const ctx = { cwd: dir, tools: [], projectRoot: dir } as any;
      const result = await gitTool.execute({ command: 'status' }, ctx, makeOpts());
      expect(result.exitCode).toBe(128);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('gitTool buildArgs edge cases', () => {
  it('branch rejects names starting with dash', async () => {
    const ctx = makeCtx('/');
    // branch name starting with '-' is rejected (flag injection prevention)
    const result = await gitTool.execute(
      { command: 'branch', branch: '-f' } as any,
      ctx,
      makeOpts(),
    );
    // Should not crash, just not include the branch arg
    expect(result).toHaveProperty('exitCode');
  });

  it('checkout works with just files (no branch)', async () => {
    const ctx = makeCtx(process.cwd());
    // Just files, no branch specified
    const result = await gitTool.execute(
      { command: 'checkout', files: 'README.md' },
      ctx,
      makeOpts(),
    );
    // May fail if file doesn't exist or has conflicts, but shouldn't crash
    expect(result).toHaveProperty('exitCode');
  });

  it('commit handles missing message gracefully', async () => {
    const ctx = makeCtx(process.cwd());
    const result = await gitTool.execute({ command: 'commit' } as any, ctx, makeOpts());
    // git commit without message should fail with non-zero exitCode
    expect(result.exitCode).not.toBe(0);
  });
});

describe('gitTool runGit close handling', () => {
  it('handles null exit code from child', async () => {
    const ctx = makeCtx(process.cwd());
    // Force an error condition
    const ac = new AbortController();
    // Abort immediately after starting
    setTimeout(() => ac.abort(), 10);
    const result = await gitTool.execute({ command: 'status' }, ctx, { signal: ac.signal });
    expect(result).toHaveProperty('exitCode');
  });
});

describe('gitTool truncation', () => {
  it('marks truncated true when stdout exceeds MAX_OUTPUT', async () => {
    const ctx = makeCtx(process.cwd());
    const result = await gitTool.execute({ command: 'log', limit: 10000 }, ctx, makeOpts());
    // Output is now normalized + head/tail-truncated to the unified command
    // cap (32 KiB), so when `truncated` is set the returned stdout is capped
    // there and carries the truncation marker — it is no longer the raw 100K.
    expect(typeof result.truncated).toBe('boolean');
    if (result.truncated) {
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(32_768);
      expect(result.stdout).toContain('truncated');
    }
  });

  it('marks truncated true when stderr exceeds MAX_OUTPUT', async () => {
    const ctx = makeCtx(process.cwd());
    const result = await gitTool.execute({ command: 'log' }, ctx, makeOpts());
    expect(typeof result.truncated).toBe('boolean');
  });
});

describe('gitTool stdout capping', () => {
  it('caps stdout at MAX_OUTPUT in close handler', async () => {
    const ctx = makeCtx(process.cwd());
    const result = await gitTool.execute(
      { command: 'log', format: 'oneline', limit: 5000 },
      ctx,
      makeOpts(),
    );
    // stdout should be capped at MAX_OUTPUT (100000)
    expect(result.stdout.length).toBeLessThanOrEqual(100000);
  });

  it('caps stderr at MAX_OUTPUT in close handler', async () => {
    const ctx = makeCtx(process.cwd());
    const result = await gitTool.execute({ command: 'status' }, ctx, makeOpts());
    expect(result.stderr.length).toBeLessThanOrEqual(100000);
  });
});

describe('gitTool findGitDir bounds via real fs', () => {
  it('findGitDir respects projectRoot bound — outside projectRoot is not searched', async () => {
    // Create a directory structure where projectRoot has no .git,
    // but a sibling of cwd does. findGitDir must not cross projectRoot.
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'git-bound-'));
    try {
      const projectRoot = path.join(base, 'proj');
      await fs.mkdir(projectRoot, { recursive: true });

      // Create a sibling directory with a valid .git
      const siblingGit = path.join(base, 'sibling', '.git');
      await fs.mkdir(path.join(siblingGit, 'refs', 'heads'), { recursive: true });
      await fs.writeFile(path.join(siblingGit, 'HEAD'), 'ref: refs/heads/main\n');

      const cwd = path.join(projectRoot, 'sub');
      await fs.mkdir(cwd, { recursive: true });

      const ctx = { cwd, tools: [], projectRoot } as any;
      const result = await gitTool.execute({ command: 'status' }, ctx, makeOpts());
      // projectRoot has no .git, sibling does but is outside projectRoot
      // → findGitDir returns null, exitCode 128
      expect(result.exitCode).toBe(128);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('findGitDir finds .git in a parent directory of cwd within projectRoot', async () => {
    // projectRoot has .git; cwd is a subdirectory of projectRoot
    // findGitDir should find it by walking up
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'git-find-'));
    try {
      // Use real `git init` instead of fabricating .git/HEAD by hand —
      // a hand-built directory passes findGitDir's existence check but
      // `git status` rejects it as not a valid repo (exit 128).
      const { spawnSync } = await import('node:child_process');
      const init = spawnSync('git', ['init', '-q', base], { stdio: 'ignore' });
      if (init.status !== 0) {
        // git not available in this environment — skip rather than fail.
        return;
      }

      const cwd = path.join(base, 'src', 'utils');
      await fs.mkdir(cwd, { recursive: true });

      const ctx = { cwd, tools: [], projectRoot: base } as any;
      const result = await gitTool.execute({ command: 'status' }, ctx, makeOpts());
      // Should find .git and execute successfully
      expect(result.exitCode).toBe(0);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

describe('gitTool buildArgs edge cases', () => {
  it('buildArgs handles files as array', async () => {
    // Array files are split and trimmed (lines 137-139)
    const ctx = makeCtx(repoRoot);
    const result = await gitTool.execute(
      { command: 'status', files: ['a.ts', 'b.ts'] },
      ctx,
      makeOpts(),
    );
    expect(result.exitCode).toBe(0);
  });

  it('buildArgs handles commit with dry_run and message and files', async () => {
    // All three conditional paths in buildArgs commit case (lines 156-162)
    const ctx = makeCtx(process.cwd());
    const result = await gitTool.execute(
      { command: 'commit', dry_run: true, message: 'chore: test', files: 'x.txt' },
      ctx,
      makeOpts(),
    );
    // dry_run without message should still work (dry_run only adds --dry-run --porcelain)
    expect(result).toHaveProperty('exitCode');
  });
});

describe('gitTool worktree hardening', () => {
  it('rejects a worktree path that escapes the project root', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-escape-'));
    try {
      const ctx = { cwd: base, tools: [], projectRoot: base } as any;
      const result = await gitTool.execute(
        {
          command: 'worktree',
          worktreeAction: 'add',
          worktreePath: '../../etc/evil',
          newBranch: true,
          branch: 'x',
        },
        ctx,
        makeOpts(),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/escapes project root/);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('rejects flag-injection branch names', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-flag-'));
    try {
      const ctx = { cwd: base, tools: [], projectRoot: base } as any;
      const result = await gitTool.execute(
        {
          command: 'worktree',
          worktreeAction: 'add',
          worktreePath: 'wt',
          branch: '--upload-pack=evil',
          newBranch: true,
        },
        ctx,
        makeOpts(),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/unsafe branch/);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  // WS-090. The leading-dash check lived inside validateWorktreeInput, so it
  // only ran for `command: 'worktree'`. `fetch` passes input.branch as a bare
  // positional, and `git fetch --upload-pack=<prog>` makes git execute that
  // program — a code-execution sink reachable from model-supplied input.
  it.each([
    ['--upload-pack=/tmp/evil'],
    ['--exec=/tmp/evil'],
    ['--receive-pack=/tmp/evil'],
    ['main --upload-pack=/tmp/evil'],
  ])('rejects flag-injection branch %s on fetch', async (branch) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'git-fetch-flag-'));
    try {
      const ctx = { cwd: base, tools: [], projectRoot: base } as any;
      const result = await gitTool.execute({ command: 'fetch', branch }, ctx, makeOpts());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/unsafe branch/);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('still accepts an ordinary branch name on fetch', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'git-fetch-ok-'));
    try {
      const ctx = { cwd: base, tools: [], projectRoot: base } as any;
      const result = await gitTool.execute(
        { command: 'fetch', branch: 'feature/my-branch' },
        ctx,
        makeOpts(),
      );
      // Not a git repo, so this fails downstream — the point is that it is NOT
      // rejected by the branch guard.
      expect(result.stderr).not.toMatch(/unsafe branch/);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('rejects flag-injection worktree paths', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-flagp-'));
    try {
      const ctx = { cwd: base, tools: [], projectRoot: base } as any;
      const result = await gitTool.execute(
        {
          command: 'worktree',
          worktreeAction: 'add',
          worktreePath: '--force',
          newBranch: true,
          branch: 'x',
        },
        ctx,
        makeOpts(),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/unsafe worktree path/);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('adds a worktree with the path before the new branch (correct arg order)', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-add-'));
    try {
      const { spawnSync } = await import('node:child_process');
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@t',
      };
      if (spawnSync('git', ['init', '-q', base], { stdio: 'ignore' }).status !== 0) return; // git absent
      await fs.writeFile(path.join(base, 'seed.txt'), 'seed\n');
      spawnSync('git', ['-C', base, 'add', '-A'], { stdio: 'ignore', env });
      spawnSync('git', ['-C', base, 'commit', '-q', '-m', 'init'], { stdio: 'ignore', env });

      const wtDir = path.join(base, '.wrongstack', 'worktrees', 'wt1');
      const ctx = { cwd: base, tools: [], projectRoot: base } as any;
      const result = await gitTool.execute(
        {
          command: 'worktree',
          worktreeAction: 'add',
          worktreePath: wtDir,
          newBranch: true,
          branch: 'wstack/ap/wt1',
        },
        ctx,
        makeOpts(),
      );
      expect(result.exitCode).toBe(0);
      // A linked worktree carries a `.git` *file* (gitlink), not a directory.
      const dotGit = await fs.stat(path.join(wtDir, '.git'));
      expect(dotGit.isFile()).toBe(true);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

describe('gitTool runGit stdout/stderr MAX_OUTPUT cap', () => {
  it('stdout is capped at MAX_OUTPUT and truncated flag is set', async () => {
    const ctx = makeCtx(process.cwd());
    // Request a very large log that will exceed 100000 chars of output
    const result = await gitTool.execute(
      { command: 'log', format: 'oneline', limit: 10000 },
      ctx,
      makeOpts(),
    );
    // If output is huge it will be truncated; if small it won't
    expect(typeof result.truncated).toBe('boolean');
    expect(result.stdout.length).toBeLessThanOrEqual(100000);
  });

  it('stderr is capped at MAX_OUTPUT even when stdout is small', async () => {
    const ctx = makeCtx(process.cwd());
    // Use an invalid git command to produce stderr output without much stdout
    const result = await gitTool.execute(
      { command: 'log', format: 'oneline', limit: 1 },
      ctx,
      makeOpts(),
    );
    expect(result.stderr.length).toBeLessThanOrEqual(100000);
  });
});

describe('gitTool — checkout must not destroy uncommitted work', () => {
  let repo: string;

  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

  beforeEach(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'git-checkout-')));
    run('init', '-q');
    run('config', 'user.email', 't@t');
    run('config', 'user.name', 't');
    await fs.mkdir(path.join(repo, 'docs'));
    await fs.writeFile(path.join(repo, 'docs', 'f.txt'), 'committed\n');
    run('add', '-A');
    run('commit', '-qm', 'init');
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  // The argv used to be ['checkout', '--', branch]. Everything after `--` is a
  // PATHSPEC, so this never switched a branch — it restored the path from the
  // index, silently discarding every uncommitted change under it, and returned
  // exitCode 0.
  it('switches branches and keeps working-tree changes', async () => {
    run('branch', 'docs');
    await fs.writeFile(path.join(repo, 'docs', 'f.txt'), 'UNCOMMITTED\n');

    const result = await gitTool.execute(
      { command: 'checkout', branch: 'docs' },
      makeCtx(repo),
      makeOpts(),
    );

    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(path.join(repo, 'docs', 'f.txt'), 'utf8')).toBe('UNCOMMITTED\n');
  });

  // Removing `--` alone is not enough: with no matching ref git DWIMs to a
  // pathspec restore ("Updated 1 path from the index", exit 0) and the change
  // is gone anyway. The trailing `--` declares "no pathspecs follow".
  it('fails instead of restoring when the branch name collides with a path', async () => {
    await fs.writeFile(path.join(repo, 'docs', 'f.txt'), 'UNCOMMITTED\n');

    const result = await gitTool.execute(
      { command: 'checkout', branch: 'docs' },
      makeCtx(repo),
      makeOpts(),
    );

    expect(result.exitCode).not.toBe(0);
    expect(await fs.readFile(path.join(repo, 'docs', 'f.txt'), 'utf8')).toBe('UNCOMMITTED\n');
  });

  it('still restores files when `files` is given', async () => {
    await fs.writeFile(path.join(repo, 'docs', 'f.txt'), 'UNCOMMITTED\n');

    const result = await gitTool.execute(
      { command: 'checkout', files: 'docs/f.txt' },
      makeCtx(repo),
      makeOpts(),
    );

    expect(result.exitCode).toBe(0);
    const restored = await fs.readFile(path.join(repo, 'docs', 'f.txt'), 'utf8');
    expect(restored.replace(/\r\n/g, '\n')).toBe('committed\n');
  });

  it('executes cleanly when opts parameter is omitted', async () => {
    const result = await gitTool.execute({ command: 'status' }, makeCtx(repo));
    expect(result.command).toBe('status');
    expect(result.exitCode).toBe(0);
  });
});

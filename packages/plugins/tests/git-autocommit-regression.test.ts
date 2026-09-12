/**
 * git-autocommit regression tests — one per fixed finding (F1–F4).
 *
 * These pin the behaviours that were broken before the 2026-09 audit:
 *  F1  C-quoted `git diff --name-only` output must be decoded before it is
 *      used as a commit pathspec / scope-warning key.
 *  F2  the `files` flow must fence its commit to the paths git actually
 *      staged, so a stale/typo path does not abort a valid commit.
 *  F3  a tracked file deleted from the worktree must still be stageable
 *      (existence filter must not drop deletions).
 *  F4  the FIRST `git status --porcelain` line, whose leading space
 *      `runGit`'s `stdout.trim()` eats, must still classify as unstaged.
 *
 * The suite drives the real tool through the same mocked-child_process
 * harness as git-autocommit-exec.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => ({ execFileSync: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', async (o) => ({ ...(await o()), execFile: cp.execFile }));
const fsm = vi.hoisted(() => ({ existsSync: vi.fn() }));
vi.mock('node:fs', async (o) => ({ ...(await o()), existsSync: fsm.existsSync }));

import gitAutocommitPlugin from '../src/git-autocommit/index.js';

interface Tool {
  name: string;
  execute: (input: Record<string, unknown>, ctx?: unknown) => Promise<Record<string, unknown>>;
}

let gitHandler: (args: string[]) => string;
let sessionAppend: ReturnType<typeof vi.fn>;

function setup(): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  sessionAppend = vi.fn(async () => {});
  const api = {
    tools: {
      register: (t: Tool) => {
        tools[t.name] = t;
      },
    },
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    session: { append: sessionAppend },
  };
  gitAutocommitPlugin.setup(api as never);
  return tools;
}

beforeEach(() => {
  cp.execFileSync.mockReset();
  fsm.existsSync.mockReset();
  fsm.existsSync.mockReturnValue(true);
  gitHandler = () => '';
  cp.execFileSync.mockImplementation((_bin: string, args: string[]) => gitHandler(args));
  cp.execFile.mockImplementation(
    (
      bin: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      try {
        callback(null, String(cp.execFileSync(bin, args, options) ?? ''), '');
      } catch (error) {
        const e = error as Error & { stdout?: string; stderr?: string };
        callback(e, e.stdout ?? '', e.stderr ?? '');
      }
      return {};
    },
  );
});

const key = (args: string[]) => args.join(' ');

describe('git-autocommit regressions', () => {
  it('F1: decodes a C-quoted path from the pathspec flow and commits the real name', async () => {
    const commits: string[][] = [];
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'add -- caf\u00e9.txt') return '';
      if (k === 'diff --cached --name-only -- caf\u00e9.txt') return '"caf\\303\\251.txt"';
      if (k === 'diff --cached --name-only') return '"caf\\303\\251.txt"';
      if (k === 'diff --cached --stat -- caf\u00e9.txt') return 'stat';
      if (k === 'diff --cached -- caf\u00e9.txt') return '+x';
      if (k === 'diff --name-only -- caf\u00e9.txt') return '';
      if (k.startsWith('commit -m')) {
        commits.push(args.slice());
        return 'h ok';
      }
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'chore',
      message: 'unicode',
      paths: ['caf\u00e9.txt'],
    });
    expect(res.ok).toBe(true);
    // The quoted/escaped literal must never reach the commit argv.
    expect(commits[0]).toEqual(['commit', '-m', 'chore: unicode', '--only', '--', 'caf\u00e9.txt']);
    expect(res.stagedFiles).toEqual(['caf\u00e9.txt']);
    // And it must not be mistaken for a foreign staged file.
    expect(res.warning).toBeUndefined();
  });

  it('F1: a quoted staged file does not trigger a false scope-guard warning', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'add -- caf\u00e9.txt') return '';
      if (k === 'diff --cached --name-only') return '"caf\\303\\251.txt"';
      if (k === 'diff --cached --stat -- caf\u00e9.txt') return 'stat';
      if (k === 'diff --cached -- caf\u00e9.txt') return '+x';
      if (k === 'diff --name-only -- caf\u00e9.txt') return '';
      if (k.startsWith('commit -m')) return 'h ok';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'chore',
      message: 'unicode',
      files: ['caf\u00e9.txt'],
    });
    expect(res.ok).toBe(true);
    expect(res.warning).toBeUndefined();
  });

  it('F2: a non-existent path in `files` does not abort committing a real path', async () => {
    fsm.existsSync.mockImplementation((p) => String(p) === 'a.ts');
    const commits: string[][] = [];
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'ls-files -- a.ts ghost.ts') return 'a.ts';
      if (k === 'add -- a.ts') return '';
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k === 'diff --cached --stat -- a.ts') return 'stat';
      if (k === 'diff --cached -- a.ts') return '+x';
      if (k === 'diff --name-only -- a.ts') return '';
      if (k.startsWith('commit -m')) {
        commits.push(args.slice());
        return 'h ok';
      }
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'fix',
      message: 'x',
      files: ['a.ts', 'ghost.ts'],
    });
    expect(res.ok).toBe(true);
    expect(commits[0]).toEqual(['commit', '-m', 'fix: x', '--only', '--', 'a.ts']);
  });

  it('F3: a tracked deletion is staged and committed via `git ls-files`', async () => {
    fsm.existsSync.mockImplementation((p) => String(p) !== 'gone.ts');
    const commits: string[][] = [];
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'ls-files -- gone.ts') return 'gone.ts';
      if (k === 'add -- gone.ts') return '';
      if (k === 'diff --cached --name-only') return 'gone.ts';
      if (k === 'diff --cached --stat -- gone.ts') return 'stat';
      if (k === 'diff --cached -- gone.ts') return '-x';
      if (k === 'diff --name-only -- gone.ts') return '';
      if (k.startsWith('commit -m')) {
        commits.push(args.slice());
        return 'h ok';
      }
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'fix',
      message: 'rm',
      files: ['gone.ts'],
    });
    expect(res.ok).toBe(true);
    expect(commits[0]).toEqual(['commit', '-m', 'fix: rm', '--only', '--', 'gone.ts']);
  });

  it('F3: a genuinely untracked/nonexistent path still fails loudly', async () => {
    fsm.existsSync.mockReturnValue(false);
    gitHandler = () => ''; // `git ls-files` finds nothing
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'fix',
      message: 'x',
      files: ['never-existed.ts'],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/none of the specified files exist/);
  });

  it('F4: the trimmed first status line is reported as an external change', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'add -- zzz.ts') return '';
      if (k === 'diff --cached --name-only') return 'zzz.ts';
      if (k === 'diff --cached --stat -- zzz.ts') return 'stat';
      if (k === 'diff --cached -- zzz.ts') return '+x';
      if (k === 'diff --name-only -- zzz.ts') return '';
      // `runGit` trims stdout: a leading ` M aaa.ts` arrives as `M aaa.ts`.
      if (k === 'status --porcelain') return 'M aaa.ts\nM  zzz.ts';
      if (k.startsWith('commit -m')) return 'h ok';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'fix',
      message: 'x',
      files: ['zzz.ts'],
    });
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/External changes/);
    expect(res.warning).toMatch(/aaa\.ts/);
  });

  it('F4: a fully staged file is not misreported as an external change', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'add -- zzz.ts') return '';
      if (k === 'diff --cached --name-only') return 'zzz.ts';
      if (k === 'diff --cached --stat -- zzz.ts') return 'stat';
      if (k === 'diff --cached -- zzz.ts') return '+x';
      if (k === 'diff --name-only -- zzz.ts') return '';
      if (k === 'status --porcelain') return 'M  zzz.ts';
      if (k.startsWith('commit -m')) return 'h ok';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'fix',
      message: 'x',
      files: ['zzz.ts'],
    });
    expect(res.ok).toBe(true);
    expect(res.warning).toBeUndefined();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => ({ execFileSync: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', async (o) => ({ ...(await o()), execFile: cp.execFile }));
const fsm = vi.hoisted(() => ({ existsSync: vi.fn() }));
vi.mock('node:fs', async (o) => ({ ...(await o()), existsSync: fsm.existsSync }));

import gitAutocommitPlugin from '../src/git-autocommit';

interface Tool {
  name: string;
  execute: (input: Record<string, unknown>, ctx?: unknown) => Promise<Record<string, unknown>>;
}

let gitHandler: (args: string[]) => string;
let sessionAppend: ReturnType<typeof vi.fn>;

function setup(
  extensions: Record<string, unknown> = {},
  llm?: { complete: ReturnType<typeof vi.fn> },
): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  sessionAppend = vi.fn(async () => {});
  const api = {
    tools: {
      register: (t: Tool) => {
        tools[t.name] = t;
      },
    },
    config: { extensions },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    session: { append: sessionAppend },
    llm,
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

describe('git_autocommit', () => {
  it('dry-runs with an invalid type using a fallback message', async () => {
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'bogus', dry_run: true });
    expect(res).toMatchObject({ ok: true, dry_run: true });
    expect(res.message).toMatch(/Would create/);
  });

  it('rejects an invalid type on a real (non-dry) run', async () => {
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'bogus' });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/valid conventional commit type/);
  });

  it('rejects non-array files', async () => {
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', files: 'a.ts' });
    expect(res.error).toMatch(/files must be an array/);
  });

  it('stages provided files, commits with a hook-friendly timeout, and appends to the session', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k.startsWith('commit -m')) return 'deadbeef committed';
      if (k === 'diff --cached --stat') return ' a.ts | 1 +';
      if (k === 'diff --cached') return '+added line';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'feat',
      scope: 'core',
      message: 'add thing',
      body: 'details',
      files: ['a.ts'],
    });
    expect(res.ok).toBe(true);
    expect(res.hash).toBe('deadbeef committed');
    expect(res.message).toBe('feat(core): add thing\n\ndetails');
    expect(res.stagedFiles).toEqual(['a.ts']);
    expect(cp.execFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['commit', '-m']),
      expect.objectContaining({ timeout: 300_000 }),
    );
    expect(sessionAppend).toHaveBeenCalledOnce();
  });

  it('reports a staging failure when no provided file exists', async () => {
    fsm.existsSync.mockReturnValue(false);
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'fix',
      message: 'x',
      files: ['ghost.ts'],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Failed to stage files/);
  });

  it('refuses to commit with an empty index by default instead of absorbing the tree', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return '';
      if (k === 'status --porcelain') return ' M auto.ts';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'chore', message: 'auto' });
    // Scope guard: previously this silently staged EVERY changed file — on a
    // shared checkout that absorbed unrelated concurrently staged work into
    // the commit. The default now refuses and explains the scoped options.
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Nothing staged/);
    expect(res.error).toMatch(/paths/);
    expect(res.error).toMatch(/autoStage/);
  });

  it('autoStage=true keeps the legacy stage-everything behavior', async () => {
    let stagedCalls = 0;
    const adds: string[][] = [];
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') {
        stagedCalls++;
        return stagedCalls === 1 ? '' : 'auto.ts'; // empty first, staged after add
      }
      if (k === 'status --porcelain') return ' M auto.ts';
      if (k.startsWith('add --')) {
        adds.push(args.slice()); // capture exact add argv
        return '';
      }
      if (k.startsWith('commit -m')) return 'cafe01 done';
      if (k === 'diff --cached --stat') return 'stat';
      if (k === 'diff --cached') return 'diff';
      return '';
    };
    const tools = setup({ 'git-autocommit': { autoStage: true } });
    const res = await tools.git_autocommit!.execute({ type: 'chore', message: 'auto' });
    expect(res.ok).toBe(true);
    expect(res.stagedFiles).toEqual(['auto.ts']);
    // Legacy behavior = explicitly staged the changed files it found.
    expect(adds).toEqual([['add', '--', 'auto.ts']]);
  });

  it('stages only pathspec-matching files and fences the commit with --only', async () => {
    const staged: string[][] = [];
    const adds: string[][] = [];
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'add -- **/package.json CHANGELOG.md') {
        adds.push(args.slice()); // capture exact add argv
        return '';
      }
      if (k === 'diff --cached --name-only -- **/package.json CHANGELOG.md')
        return 'package.json\npackages/core/package.json';
      // The paths flow also reads the FULL index after the scoped readback
      // (for the scope-guard warning) — answer it with the same slice here.
      if (k === 'diff --cached --name-only') return 'package.json\npackages/core/package.json';
      // The scoped diff/readback uses the CONCRETE staged file list (the
      // source resolves pathspecs to files first), not the glob patterns.
      if (k === 'diff --cached --stat -- package.json packages/core/package.json') return 'stat';
      if (k === 'diff --cached -- package.json packages/core/package.json')
        return '+version bump';
      if (k === 'diff --name-only -- package.json packages/core/package.json') return '';
      if (k.startsWith('commit -m')) {
        staged.push(args.slice()); // capture exact commit argv
        return 'scoped1 ok';
      }
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'chore',
      message: 'release bump',
      paths: ['**/package.json', 'CHANGELOG.md'],
    });
    expect(res.ok).toBe(true);
    // Reported payload is the scoped slice, not the whole index.
    expect(res.stagedFiles).toEqual(['package.json', 'packages/core/package.json']);
    // Staging was scoped to the pathspecs — no bare `git add .`-style call.
    expect(adds).toEqual([['add', '--', '**/package.json', 'CHANGELOG.md']]);
    // The preview diff carries the scoped content (mock-fed field).
    expect(res.diff).toContain('+version bump');
    // The commit is fenced: exactly these paths, after --only.
    expect(staged[0]).toEqual([
      'commit',
      '-m',
      'chore: release bump',
      '--only',
      '--',
      'package.json',
      'packages/core/package.json',
    ]);
  });

  it('refuses when no changed file matches the pathspecs', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'add -- website/**') return '';
      if (k.startsWith('diff --cached --name-only --')) return '';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'chore',
      message: 'website',
      paths: ['website/**'],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No changed files match/);
  });

  it('aborts when a scoped path drifts in the working tree after staging', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'add -- a.ts') return '';
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k === 'diff --cached --stat -- a.ts') return 'stat';
      if (k === 'diff --cached -- a.ts') return 'diff';
      // The working tree moved after staging: a.ts no longer matches the index.
      if (k === 'diff --name-only -- a.ts') return 'a.ts';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'fix',
      message: 'a',
      files: ['a.ts'],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Working tree changed after staging/);
    expect(res.error).toMatch(/a\.ts/);
  });

  it('warns when foreign staged files exist outside the requested scope', async () => {
    const commits: string[][] = [];
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'add -- a.ts') return '';
      // The index holds a.ts (ours) AND b.ts (someone else's staging).
      if (k === 'diff --cached --name-only') return 'a.ts\nb.ts';
      if (k === 'diff --cached --stat -- a.ts') return 'stat';
      if (k === 'diff --cached -- a.ts') return 'diff';
      if (k === 'diff --name-only -- a.ts') return '';
      if (k.startsWith('commit -m')) {
        commits.push(args.slice()); // capture exact commit argv
        return 'fenced ok';
      }
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'fix',
      message: 'a',
      files: ['a.ts'],
    });
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/Scope guard/);
    expect(res.warning).toMatch(/b\.ts/);
    // Payload reports only the caller's scope.
    expect(res.stagedFiles).toEqual(['a.ts']);
    // The commit itself is fenced: b.ts (foreign staged) is NOT on the argv.
    expect(commits[0]).toEqual(['commit', '-m', 'fix: a', '--only', '--', 'a.ts']);
  });

  it('rejects a non-array paths input', async () => {
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x', paths: 'a/**' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/paths must be an array/);
  });

  it('rejects files and paths passed together instead of silently dropping files', async () => {
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'feat',
      message: 'x',
      files: ['a.ts'],
      paths: ['**/package.json'],
    });
    // Previously `files` was silently ignored whenever `paths` was present.
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not both/);
  });

  it('returns "Nothing staged" when there is nothing to commit', async () => {
    gitHandler = () => ''; // no staged, no changed
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Nothing staged/);
  });

  it('falls back to the default commit type when none is given', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k.startsWith('commit -m')) return 'h ok';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ message: 'no type given' });
    expect(res.ok).toBe(true);
    expect(res.type).toBe('feat'); // defaultConfig.defaultType
  });

  it('handles staged-file lookups throwing both before and after auto-detect', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') throw new Error('cannot read index');
      if (k === 'status --porcelain') return '?? changed.ts';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Nothing staged/);
  });

  it('surfaces worktree and external-change warnings', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k === 'worktree list --porcelain') {
        return 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/wt\nHEAD def\nbranch refs/heads/feature\n';
      }
      if (k === 'status --porcelain') return '?? new.ts\n M other.ts';
      if (k.startsWith('commit -m')) return 'h1 ok';
      if (k === 'diff --cached --stat') return 'stat';
      if (k === 'diff --cached') return 'diff';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'w' });
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/Simultaneous edits/);
    expect(res.warning).toMatch(/External changes/);
  });

  it('truncates a very large staged diff in dry run', async () => {
    const big = 'x'.repeat(25_000);
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k === 'diff --cached --stat') return 'stat';
      if (k === 'diff --cached') return big;
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({
      type: 'feat',
      message: 'big',
      dry_run: true,
    });
    expect(res.dry_run).toBe(true);
    expect(res.stagedDiff).toMatch(/diff truncated/);
  });

  it('reports a commit failure', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k.startsWith('commit -m')) throw new Error('nothing to commit');
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Failed to commit/);
  });

  it('tolerates a throwing existsSync during staging', async () => {
    fsm.existsSync.mockImplementation(() => {
      throw new Error('stat failed');
    });
    const tools = setup();
    // No files exist (existsSync throws → treated as absent) → staging fails.
    const res = await tools.git_autocommit!.execute({ type: 'fix', message: 'x', files: ['a.ts'] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Failed to stage/);
  });

  it('falls back gracefully when diff/status commands throw', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k.startsWith('commit -m')) return 'h ok';
      // getStagedDiff and externalChangesSinceStage commands throw → internal catches.
      if (k.startsWith('diff --cached')) throw new Error('diff blew up');
      if (k === 'status --porcelain') throw new Error('status blew up');
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x' });
    expect(res.ok).toBe(true);
    expect(res.diff).toMatch(/unavailable/);
  });

  it('summarises more than ten external changes with a +N suffix', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `?? f${i}.ts`).join('\n');
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k === 'status --porcelain') return many;
      if (k.startsWith('commit -m')) return 'h ok';
      if (k === 'diff --cached --stat') return 'stat';
      if (k === 'diff --cached') return 'diff';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x' });
    expect(res.warning).toMatch(/and 2 more/);
  });

  it('still succeeds when session.append throws', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k.startsWith('commit -m')) return 'h ok';
      return '';
    };
    const tools = setup();
    sessionAppend.mockRejectedValue(new Error('disk full'));
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x' });
    expect(res.ok).toBe(true);
  });
});

describe('git_autocommit LLM generation (api.llm)', () => {
  const stagedRepo = (args: string[]): string => {
    const k = key(args);
    if (k === 'diff --cached --name-only') return 'a.ts';
    if (k === 'diff --cached --stat') return ' a.ts | 2 +-';
    if (k === 'diff --cached') return '+const x = 1;\n-const x = 0;';
    if (k.startsWith('commit -m')) return 'abc123 committed';
    return '';
  };

  const llmReply = (obj: unknown) => ({
    text: JSON.stringify(obj),
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    usage: { input: 40, output: 20 },
    stopReason: 'end_turn',
  });

  it('generate:true writes the message from the diff via the LLM', async () => {
    gitHandler = stagedRepo;
    const complete = vi
      .fn()
      .mockResolvedValue(
        llmReply({ type: 'fix', scope: 'core', summary: 'correct off-by-one', body: '' }),
      );
    const tools = setup({}, { complete });
    const res = await tools.git_autocommit!.execute({ generate: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.message).toBe('fix(core): correct off-by-one');
    expect(res.type).toBe('fix');
    expect(res.generatedByLlm).toBe(true);
  });

  it('useLlm config auto-generates when neither type nor message is given', async () => {
    gitHandler = stagedRepo;
    const complete = vi
      .fn()
      .mockResolvedValue(llmReply({ type: 'feat', scope: '', summary: 'add a thing', body: '' }));
    const tools = setup({ 'git-autocommit': { useLlm: true } }, { complete });
    const res = await tools.git_autocommit!.execute({});
    expect(complete).toHaveBeenCalledTimes(1);
    expect(res.message).toBe('feat: add a thing');
  });

  it('does not auto-generate when the caller supplies a type', async () => {
    gitHandler = stagedRepo;
    const complete = vi.fn();
    const tools = setup({ 'git-autocommit': { useLlm: true } }, { complete });
    const res = await tools.git_autocommit!.execute({ type: 'chore', message: 'manual msg' });
    expect(complete).not.toHaveBeenCalled();
    expect(res.message).toBe('chore: manual msg');
  });

  it('falls back to the caller/default when the LLM returns an invalid type', async () => {
    gitHandler = stagedRepo;
    const complete = vi.fn().mockResolvedValue(llmReply({ type: 'nonsense', summary: 'x' }));
    const tools = setup({}, { complete });
    const res = await tools.git_autocommit!.execute({
      generate: true,
      message: 'fallback summary',
    });
    // Invalid generation ignored → default type 'feat', caller's message kept.
    expect(res.ok).toBe(true);
    expect(res.type).toBe('feat');
    expect(res.message).toBe('feat: fallback summary');
    expect(res.generatedByLlm).toBe(false);
  });

  it('commit still succeeds when the LLM call throws (best-effort)', async () => {
    gitHandler = stagedRepo;
    const complete = vi.fn().mockRejectedValue(new Error('provider down'));
    const tools = setup({}, { complete });
    const res = await tools.git_autocommit!.execute({
      generate: true,
      type: 'feat',
      message: 'safe',
    });
    expect(res.ok).toBe(true);
    expect(res.generatedByLlm).toBe(false);
    expect(res.message).toBe('feat: safe');
  });

  it('generate is ignored when no api.llm is wired', async () => {
    gitHandler = stagedRepo;
    const tools = setup(); // no llm
    const res = await tools.git_autocommit!.execute({ generate: true, type: 'feat', message: 'm' });
    expect(res.ok).toBe(true);
    expect(res.generatedByLlm).toBe(false);
  });
});

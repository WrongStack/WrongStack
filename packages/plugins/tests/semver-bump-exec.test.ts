import { beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', async (o) => ({ ...(await o()), execFileSync: cp.execFileSync }));
const fsm = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('node:fs', async (o) => ({
  ...(await o()),
  existsSync: fsm.existsSync,
  readFileSync: fsm.readFileSync,
  readdirSync: fsm.readdirSync,
  writeFileSync: fsm.writeFileSync,
}));

import semverPlugin, { determineBump, parseConventional } from '../src/semver-bump';

interface Tool { name: string; execute: (i: Record<string, unknown>) => Promise<Record<string, unknown>>; }
interface Slash { name: string; run: (args: string, ctx?: { cwd?: string }) => Promise<{ message: string }>; }

let gitHandler: (args: string[]) => string;
let sessionAppend: ReturnType<typeof vi.fn>;
let onConfigChange: ((next: unknown) => void) | undefined;

function setup(cfg: Record<string, unknown> = {}): { tools: Record<string, Tool>; slash: Record<string, Slash> } {
  const tools: Record<string, Tool> = {};
  const slash: Record<string, Slash> = {};
  sessionAppend = vi.fn(async () => {});
  onConfigChange = undefined;
  const api = {
    tools: { register: (t: Tool) => { tools[t.name] = t; } },
    slashCommands: { register: (s: Slash) => { slash[s.name] = s; } },
    config: { extensions: { 'semver-bump': cfg } },
    onConfigChange: (fn: (n: unknown) => void) => { onConfigChange = fn; },
    log: { info: vi.fn(), warn: vi.fn() },
    metrics: { counter: vi.fn(), gauge: vi.fn(), histogram: vi.fn() },
    session: { append: sessionAppend },
  };
  semverPlugin.setup(api as never);
  return { tools, slash };
}

beforeEach(() => {
  cp.execFileSync.mockReset();
  fsm.existsSync.mockReset();
  fsm.readFileSync.mockReset();
  fsm.readdirSync.mockReset();
  fsm.writeFileSync.mockReset();
  gitHandler = () => '';
  // git via 'git'; the bump script via process.execPath.
  cp.execFileSync.mockImplementation((bin: string, args: string[]) => {
    if (bin === 'git') return gitHandler(args);
    return ''; // bump script
  });
  fsm.existsSync.mockImplementation((p: string) => String(p).endsWith('package.json'));
  fsm.readFileSync.mockReturnValue('{"version":"1.2.3"}');
  fsm.readdirSync.mockReturnValue([]);
});

// ── pure helpers ─────────────────────────────────────────────────────────────
describe('parseConventional', () => {
  it('parses breaking marker before and after the scope', () => {
    expect(parseConventional('feat!: big change')).toMatchObject({ type: 'feat', breaking: true });
    expect(parseConventional('feat(api)!: big change')).toMatchObject({ type: 'feat', scope: 'api', breaking: true });
  });
  it('parses a scoped non-breaking commit', () => {
    expect(parseConventional('fix(ui): a bug')).toMatchObject({ type: 'fix', scope: 'ui', breaking: false, message: 'a bug' });
  });
  it('falls back to chore for non-conventional subjects', () => {
    expect(parseConventional('just some text')).toMatchObject({ type: 'chore', breaking: false, message: 'just some text' });
  });
});

describe('determineBump', () => {
  const mk = (over: Partial<ReturnType<typeof parseConventional>> & { type: string }) =>
    ({ hash: 'h', message: 'm', breaking: false, ...over });
  it('returns major for a breaking change', () => {
    expect(determineBump([mk({ type: 'fix', breaking: true })] as never)).toBe('major');
  });
  it('returns minor for a feature', () => {
    expect(determineBump([mk({ type: 'feat' })] as never)).toBe('minor');
  });
  it('returns patch otherwise', () => {
    expect(determineBump([mk({ type: 'fix' })] as never)).toBe('patch');
  });
});

// ── semver_bump tool ─────────────────────────────────────────────────────────
describe('semver_bump', () => {
  it('errors when there is no package.json', async () => {
    fsm.existsSync.mockReturnValue(false);
    const { tools } = setup();
    expect((await tools.semver_bump!.execute({})).error).toMatch(/No package.json/);
  });

  it('dry-runs an explicit patch bump', async () => {
    const { tools } = setup();
    const res = await tools.semver_bump!.execute({ part: 'patch', dry_run: true });
    expect(res).toMatchObject({ ok: true, dry_run: true, currentVersion: '1.2.3', newVersion: '1.2.4' });
  });

  it('dry-runs major and minor bumps', async () => {
    const { tools } = setup();
    expect((await tools.semver_bump!.execute({ part: 'major', dry_run: true })).newVersion).toBe('2.0.0');
    expect((await tools.semver_bump!.execute({ part: 'minor', dry_run: true })).newVersion).toBe('1.3.0');
  });

  it('auto-detects the bump from commits since the last tag', async () => {
    gitHandler = (args) => {
      if (args[0] === 'describe') return 'v1.2.3';
      if (args[0] === 'log') return 'h1 feat: new thing\nh2 fix: a bug';
      return '';
    };
    const { tools } = setup();
    const res = await tools.semver_bump!.execute({ part: 'auto', dry_run: true });
    expect(res.suggestedBump).toBe('minor');
    expect(res.commitCount).toBe(2);
  });

  it('auto bump treats an empty describe as no tag', async () => {
    gitHandler = (args) => {
      if (args[0] === 'describe') return ''; // empty → lastTag undefined via `|| undefined`
      if (args[0] === 'log') return 'h1 fix: a bug';
      return '';
    };
    const { tools } = setup();
    const res = await tools.semver_bump!.execute({ part: 'auto', dry_run: true });
    expect(res.suggestedBump).toBe('patch');
  });

  it('auto bump works with no tags yet (describe throws)', async () => {
    gitHandler = (args) => {
      if (args[0] === 'describe') throw new Error('no tags');
      if (args[0] === 'log') return 'h1 feat!: breaking';
      return '';
    };
    const { tools } = setup();
    const res = await tools.semver_bump!.execute({ part: 'auto', dry_run: true });
    expect(res.suggestedBump).toBe('major');
  });

  it('auto bump returns a git error when the log fails', async () => {
    gitHandler = (args) => {
      if (args[0] === 'describe') return 'v1.0.0';
      if (args[0] === 'log') throw new Error('git log boom');
      return '';
    };
    const { tools } = setup();
    const res = await tools.semver_bump!.execute({ part: 'auto', dry_run: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Git error/);
  });

  it('applies the bump by writing manifests when no bump script exists', async () => {
    // bumpScript absent → manifest write path. readdir adds a workspace pkg.
    fsm.existsSync.mockImplementation((p: string) => {
      const s = String(p);
      if (s.endsWith('bump-version.mjs')) return false;
      if (s.endsWith('package.json')) return true;
      if (s.endsWith('packages') || s.endsWith('apps')) return true;
      return false;
    });
    fsm.readdirSync.mockImplementation((dir: string) =>
      String(dir).endsWith('packages')
        ? [
            { name: 'core', isDirectory: () => true },
            { name: 'README.md', isDirectory: () => false }, // non-directory → skipped
          ]
        : [],
    );
    const { tools } = setup();
    const res = await tools.semver_bump!.execute({ part: 'patch' });
    expect(res.ok).toBe(true);
    expect(res.newVersion).toBe('1.2.4');
    expect(fsm.writeFileSync).toHaveBeenCalled();
    expect(sessionAppend).toHaveBeenCalled();
    expect(res.tag).toBe('v1.2.4');
  });

  it('delegates to the repo bump script when present', async () => {
    fsm.existsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s.endsWith('package.json') || s.endsWith('bump-version.mjs');
    });
    const { tools } = setup();
    const res = await tools.semver_bump!.execute({ part: 'minor' });
    expect(res.ok).toBe(true);
    // node was invoked with the bump script
    const calledNode = cp.execFileSync.mock.calls.some(([, a]) => Array.isArray(a) && a.includes('set'));
    expect(calledNode).toBe(true);
    expect(fsm.writeFileSync).not.toHaveBeenCalled();
  });

  it('returns an error when the bump script fails', async () => {
    fsm.existsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s.endsWith('package.json') || s.endsWith('bump-version.mjs');
    });
    cp.execFileSync.mockImplementation((bin: string) => {
      if (bin !== 'git') throw new Error('script exploded');
      return '';
    });
    const { tools } = setup();
    const res = await tools.semver_bump!.execute({ part: 'patch' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/bump script failed/);
  });

  it('resolves auto to patch when there are no commits (empty log)', async () => {
    gitHandler = (args) => {
      if (args[0] === 'describe') return 'v1.0.0';
      if (args[0] === 'log') return ''; // empty → getRecentCommits returns []
      return '';
    };
    const { tools } = setup();
    const res = await tools.semver_bump!.execute({ part: 'auto', dry_run: true });
    expect(res.suggestedBump).toBe('patch');
    expect(res.commitCount).toBe(0);
  });

  it('treats an unparseable version as 0.0.0', async () => {
    fsm.readFileSync.mockReturnValue('{"version":"garbage"}');
    const { tools } = setup();
    const res = await tools.semver_bump!.execute({ part: 'patch', dry_run: true });
    expect(res.newVersion).toBe('0.0.1');
  });

  it('honours an explicit cwd', async () => {
    const { tools } = setup();
    const res = await tools.semver_bump!.execute({ part: 'patch', dry_run: true, cwd: 'work' });
    expect(res.ok).toBe(true);
    expect(fsm.existsSync).toHaveBeenCalledWith(expect.stringMatching(/[\\/]work[\\/]package\.json$/));
  });

  it('skips tagging when autoTag is disabled', async () => {
    const { tools } = setup({ autoTag: false });
    const tagCalls: string[][] = [];
    gitHandler = (args) => { if (args[0] === 'tag') tagCalls.push(args); return ''; };
    await tools.semver_bump!.execute({ part: 'patch' });
    expect(tagCalls).toHaveLength(0);
  });
});

// ── semver_current ───────────────────────────────────────────────────────────
describe('semver_current', () => {
  it('returns the version, latest tag and commit count', async () => {
    gitHandler = (args) => {
      if (args[0] === 'describe') return 'v1.2.0';
      if (args[0] === 'rev-list') return '7';
      return '';
    };
    const { tools } = setup();
    const res = await tools.semver_current!.execute({});
    expect(res).toMatchObject({ currentVersion: '1.2.3', latestTag: 'v1.2.0', commitsSinceTag: 7 });
  });

  it('treats a non-numeric rev-list count as 0', async () => {
    gitHandler = (args) => {
      if (args[0] === 'describe') return 'v1.0.0';
      if (args[0] === 'rev-list') return 'not-a-number'; // parseInt → NaN → || 0
      return '';
    };
    const { tools } = setup();
    const res = await tools.semver_current!.execute({});
    expect(res.latestTag).toBe('v1.0.0');
    expect(res.commitsSinceTag).toBe(0);
  });

  it('returns a null tag when describe yields nothing', async () => {
    gitHandler = (args) => (args[0] === 'describe' ? '' : '');
    const { tools } = setup();
    const res = await tools.semver_current!.execute({});
    expect(res.latestTag).toBeNull();
  });

  it('reports unknown version and null tag when git/pkg are unavailable', async () => {
    fsm.existsSync.mockReturnValue(false);
    gitHandler = () => { throw new Error('no git'); };
    const { tools } = setup();
    const res = await tools.semver_current!.execute({});
    expect(res).toMatchObject({ currentVersion: 'unknown', latestTag: null });
  });

  it('reports unknown version when package.json is invalid JSON', async () => {
    fsm.readFileSync.mockReturnValue('{ not valid json');
    gitHandler = () => '';
    const { tools } = setup();
    const res = await tools.semver_current!.execute({});
    expect(res.currentVersion).toBe('unknown');
  });

  it('surfaces "Not a git repository" for git exit status 128', async () => {
    gitHandler = () => { const e = new Error('fatal') as Error & { status: number }; e.status = 128; throw e; };
    const { tools } = setup();
    // status 128 → runGit throws "Not a git repository", caught by semver_current → null tag
    const res = await tools.semver_current!.execute({});
    expect(res.latestTag).toBeNull();
  });
});

// ── semver_changelog ─────────────────────────────────────────────────────────
describe('semver_changelog', () => {
  it('produces a markdown changelog grouped by section', async () => {
    gitHandler = () => [
      'h1 feat(api)!: breaking feature',
      'h2 feat: plain feature',
      'h3 fix: a fix',
      'h4 build: tooling tweak',
    ].join('\n');
    const { tools } = setup();
    const res = await tools.semver_changelog!.execute({ from: 'v1.0.0', to: 'HEAD' });
    expect(res.ok).toBe(true);
    const cl = res.changelog as string;
    expect(cl).toMatch(/BREAKING CHANGES/);
    expect(cl).toMatch(/Features/);
    expect(cl).toMatch(/Bug Fixes/);
    expect(cl).toMatch(/Other Changes/);
    expect(res.breakingCount).toBe(1);
  });

  it('renders scopes and omits the from label when from is absent', async () => {
    gitHandler = () => 'h1 fix(ui): scoped bug';
    const { tools } = setup();
    const res = await tools.semver_changelog!.execute({}); // no `from`
    expect(res.from).toBe('(beginning)');
    expect(res.changelog as string).toMatch(/\*\*ui\*\*: scoped bug/);
  });

  it('returns JSON when format=json', async () => {
    gitHandler = () => 'h1 feat: x';
    const { tools } = setup();
    const res = await tools.semver_changelog!.execute({ format: 'json' });
    expect(res.ok).toBe(true);
    expect(res.commitCount).toBe(1);
    expect(Array.isArray(res.commits)).toBe(true);
  });

  it('errors when git log fails', async () => {
    gitHandler = () => { throw new Error('bad range'); };
    const { tools } = setup();
    const res = await tools.semver_changelog!.execute({ from: 'a', to: 'b' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Failed to get git log/);
  });
});

// ── /semver slash command ────────────────────────────────────────────────────
describe('/semver slash command', () => {
  it('shows status by default', async () => {
    gitHandler = (args) => {
      if (args[0] === 'describe') return 'v1.2.0';
      if (args[0] === 'log') return 'h1 feat: x';
      return '';
    };
    const { slash } = setup();
    const res = await slash.semver!.run('');
    expect(res.message).toMatch(/Current version: 1.2.3/);
    expect(res.message).toMatch(/Suggested bump: {2}minor/);
  });

  it('status reports no package.json', async () => {
    fsm.existsSync.mockReturnValue(false);
    const { slash } = setup();
    expect((await slash.semver!.run('status')).message).toMatch(/No package.json/);
  });

  it('status tolerates git being unavailable', async () => {
    gitHandler = () => { throw new Error('no git'); };
    const { slash } = setup();
    const res = await slash.semver!.run('status');
    expect(res.message).toMatch(/Latest tag: {6}\(none\)/);
  });

  it('status shows (none) when describe returns empty', async () => {
    gitHandler = (args) => (args[0] === 'log' ? 'h1 feat: x' : ''); // describe '' → no tag
    const { slash } = setup();
    const res = await slash.semver!.run('status');
    expect(res.message).toMatch(/Latest tag: {6}\(none\)/);
  });

  it('reports the error message when a bump fails', async () => {
    fsm.existsSync.mockReturnValue(false); // no package.json → performBump errors
    const { slash } = setup();
    const res = await slash.semver!.run('patch');
    expect(res.message).toMatch(/No package.json/);
  });

  it('rejects an unknown mode', async () => {
    const { slash } = setup();
    expect((await slash.semver!.run('frobnicate')).message).toMatch(/Unknown mode/);
  });

  it('applies a bump via the slash command (dry)', async () => {
    const { slash } = setup();
    const res = await slash.semver!.run('patch --dry');
    expect(res.message).toMatch(/Would bump 1.2.3 → 1.2.4/);
  });
});

// ── config ───────────────────────────────────────────────────────────────────
describe('config', () => {
  it('reads the default part and updates it on config change', async () => {
    const { tools } = setup({ defaultPart: 'minor' });
    // No part given → uses configured default (minor).
    expect((await tools.semver_bump!.execute({ dry_run: true })).suggestedBump).toBe('minor');
    onConfigChange?.({ extensions: { 'semver-bump': { defaultPart: 'major' } } });
    expect((await tools.semver_bump!.execute({ dry_run: true })).suggestedBump).toBe('major');
  });

  it('falls back to patch for an invalid configured default', async () => {
    const { tools } = setup({ defaultPart: 'nonsense' });
    expect((await tools.semver_bump!.execute({ dry_run: true })).suggestedBump).toBe('patch');
  });
});

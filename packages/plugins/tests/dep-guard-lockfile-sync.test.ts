import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import {
  dependencyChange,
  findLockfileDrift,
  isCommitCall,
  lockfileDriftNote,
  registerLockfileSync,
} from '../src/dep-guard/lockfile-sync.js';

// Pass-through spy: the real isolation probe still runs, but its calls are
// counted so a judgement's cost does not depend on timing.
const isolationProbes = vi.hoisted(() => ({ count: 0 }));
vi.mock('@wrongstack/primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/primitives')>();
  return {
    ...actual,
    gitIsolationEnv: (...args: Parameters<typeof actual.gitIsolationEnv>) => {
      isolationProbes.count += 1;
      return actual.gitIsolationEnv(...args);
    },
  };
});

// These integration cases start several real Git processes. Match the root
// suite's spawn-heavy timeout policy when this package config runs them directly.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: deps, ...extra }, null, 2)}\n`;

describe('isCommitCall', () => {
  it('recognizes the git tool commit and a shell git commit', () => {
    expect(isCommitCall('git', { command: 'commit', message: 'm' }, '')).toBe(true);
    expect(isCommitCall('git', { command: 'status' }, '')).toBe(false);
    expect(isCommitCall('bash', {}, 'git add -A && git commit -m "x"')).toBe(true);
    expect(isCommitCall('bash', {}, 'git -c user.name=a commit --amend --no-edit')).toBe(true);
    expect(isCommitCall('bash', {}, 'git log --oneline')).toBe(false);
    expect(isCommitCall('bash', {}, 'echo committed')).toBe(false);
  });
});

describe('dependencyChange', () => {
  it('summarizes npm dependency changes and ignores everything else', () => {
    expect(dependencyChange('npm', pkg({ a: '1' }), pkg({ a: '1' }, { scripts: { t: 'x' } }))).toBe(
      null,
    );
    expect(dependencyChange('npm', pkg({ a: '1', b: '1' }), pkg({ a: '2', c: '1' }))).toBe(
      '+c, -b, ~a',
    );
    expect(
      dependencyChange('npm', pkg({}), pkg({}, { pnpm: { overrides: { a: '1' } } })),
    ).not.toBeNull();
    expect(dependencyChange('npm', 'not json', pkg({ a: '1' }))).toBe(null);
  });

  it('reads Cargo dependency tables, not the rest of the manifest', () => {
    const base = '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n';
    expect(dependencyChange('cargo', base, base.replace('0.1.0', '0.2.0'))).toBe(null);
    expect(dependencyChange('cargo', base, `${base}tokio = "1"\n`)).toBe(
      '1 dependency line changed',
    );
    expect(dependencyChange('cargo', base, `${base}\n[dev-dependencies]\nproptest = "1"\n`)).toBe(
      '1 dependency line changed',
    );
  });

  it('detects Cargo drift when a dep value contains # inside a quoted string', () => {
    // The previous blind `\s+#.*$` strip in cargoDeps collapsed two
    // distinct dep values (one carrying an inline `#` inside its string,
    // one carrying a different `#`) to identical map keys and reported
    // null drift. The string-aware comment stripper preserves `#` inside
    // `"…"` literals so the diff surfaces.
    const before = '[dependencies]\nmylib = "abc # first note"\n';
    const after = '[dependencies]\nmylib = "abc # second note"\n';
    expect(dependencyChange('cargo', before, after)).not.toBe(null);
  });

  it('detects Cargo drift when a dep value gains a # tag inside a quoted string', () => {
    const before = '[dependencies]\nmylib = "abc"\n';
    const after = '[dependencies]\nmylib = "abc # useful tag"\n';
    expect(dependencyChange('cargo', before, after)).not.toBe(null);
  });

  it('reads go.mod require blocks and single lines', () => {
    const base = 'module x\n\ngo 1.22\n\nrequire (\n\ta v1.0.0\n)\n';
    expect(dependencyChange('go', base, base.replace('go 1.22', 'go 1.23'))).toBe(null);
    expect(dependencyChange('go', base, base.replace('v1.0.0', 'v1.1.0'))).toBe(
      '2 dependency lines changed',
    );
    expect(dependencyChange('go', base, `${base}require b v0.1.0\n`)).toBe(
      '1 dependency line changed',
    );
  });
});

describe('findLockfileDrift', () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      windowsHide: true,
      stdio: 'pipe',
    });
  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-qm', message);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-sync-'));
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    await write('package.json', pkg({ a: '1' }));
    await write('packages/web/package.json', pkg({ b: '1' }));
    await write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    commit('init');
  });

  afterEach(async () => {
    await removeProjectFixtureDirectory(dir, { maxRetries: 3, retryDelay: 100 });
  });

  it('flags a dependency change committed without the lockfile', async () => {
    await write('package.json', pkg({ a: '1', zod: '3' }));
    commit('add zod');
    const result = await findLockfileDrift(dir);
    expect(result?.findings).toEqual([
      { manifest: 'package.json', lockfile: 'pnpm-lock.yaml', summary: '+zod' },
    ]);
    const note = lockfileDriftNote(result?.commit ?? '', result?.findings ?? []);
    expect(note).toContain('run `pnpm install` and commit pnpm-lock.yaml');
  });

  it('pins a workspace package to the root lockfile', async () => {
    await write('packages/web/package.json', pkg({ b: '2' }));
    commit('bump b');
    expect((await findLockfileDrift(dir))?.findings).toEqual([
      { manifest: 'packages/web/package.json', lockfile: 'pnpm-lock.yaml', summary: '~b' },
    ]);
  });

  it('is quiet when the lockfile is in the commit or nothing dependency-related changed', async () => {
    await write('package.json', pkg({ a: '2' }));
    await write('pnpm-lock.yaml', 'lockfileVersion: 9\n# a@2\n');
    commit('bump a with lockfile');
    expect((await findLockfileDrift(dir))?.findings).toEqual([]);

    await write('package.json', pkg({ a: '2' }, { scripts: { test: 'vitest' } }));
    commit('scripts only');
    expect((await findLockfileDrift(dir))?.findings).toEqual([]);
  });

  it('ignores a lockfile the repository does not track', async () => {
    git('rm', '-q', '--cached', 'pnpm-lock.yaml');
    await write('.gitignore', 'pnpm-lock.yaml\n');
    commit('stop tracking the lockfile');
    await write('package.json', pkg({ a: '1', zod: '3' }));
    commit('add zod');
    expect((await findLockfileDrift(dir))?.findings).toEqual([]);
  });

  it('does not judge a root commit or a directory outside git', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-sync-nogit-'));
    try {
      expect(await findLockfileDrift(outside)).toBeNull();
    } finally {
      await removeProjectFixtureDirectory(outside, { maxRetries: 3, retryDelay: 100 });
    }
    // beforeEach made the root commit: a manifest with dependencies, nothing to compare to.
    expect(await findLockfileDrift(dir)).toBeNull();
  });

  it('notes each commit once, and only after a successful commit call', async () => {
    type Hook = (input: unknown) => Promise<{ additionalContext?: string } | undefined>;
    let hook: Hook | undefined;
    const api = {
      registerHook: vi.fn((_event: string, _matcher: string, fn: Hook) => {
        hook = fn;
        return () => undefined;
      }),
      metrics: { counter: vi.fn() },
    };
    registerLockfileSync(api as never);
    expect(api.registerHook.mock.calls[0]?.[1]).toBe('git|bash|exec|pwsh');

    await write('package.json', pkg({ a: '1', zod: '3' }));
    commit('add zod');
    const call = {
      toolName: 'bash',
      toolInput: { command: 'git commit -m "add zod"' },
      toolResult: { content: '', isError: false },
      cwd: dir,
    };
    expect((await hook?.({ ...call, toolResult: { content: '', isError: true } })) ?? {}).toEqual(
      {},
    );
    expect((await hook?.(call))?.additionalContext).toContain('package.json (+zod)');
    // The same HEAD again (a refused follow-up commit) is not noted twice.
    expect(await hook?.(call)).toBeUndefined();
    expect(api.metrics.counter).toHaveBeenCalledTimes(1);
  });

  it('judges a commit across many workspace manifests with one isolation probe per directory', async () => {
    // Probing the repository's config before EVERY git call made each call
    // cost ~450ms on Windows: a commit touching six manifests outlasted the
    // 5s hook budget and the note was dropped.
    for (let i = 0; i < 6; i++) await write(`packages/p${i}/package.json`, pkg({ zod: '3' }));
    commit('add six workspace packages without the lockfile');
    isolationProbes.count = 0;
    const result = await findLockfileDrift(dir);
    expect(result?.findings.map((f) => f.manifest)).toEqual(
      Array.from({ length: 6 }, (_, i) => `packages/p${i}/package.json`),
    );
    // The session cwd and the repository root may be spelled differently.
    expect(isolationProbes.count).toBeLessThanOrEqual(2);
  });

  it('gives the after-commit hook more than the default 5s budget', () => {
    const api = {
      registerHook: vi.fn((..._args: unknown[]) => () => undefined),
      metrics: { counter: vi.fn() },
    };
    registerLockfileSync(api as never);
    expect(api.registerHook.mock.calls[0]?.[3]).toMatchObject({ timeoutMs: 30_000 });
  });

  it('flags a newly added workspace package.json with dependencies when the lockfile is untouched', async () => {
    expect(dependencyChange('npm', '', pkg({ zod: '3' }))).toBe('+zod');
    await write('packages/api/package.json', pkg({ zod: '3' }));
    commit('add workspace package without lockfile');
    expect((await findLockfileDrift(dir))?.findings).toEqual([
      {
        manifest: 'packages/api/package.json',
        lockfile: 'pnpm-lock.yaml',
        summary: '+zod',
      },
    ]);
  });
});

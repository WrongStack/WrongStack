/**
 * #447: the built-in `install`, `audit` and `outdated` tools run Bun for a Bun
 * project. They used to detect it as npm, so `npm audit` failed on a bun-only
 * lockfile ("This command requires an existing lockfile") and installs used
 * npm's syntax.
 *
 * Real project directories drive the real detection; only the process layer
 * is replaced, replaying output captured from Bun 1.4.5.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnStreamMock = vi.hoisted(() => vi.fn());
const streamResult = vi.hoisted(() => ({ stdout: '', exitCode: 0 }));
vi.mock('../src/_spawn-stream.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  spawnStream: (opts: unknown) => {
    spawnStreamMock(opts);
    // biome-ignore lint/correctness/useYield: replays a finished process
    return (async function* () {
      return {
        stdout: streamResult.stdout,
        stderr: '',
        exitCode: streamResult.exitCode,
        truncated: false,
      };
    })();
  },
}));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { auditTool } = await import('../src/audit.js');
const { installTool } = await import('../src/install.js');
const { outdatedTool } = await import('../src/outdated.js');

/** `bun audit --json` for minimist@0.0.8 (exit 1: advisories found). */
const BUN_AUDIT = JSON.stringify({
  minimist: [
    {
      id: 1097677,
      url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
      title: 'Prototype Pollution in minimist',
      severity: 'critical',
      vulnerable_versions: '<0.2.4',
    },
    {
      id: 1096466,
      url: 'https://github.com/advisories/GHSA-vh95-rmgr-6w4m',
      title: 'Prototype Pollution in minimist',
      severity: 'moderate',
      vulnerable_versions: '<0.2.1',
    },
  ],
});

/** `bun outdated` (exit 0); it rejects `--json`. */
const BUN_OUTDATED = [
  'bun outdated v1.4.5 (a7733435c)',
  '|---------------------------------------------|',
  '| Package         | Current | Update | Latest |',
  '|-----------------|---------|--------|--------|',
  '| minimist        | 0.0.8   | 0.0.8  | 1.2.8  |',
  '|-----------------|---------|--------|--------|',
  '| is-number (dev) | 6.0.0   | 6.0.0  | 7.0.0  |',
  '|---------------------------------------------|',
].join('\n');

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bun-tools-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const bunLockProject = () =>
  project({ 'package.json': '{"name":"fx"}', 'bun.lock': '{"lockfileVersion":1}' });
const ctxFor = (dir: string) =>
  ({
    cwd: dir,
    projectRoot: dir,
    tools: [],
    sideEffects: [],
    recordSideEffect: () => {},
    session: {
      id: 't',
      append: async () => undefined,
      recordFileChange: () => {},
      recordSideEffect: () => {},
    },
  }) as never;
const opts = () => ({ signal: new AbortController().signal });

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

beforeEach(() => {
  spawnStreamMock.mockReset();
  spawnMock.mockReset();
  streamResult.stdout = '';
  streamResult.exitCode = 0;
});

/** The package-manager argv `install` ran for this input. */
async function installArgv(dir: string, input: object): Promise<{ cmd: string; args: string[] }> {
  await installTool.execute(input as never, ctxFor(dir), opts());
  return spawnStreamMock.mock.calls.at(-1)![0] as { cmd: string; args: string[] };
}

describe('install', () => {
  it('adds named packages with `bun add`, flags after the subcommand', async () => {
    const dir = bunLockProject();
    expect(await installArgv(dir, { packages: 'zod, left-pad', save: 'dev' })).toMatchObject({
      cmd: 'bun',
      args: ['add', '--ignore-scripts', '--dev', 'zod', 'left-pad'],
    });
    expect(
      await installArgv(dir, { packages: 'zod', save: 'optional', dry_run: true }),
    ).toMatchObject({
      args: ['add', '--dry-run', '--ignore-scripts', '--optional', 'zod'],
    });
    expect(
      await installArgv(dir, { packages: 'zod', lifecycleScripts: true, global: true }),
    ).toMatchObject({
      args: ['add', '-g', 'zod'],
    });
  });

  it('restores the lockfile with a bare `bun install`', async () => {
    expect(await installArgv(bunLockProject(), {})).toMatchObject({
      cmd: 'bun',
      args: ['install', '--ignore-scripts'],
    });
  });

  it('honours packageManager: bun@ without a lockfile', async () => {
    const dir = project({ 'package.json': '{"packageManager":"bun@1.4.5"}' });
    expect((await installArgv(dir, {})).cmd).toBe('bun');
  });

  it('control: a package-lock.json project still uses npm', async () => {
    const dir = project({ 'package.json': '{}', 'package-lock.json': '{}' });
    expect(await installArgv(dir, { packages: 'zod' })).toMatchObject({
      cmd: 'npm',
      args: ['--ignore-scripts', 'install', 'zod'],
    });
  });
});

describe('audit', () => {
  it('runs `bun audit --json` and reads its package-keyed report', async () => {
    streamResult.stdout = BUN_AUDIT;
    streamResult.exitCode = 1;
    const out = await auditTool.execute({}, ctxFor(bunLockProject()), opts());
    expect(spawnStreamMock.mock.calls[0]![0]).toMatchObject({
      cmd: 'bun',
      args: ['audit', '--json'],
    });
    expect(out.vulnerabilities).toEqual([
      {
        severity: 'critical',
        package: 'minimist',
        title: 'Prototype Pollution in minimist',
        url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
      },
      {
        severity: 'moderate',
        package: 'minimist',
        title: 'Prototype Pollution in minimist',
        url: 'https://github.com/advisories/GHSA-vh95-rmgr-6w4m',
      },
    ]);
    expect(out.summary).toBe('Found 2 vulnerabilities: 1 critical, 0 high');
  });

  it('filters by level itself (bun ignores --audit-level in JSON)', async () => {
    streamResult.stdout = BUN_AUDIT;
    streamResult.exitCode = 1;
    const out = await auditTool.execute({ level: 'high' }, ctxFor(bunLockProject()), opts());
    expect(out.vulnerabilities.map((v) => v.severity)).toEqual(['critical']);
  });

  it('a clean bun report has no vulnerabilities', async () => {
    streamResult.stdout = '{}';
    const out = await auditTool.execute({}, ctxFor(bunLockProject()), opts());
    expect(out).toMatchObject({ total: 0, summary: 'No vulnerabilities found' });
  });
});

describe('outdated', () => {
  function replay(stdout: string, code = 0) {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', code);
      });
      return child;
    });
  }

  it('runs `bun outdated` without --json and reads its table', async () => {
    replay(BUN_OUTDATED);
    const out = await outdatedTool.execute({}, ctxFor(bunLockProject()), opts());
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect([cmd, args].flat().join(' ')).toMatch(/\bbun(\.exe)?\b.*\boutdated$/);
    expect(args).not.toContain('--json');
    expect(out).toMatchObject({ exit_code: 0, total: 2 });
    expect(out.packages).toEqual([
      {
        name: 'minimist',
        current: '0.0.8',
        wanted: '0.0.8',
        latest: '1.2.8',
        type: 'dependencies',
        location: 'minimist',
      },
      {
        name: 'is-number',
        current: '6.0.0',
        wanted: '6.0.0',
        latest: '7.0.0',
        type: 'devDependencies',
        location: 'is-number',
      },
    ]);
  });

  it('reads the Workspace column of a workspace table', async () => {
    replay(
      [
        '| Package | Current | Update | Latest | Workspace |',
        '|---------|---------|--------|--------|-----------|',
        '| zod     | 3.0.0   | 3.9.0  | 4.1.0  | @app/api  |',
      ].join('\n'),
    );
    const out = await outdatedTool.execute({}, ctxFor(bunLockProject()), opts());
    expect(out.packages).toEqual([
      {
        name: 'zod',
        current: '3.0.0',
        wanted: '3.9.0',
        latest: '4.1.0',
        type: 'dependencies',
        location: '@app/api',
      },
    ]);
  });
});

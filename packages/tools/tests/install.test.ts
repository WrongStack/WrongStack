import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolProgressEvent } from '@wrongstack/contracts/types';
import * as Core from '@wrongstack/core/coordination';
import { subjectForToolInput } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnStreamResult } from '../src/_spawn-stream.js';
import { installTool } from '../src/install.js';

// Mock spawnStream — an AsyncGenerator<ToolProgressEvent, SpawnStreamResult>.
// executeStream calls: const result = yield* spawnStream({...})
//
// Exported as a hoisted vi.fn so individual tests can inspect the args
// (cmd/args) that installTool constructed for the package-manager call.
const spawnStreamMock = vi.hoisted(() => vi.fn());
const spawnOutcome = vi.hoisted(() => ({
  override: undefined as Partial<SpawnStreamResult> | undefined,
}));
vi.mock('../src/_spawn-stream.js', () => ({
  spawnStream: ((opts: unknown) => {
    spawnStreamMock(opts);
    return (async function* (): AsyncGenerator<ToolProgressEvent, SpawnStreamResult> {
      yield { type: 'partial_output', text: 'added 1 package\n' };
      return {
        stdout: 'added 1 package',
        stderr: '',
        exitCode: 0,
        truncated: false,
        ...spawnOutcome.override,
      };
    })();
  }) as never as (opts: unknown) => AsyncGenerator<ToolProgressEvent, SpawnStreamResult>,
}));

const makeCtx = (overrides?: Record<string, unknown>) => {
  const ctx = {
    cwd: '/fake',
    tools: [],
    projectRoot: '/fake',
    agentId: 'leader',
    agentName: 'Leader',
    sideEffects: [] as unknown[],
    session: {
      id: 'test',
      append: async () => undefined,
      recordFileChange: () => {},
      recordSideEffect: () => {},
    },
    ...overrides,
  } as any;
  ctx.recordSideEffect = (se: unknown) => ctx.sideEffects.push(se);
  return ctx;
};
const makeOpts = () => ({ signal: new AbortController().signal });

describe('installTool', () => {
  beforeEach(() => {
    vi.spyOn(Core, 'recordPackageAction').mockResolvedValue(undefined);
    vi.spyOn(Core, 'detectEcosystem').mockReturnValue('npm');
    vi.clearAllMocks();
    spawnOutcome.override = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct metadata', () => {
    expect(installTool.name).toBe('install');
    expect(installTool.permission).toBe('confirm');
    expect(installTool.mutating).toBe(true);
    expect(installTool.riskTier).toBe('standard');
  });

  it('handles empty packages', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({}, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
    expect(result).toHaveProperty('packages');
  });

  it('passes single package', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'vitest' }, ctx, makeOpts());
    expect(result.packages).toContain('vitest');
  });

  it('passes multiple packages as comma string', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'vitest,prettier' }, ctx, makeOpts());
    expect(result.packages).toContain('vitest');
  });

  it('passes packages as array', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: ['vitest', 'prettier'] }, ctx, makeOpts());
    expect(result.packages).toContain('vitest');
  });

  // These used to assert only that `exit_code` existed; the flag could have
  // been dropped from the package-manager argv and they would still pass.
  const lastSpawn = (): { cmd: string; args: string[] } =>
    spawnStreamMock.mock.calls.at(-1)?.[0] as { cmd: string; args: string[] };

  it('passes save=dev flag', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'foo', save: 'dev' }, ctx, makeOpts());
    expect(result.exit_code).toBe(0);
    expect(lastSpawn().args).toEqual(expect.arrayContaining(['install', '--save-dev', 'foo']));
  });

  it('passes global flag', async () => {
    const ctx = makeCtx();
    await installTool.execute({ packages: 'foo', global: true }, ctx, makeOpts());
    expect(lastSpawn().args).toContain('-g');
  });

  it('respects dry_run', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'foo', dry_run: true }, ctx, makeOpts());
    expect(result.dry_run).toBe(true);
    expect(lastSpawn().args).toContain('--dry-run');
    await installTool.execute({ packages: 'foo' }, ctx, makeOpts());
    expect(lastSpawn().args).not.toContain('--dry-run');
  });

  // ── Authorship tracking ────────────────────────────────────────────────────

  it('records package authorship when ctx.meta.packageTrackerOpts is set', async () => {
    const ctx = makeCtx({
      meta: {
        packageTrackerOpts: { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      },
      session: { id: 'sess-abc' } as any,
    });
    await installTool.execute({ packages: 'vitest' }, ctx, makeOpts());
    expect(Core.recordPackageAction).toHaveBeenCalledWith(
      { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      expect.objectContaining({
        packageName: 'vitest',
        agentId: 'leader',
        agentName: 'Leader',
        sessionId: 'sess-abc',
        ecosystem: 'npm',
      }),
    );
  });

  it('records multiple packages in one install', async () => {
    const ctx = makeCtx({
      meta: {
        packageTrackerOpts: { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      },
      session: { id: 'sess-abc' } as any,
    });
    await installTool.execute({ packages: ['vitest', 'prettier'] }, ctx, makeOpts());
    expect(Core.recordPackageAction).toHaveBeenCalledTimes(2);
    expect(Core.recordPackageAction).toHaveBeenNthCalledWith(
      1,
      { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      expect.objectContaining({ packageName: 'vitest' }),
    );
    expect(Core.recordPackageAction).toHaveBeenNthCalledWith(
      2,
      { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      expect.objectContaining({ packageName: 'prettier' }),
    );
  });

  it('does NOT record authorship when ctx.meta.packageTrackerOpts is absent', async () => {
    const ctx = makeCtx({ meta: {} });
    await installTool.execute({ packages: 'vitest' }, ctx, makeOpts());
    expect(Core.recordPackageAction).not.toHaveBeenCalled();
  });

  it('does NOT record authorship for global installs', async () => {
    const ctx = makeCtx({
      meta: {
        packageTrackerOpts: { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      },
      session: { id: 'sess-abc' } as any,
    });
    await installTool.execute({ packages: 'vitest', global: true }, ctx, makeOpts());
    expect(Core.recordPackageAction).not.toHaveBeenCalled();
  });

  it('does NOT record authorship for dry_run installs', async () => {
    const ctx = makeCtx({
      meta: {
        packageTrackerOpts: { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      },
      session: { id: 'sess-abc' } as any,
    });
    await installTool.execute({ packages: 'vitest', dry_run: true }, ctx, makeOpts());
    expect(Core.recordPackageAction).not.toHaveBeenCalled();
  });

  it('resolves an explicit cwd', async () => {
    const result = await installTool.execute({ packages: 'foo', cwd: '.' }, makeCtx(), makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('throws when executeStream is unavailable', async () => {
    const original = installTool.executeStream;
    (installTool as { executeStream: typeof original | undefined }).executeStream = undefined;
    try {
      await expect(installTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      (installTool as any).executeStream = original;
    }
  });

  it('throws when the stream ends without a final event', async () => {
    const original = installTool.executeStream!;
    installTool.executeStream = async function* () {
      yield { type: 'log', text: 'no final' } as never;
    };
    try {
      await expect(installTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(
        /without final event/,
      );
    } finally {
      (installTool as any).executeStream = original;
    }
  });

  it.each(['--ignore-scripts', '--global', '-g', '.', '..'])(
    'rejects flag or path package spec %s',
    async (spec) => {
      const ctx = makeCtx();
      await expect(installTool.execute({ packages: spec }, ctx, makeOpts())).rejects.toThrow(
        'Invalid package name',
      );
    },
  );

  it('throws when the package manager exits non-zero (install did not happen)', async () => {
    spawnOutcome.override = {
      stdout: '',
      stderr: 'npm error 404 Not Found - GET https://registry.npmjs.org/nope',
      exitCode: 1,
    };
    const ctx = makeCtx();
    await expect(installTool.execute({ packages: 'nope' }, ctx, makeOpts())).rejects.toThrow(
      /failed \(exit 1\)[\s\S]*404 Not Found/,
    );
    // The attempted side effect is still recorded.
    expect(ctx.sideEffects).toHaveLength(1);
  });

  it('throws when the package manager cannot be started', async () => {
    spawnOutcome.override = { stdout: '', exitCode: 1, error: 'spawn npm ENOENT' };
    await expect(installTool.execute({ packages: 'foo' }, makeCtx(), makeOpts())).rejects.toThrow(
      /could not run npm: spawn npm ENOENT/,
    );
  });

  it.each([
    'react@18',
    'react@18.2.0',
    'vitest@latest',
    '@types/node@^20.1.0',
    'typescript@~5.4',
    'esbuild@0.21.x',
  ])('accepts versioned spec %s', async (spec) => {
    spawnStreamMock.mockClear();
    const result = await installTool.execute({ packages: spec }, makeCtx(), makeOpts());
    expect(result.exit_code).toBe(0);
    const call = spawnStreamMock.mock.calls[0]?.[0] as { args: string[] };
    expect(call.args).toContain(spec);
  });

  it.each([
    'file:../../etc/passwd',
    'pkg@1.0.0; rm -rf /',
    'pkg@1.0.0 --flag',
    'pkg@ver$(whoami)',
    // Package managers read a dot-led spec as a directory: `..` installs the parent.
    '..',
    '.hidden',
  ])('still rejects malicious spec %s', async (spec) => {
    await expect(installTool.execute({ packages: spec }, makeCtx(), makeOpts())).rejects.toThrow(
      'Invalid package name',
    );
  });

  it('emits `pnpm install` (not bare `pnpm add`) when packages is empty', async () => {
    spawnStreamMock.mockClear();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-pnpm-empty-'));
    try {
      await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
      await installTool.execute({}, makeCtx({ cwd: dir, projectRoot: dir }), makeOpts());
      const call = spawnStreamMock.mock.calls[0]?.[0] as { cmd: string; args: string[] };
      expect(call.cmd).toBe('pnpm');
      expect(call.args).toContain('install');
      expect(call.args).not.toContain('add');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits `yarn install` (not bare `yarn add`) when packages is empty', async () => {
    spawnStreamMock.mockClear();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-yarn-empty-'));
    try {
      await fs.writeFile(path.join(dir, 'yarn.lock'), '');
      await installTool.execute({}, makeCtx({ cwd: dir, projectRoot: dir }), makeOpts());
      const call = spawnStreamMock.mock.calls[0]?.[0] as { cmd: string; args: string[] };
      expect(call.cmd).toBe('yarn');
      expect(call.args).toContain('install');
      expect(call.args).not.toContain('add');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a yarn dry run instead of running a real `yarn add`', async () => {
    // yarn 1 silently ignores --dry-run: `yarn --dry-run add ms` installed ms
    // and rewrote package.json while the tool reported dry_run: true.
    spawnStreamMock.mockClear();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-yarn-dry-'));
    try {
      await fs.writeFile(path.join(dir, 'yarn.lock'), '');
      await expect(
        installTool.execute(
          { packages: 'ms', dry_run: true },
          makeCtx({ cwd: dir, projectRoot: dir }),
          makeOpts(),
        ),
      ).rejects.toThrow(/dry_run is not supported for yarn/);
      expect(spawnStreamMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('honors save=dev for npm via --save-dev', async () => {
    spawnStreamMock.mockClear();
    await installTool.execute({ packages: 'foo', save: 'dev' }, makeCtx(), makeOpts());
    const call = spawnStreamMock.mock.calls[0]?.[0] as { cmd: string; args: string[] };
    expect(call.cmd).toBe('npm');
    expect(call.args).toContain('--save-dev');
  });

  it('honors save=optional for npm via --save-optional', async () => {
    spawnStreamMock.mockClear();
    await installTool.execute({ packages: 'foo', save: 'optional' }, makeCtx(), makeOpts());
    const call = spawnStreamMock.mock.calls[0]?.[0] as { cmd: string; args: string[] };
    expect(call.args).toContain('--save-optional');
  });

  it('honors save=dev for yarn via --dev on add', async () => {
    spawnStreamMock.mockClear();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-yarn-dev-'));
    try {
      await fs.writeFile(path.join(dir, 'yarn.lock'), '');
      await installTool.execute(
        { packages: 'foo', save: 'dev' },
        makeCtx({ cwd: dir, projectRoot: dir }),
        makeOpts(),
      );
      const call = spawnStreamMock.mock.calls[0]?.[0] as { cmd: string; args: string[] };
      expect(call.cmd).toBe('yarn');
      expect(call.args).toContain('add');
      expect(call.args).toContain('--dev');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('honors save=dev for pnpm via -D on add', async () => {
    spawnStreamMock.mockClear();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-pnpm-dev-'));
    try {
      await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
      await installTool.execute(
        { packages: 'foo', save: 'dev' },
        makeCtx({ cwd: dir, projectRoot: dir }),
        makeOpts(),
      );
      const call = spawnStreamMock.mock.calls[0]?.[0] as { cmd: string; args: string[] };
      expect(call.cmd).toBe('pnpm');
      expect(call.args).toContain('-D');
      expect(call.args).toContain('add');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('builds pnpm add args with a save flag', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-pnpm-'));
    try {
      await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
      const ctx = makeCtx({ cwd: dir, projectRoot: dir });
      await installTool.execute({ packages: 'foo', save: 'dev' }, ctx, makeOpts());
      const call = spawnStreamMock.mock.calls.at(-1)?.[0] as { cmd: string; args: string[] };
      expect(call.cmd).toBe('pnpm');
      expect(call.args).toEqual(expect.arrayContaining(['add', '-D', 'foo']));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('passes save=optional flag', async () => {
    await installTool.execute({ packages: 'foo', save: 'optional' }, makeCtx(), makeOpts());
    const call = spawnStreamMock.mock.calls.at(-1)?.[0] as { cmd: string; args: string[] };
    expect(call.args).toContain('--save-optional');
  });

  it('builds yarn add args', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-yarn-'));
    try {
      await fs.writeFile(path.join(dir, 'yarn.lock'), '');
      const ctx = makeCtx({ cwd: dir, projectRoot: dir });
      await installTool.execute({ packages: 'foo' }, ctx, makeOpts());
      const call = spawnStreamMock.mock.calls.at(-1)?.[0] as { cmd: string; args: string[] };
      expect(call.cmd).toBe('yarn');
      expect(call.args).toEqual(expect.arrayContaining(['add', 'foo']));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does NOT throw when recordPackageAction fails (best-effort)', async () => {
    vi.mocked(Core.recordPackageAction).mockRejectedValueOnce(new Error('disk full'));
    const ctx = makeCtx({
      meta: {
        packageTrackerOpts: { storageDir: '/tmp/pkg-test', projectRoot: '/fake' },
      },
      session: { id: 'sess-abc' } as any,
    });
    const result = await installTool.execute({ packages: 'vitest' }, ctx, makeOpts());
    expect(result.packages).toContain('vitest');
    expect(Core.recordPackageAction).toHaveBeenCalled();
  });

  // ── Lifecycle script gate (default --ignore-scripts) ──────────────────────
  //
  // Lifecycle scripts (`preinstall` / `install` / `postinstall` / `prepare`)
  // run with shell access inside the project. Without the gate a typo-squatted
  // or compromised package executes arbitrary code the moment it lands in
  // node_modules. The default must therefore pass --ignore-scripts to all
  // three package managers, and an explicit lifecycleScripts: true is the
  // only way to opt back in.

  it('passes --ignore-scripts by default to npm', async () => {
    spawnStreamMock.mockClear();
    await installTool.execute({ packages: 'vitest' }, makeCtx(), makeOpts());
    expect(spawnStreamMock).toHaveBeenCalledTimes(1);
    const call = spawnStreamMock.mock.calls[0]?.[0] as { cmd: string; args: string[] };
    expect(call.cmd).toBe('npm');
    expect(call.args).toContain('--ignore-scripts');
  });

  it('passes --ignore-scripts by default to pnpm', async () => {
    spawnStreamMock.mockClear();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-pnpm-ignore-'));
    try {
      await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
      await installTool.execute(
        { packages: 'foo' },
        makeCtx({ cwd: dir, projectRoot: dir }),
        makeOpts(),
      );
      const call = spawnStreamMock.mock.calls[0]?.[0] as { cmd: string; args: string[] };
      expect(call.cmd).toBe('pnpm');
      expect(call.args).toContain('--ignore-scripts');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('passes --ignore-scripts by default to yarn', async () => {
    spawnStreamMock.mockClear();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-yarn-ignore-'));
    try {
      await fs.writeFile(path.join(dir, 'yarn.lock'), '');
      await installTool.execute(
        { packages: 'foo' },
        makeCtx({ cwd: dir, projectRoot: dir }),
        makeOpts(),
      );
      const call = spawnStreamMock.mock.calls[0]?.[0] as { cmd: string; args: string[] };
      expect(call.cmd).toBe('yarn');
      expect(call.args).toContain('--ignore-scripts');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('omits --ignore-scripts when lifecycleScripts: true is explicit', async () => {
    spawnStreamMock.mockClear();
    await installTool.execute(
      { packages: 'vitest', lifecycleScripts: true },
      makeCtx(),
      makeOpts(),
    );
    const call = spawnStreamMock.mock.calls[0]?.[0] as { cmd: string; args: string[] };
    expect(call.args).not.toContain('--ignore-scripts');
  });

  it('omits --ignore-scripts when lifecycleScripts: false is explicit (no change from default)', async () => {
    spawnStreamMock.mockClear();
    await installTool.execute(
      { packages: 'vitest', lifecycleScripts: false },
      makeCtx(),
      makeOpts(),
    );
    const call = spawnStreamMock.mock.calls[0]?.[0] as { cmd: string; args: string[] };
    expect(call.args).toContain('--ignore-scripts');
  });

  // Yarn 2+ (Berry) has no `--ignore-scripts`: real yarn 4.5.3 answers
  // `Unknown Syntax Error: Unsupported option name ("--ignore-scripts").` and
  // exits 1, so the scripts-off default must use `--mode=skip-build` instead.
  describe('yarn 2+ lifecycle-script opt-out', () => {
    const yarnArgs = async (files: Record<string, string>, input: Record<string, unknown>) => {
      spawnStreamMock.mockClear();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-yarn-berry-'));
      try {
        for (const [name, content] of Object.entries(files)) {
          await fs.writeFile(path.join(dir, name), content);
        }
        await installTool.execute(input, makeCtx({ cwd: dir, projectRoot: dir }), makeOpts());
        const call = spawnStreamMock.mock.calls[0]?.[0] as { cmd: string; args: string[] };
        expect(call.cmd).toBe('yarn');
        return call.args;
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    };
    const berryManifest = JSON.stringify({ name: 'b', packageManager: 'yarn@4.5.3' });

    it('uses --mode=skip-build after the subcommand when packageManager declares yarn@4', async () => {
      const args = await yarnArgs({ 'package.json': berryManifest, 'yarn.lock': '' }, {});
      expect(args).toEqual(['install', '--mode=skip-build']);
    });

    it('applies the same opt-out to `yarn add`, keeping --dev', async () => {
      const args = await yarnArgs(
        { 'package.json': berryManifest, 'yarn.lock': '' },
        { packages: 'is-odd', save: 'dev' },
      );
      expect(args).toEqual(['add', '--dev', '--mode=skip-build', 'is-odd']);
    });

    it('treats a .yarnrc.yml as Berry when no packageManager is declared', async () => {
      const args = await yarnArgs(
        { 'package.json': '{}', '.yarnrc.yml': 'nodeLinker: node-modules\n', 'yarn.lock': '' },
        { packages: 'is-odd' },
      );
      expect(args).toEqual(['add', '--mode=skip-build', 'is-odd']);
    });

    it('keeps --ignore-scripts for a declared yarn@1 project', async () => {
      const args = await yarnArgs(
        { 'package.json': JSON.stringify({ packageManager: 'yarn@1.22.22' }), 'yarn.lock': '' },
        { packages: 'is-odd' },
      );
      expect(args).toEqual(['--ignore-scripts', 'add', 'is-odd']);
    });

    it('passes neither flag on Berry when lifecycleScripts: true', async () => {
      const args = await yarnArgs(
        { 'package.json': berryManifest, 'yarn.lock': '' },
        { lifecycleScripts: true },
      );
      expect(args).toEqual(['install']);
    });
  });

  it('executes cleanly when opts parameter is omitted and session is undefined', async () => {
    spawnStreamMock.mockClear();
    const minimalCtx = { cwd: '.', projectRoot: '.' } as any;
    const result = await (installTool.execute as any)({ dry_run: true }, minimalCtx);
    expect(result.exit_code).toBe(0);
    expect(result.dry_run).toBe(true);
  });
});

// An approval stored for the default install (scripts off, project-local) used
// to cover the same packages with lifecycleScripts:true or global:true too —
// the subject was only `packages`.
describe('installTool permission subject', () => {
  const subject = (input: Record<string, unknown>) =>
    subjectForToolInput(installTool.name, input, installTool.subjectKey, installTool.subjectFields);

  it('keeps the default install subject unchanged', () => {
    expect(subject({ packages: 'esbuild' })).toBe('esbuild');
    expect(subject({ packages: 'esbuild', lifecycleScripts: false, global: false })).toBe(
      'esbuild',
    );
  });

  it('does not let a default approval cover running lifecycle scripts', () => {
    const scripts = subject({ packages: 'esbuild', lifecycleScripts: true });
    expect(scripts).toBe('esbuild lifecycleScripts=true');
    expect(scripts).not.toBe(subject({ packages: 'esbuild' }));
  });

  it('does not let a default approval cover a global install', () => {
    const global = subject({ packages: 'esbuild', global: true });
    expect(global).toBe('esbuild global=true');
    expect(global).not.toBe(subject({ packages: 'esbuild' }));
  });

  it('keeps the dry-run suffix distinct from the real call', () => {
    expect(subject({ packages: 'esbuild', dry_run: true, lifecycleScripts: true })).toBe(
      'esbuild lifecycleScripts=true:dry-run',
    );
  });

  it('renders a restore-everything opt-in without a stray separator', () => {
    expect(subject({ packages: '', lifecycleScripts: true })).toBe('lifecycleScripts=true');
  });
});

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { installTool } from '../src/install.js';
import * as Core from '@wrongstack/core/coordination';
import type { SpawnStreamResult } from '../src/_spawn-stream.js';
import type { ToolProgressEvent } from '@wrongstack/core/types';

// Mock spawnStream — an AsyncGenerator<ToolProgressEvent, SpawnStreamResult>.
// executeStream calls: const result = yield* spawnStream({...})
//
// Exported as a hoisted vi.fn so individual tests can inspect the args
// (cmd/args) that installTool constructed for the package-manager call.
const spawnStreamMock = vi.hoisted(() => vi.fn());
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

  it('passes save=dev flag', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'foo', save: 'dev' }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('passes global flag', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'foo', global: true }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('respects dry_run', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'foo', dry_run: true }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
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

  it('rejects an invalid package name (flag injection guard)', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: '--ignore-scripts' }, ctx, makeOpts());
    expect(result.exit_code).toBe(1);
    expect(result.output).toContain('Invalid package name');
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

  it.each(['file:../../etc/passwd', 'pkg@1.0.0; rm -rf /', 'pkg@1.0.0 --flag', 'pkg@ver$(whoami)'])(
    'still rejects malicious spec %s',
    async (spec) => {
      const result = await installTool.execute({ packages: spec }, makeCtx(), makeOpts());
      expect(result.exit_code).toBe(1);
      expect(result.output).toContain('Invalid package name');
    },
  );

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
      const result = await installTool.execute({ packages: 'foo', save: 'dev' }, ctx, makeOpts());
      expect(result).toHaveProperty('exit_code');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('passes save=optional flag', async () => {
    const result = await installTool.execute(
      { packages: 'foo', save: 'optional' },
      makeCtx(),
      makeOpts(),
    );
    expect(result).toHaveProperty('exit_code');
  });

  it('builds yarn add args', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inst-yarn-'));
    try {
      await fs.writeFile(path.join(dir, 'yarn.lock'), '');
      const ctx = makeCtx({ cwd: dir, projectRoot: dir });
      const result = await installTool.execute({ packages: 'foo' }, ctx, makeOpts());
      expect(result).toHaveProperty('exit_code');
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

  it('executes cleanly when opts parameter is omitted and session is undefined', async () => {
    spawnStreamMock.mockClear();
    const minimalCtx = { cwd: '.', projectRoot: '.' } as any;
    const result = await (installTool.execute as any)({ dry_run: true }, minimalCtx);
    expect(result.exit_code).toBe(0);
    expect(result.dry_run).toBe(true);
  });
});

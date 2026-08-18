import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateMocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../src/update-check.js', () => ({
  checkForUpdate: updateMocks.checkForUpdate,
}));

vi.mock('node:child_process', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spawn: (...args: unknown[]) => updateMocks.spawn(...args),
  };
});

import { parseArgs } from '../src/arg-parser.js';
import {
  detectUpdatePackageManager,
  detectUpdatePackageName,
  updateCmd,
} from '../src/subcommands/handlers/update.js';

let writes: string[];
let deps: Parameters<typeof updateCmd>[1];

beforeEach(() => {
  writes = [];
  updateMocks.checkForUpdate.mockReset();
  updateMocks.spawn.mockReset();
  vi.stubEnv('WRONGSTACK_UPDATE_PM', 'npm');
  deps = {
    cwd: '/tmp',
    renderer: {
      write: (s: string) => {
        writes.push(s);
      },
    },
  } as never;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function makeFakeChild(
  exitCode: number | null,
  errOnSpawn?: Error,
  stderrChunks: string[] = [],
  signal: NodeJS.Signals | null = null,
) {
  const ee = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter | null;
    stdout: EventEmitter | null;
  };
  ee.stderr = new EventEmitter();
  ee.stdout = new EventEmitter();
  setImmediate(() => {
    if (errOnSpawn) {
      ee.emit('error', errOnSpawn);
      return;
    }
    for (const c of stderrChunks) ee.stderr?.emit('data', Buffer.from(c));
    ee.emit('close', exitCode, signal);
  });
  return ee;
}

function expectSpawned(pm: 'npm' | 'pnpm' | 'yarn' | 'bun', args: string[]): void {
  if (process.platform === 'win32') {
    const [executable, actualArgs, options] = updateMocks.spawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    if (executable === (process.env['COMSPEC'] ?? 'cmd.exe')) {
      expect(actualArgs.slice(0, 2)).toEqual(['/d', '/c']);
      expect(actualArgs[2]).toMatch(/^call "/);
      for (const arg of args) expect(actualArgs[2]).toContain(`"${arg}"`);
      expect(options).toMatchObject({ cwd: '/tmp', stdio: 'pipe', windowsVerbatimArguments: true });
    } else {
      expect(actualArgs).toEqual(args);
      expect(options).toMatchObject({ cwd: '/tmp', stdio: 'pipe' });
    }
    return;
  }
  expect(updateMocks.spawn).toHaveBeenCalledWith(
    pm,
    args,
    expect.objectContaining({ cwd: '/tmp', stdio: 'pipe' }),
  );
}

describe('updateCmd subcommand', () => {
  it('--check-only on outdated prints "Update available"', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
    });
    const code = await updateCmd(['--check-only'], deps);
    expect(code).toBe(0);
    expect(writes.join('')).toContain('Update available: v1.0.0 → v1.2.3');
    expect(updateMocks.spawn).not.toHaveBeenCalled();
  });

  it('--check-only on up-to-date prints latest message', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: false,
      current: '2.0.0',
      latest: '2.0.0',
    });
    const code = await updateCmd(['--check-only'], deps);
    expect(code).toBe(0);
    expect(writes.join('')).toContain('You are on the latest version: v2.0.0');
  });

  it('-c is an alias for --check-only', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: false,
      current: '1.0.0',
      latest: '1.0.0',
    });
    await updateCmd(['-c'], deps);
    expect(writes.join('')).toContain('You are on the latest version');
    expect(updateMocks.spawn).not.toHaveBeenCalled();
  });

  it('when already latest, returns 0 without spawning npm', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: false,
      current: '1.0.0',
      latest: '1.0.0',
    });
    const code = await updateCmd([], deps);
    expect(code).toBe(0);
    expect(writes.join('')).toContain('already on the latest version');
    expect(updateMocks.spawn).not.toHaveBeenCalled();
  });

  it('runs npm install -g --ignore-scripts wrongstack@1.2.3 by default', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
    });
    updateMocks.spawn.mockReturnValue(makeFakeChild(0));
    const code = await updateCmd([], deps);
    expect(code).toBe(0);
    expectSpawned('npm', ['install', '-g', '--ignore-scripts', 'wrongstack@1.2.3']);
    const out = writes.join('');
    expect(out).toContain('Updating wrongstack from v1.0.0 to v1.2.3');
    expect(out).toContain('Updated to v1.2.3');
  });

  it('omits --ignore-scripts when --allow-scripts is passed', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
    });
    updateMocks.spawn.mockReturnValue(makeFakeChild(0));
    const code = await updateCmd(['--allow-scripts'], deps);
    expect(code).toBe(0);
    expectSpawned('npm', ['install', '-g', 'wrongstack@1.2.3']);
  });

  it('runs the selected package manager when --pm is provided (with --ignore-scripts)', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
    });
    updateMocks.spawn.mockReturnValue(makeFakeChild(0));
    const code = await updateCmd(['--pm', 'pnpm'], deps);
    expect(code).toBe(0);
    expectSpawned('pnpm', ['add', '-g', '--ignore-scripts', 'wrongstack@1.2.3']);
    expect(writes.join('')).toContain('Running: pnpm add -g --ignore-scripts wrongstack@1.2.3');
  });

  it.each([
    { pm: 'yarn', argv: ['global', 'add', '--ignore-scripts', 'wrongstack@1.2.3'] },
    { pm: 'bun', argv: ['add', '-g', '--ignore-scripts', 'wrongstack@1.2.3'] },
  ] as const)('passes --ignore-scripts to $pm global add', async ({ pm, argv }) => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
    });
    updateMocks.spawn.mockReturnValue(makeFakeChild(0));
    // On win32 the handler resolves the manager against the real PATH unless
    // the environment seam is set, which would require yarn and bun to be
    // installed on the host. Stub both executables instead.
    const stubBin =
      process.platform === 'win32'
        ? mkdtempSync(path.join(tmpdir(), 'wrongstack-update-pm-'))
        : undefined;
    try {
      if (stubBin) {
        writeFileSync(path.join(stubBin, 'yarn.CMD'), '@echo yarn');
        writeFileSync(path.join(stubBin, 'bun.EXE'), 'stub');
        (deps as unknown as { environment: NodeJS.ProcessEnv }).environment = {
          Path: stubBin,
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
        };
      }
      const code = await updateCmd(['--pm', pm], deps);
      expect(code).toBe(0);
      expectSpawned(pm, [...argv]);
    } finally {
      if (stubBin) rmSync(stubBin, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('prints help without checking or installing', async () => {
    deps.flags = { help: true };

    expect(await updateCmd([], deps)).toBe(0);
    expect(writes.join('')).toContain('Usage: wrongstack update');
    expect(updateMocks.checkForUpdate).not.toHaveBeenCalled();
    expect(updateMocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects unknown update flags before checking or installing', async () => {
    deps.flags = { typo: true };

    expect(await updateCmd([], deps)).toBe(1);
    expect(writes.join('')).toContain('Unknown update option: --typo');
    expect(updateMocks.checkForUpdate).not.toHaveBeenCalled();
    expect(updateMocks.spawn).not.toHaveBeenCalled();
  });

  it('rehydrates --check-only from real top-level parser flags and never installs', async () => {
    const parsed = parseArgs(['update', '--check-only']);
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
      checkFailed: false,
    });
    deps.flags = parsed.flags;

    const code = await updateCmd(parsed.positional.slice(1), deps);

    expect(code).toBe(0);
    expect(writes.join('')).toContain('Update available');
    expect(updateMocks.spawn).not.toHaveBeenCalled();
  });

  it('rehydrates --pm and --allow-scripts from real top-level parser flags', async () => {
    const parsed = parseArgs(['update', '--pm', 'pnpm', '--allow-scripts']);
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
      checkFailed: false,
    });
    updateMocks.spawn.mockReturnValue(makeFakeChild(0));
    deps.flags = parsed.flags;

    expect(await updateCmd(parsed.positional.slice(1), deps)).toBe(0);
    expectSpawned('pnpm', ['add', '-g', 'wrongstack@1.2.3']);
  });

  it('rejects an invalid --pm value before checking for updates', async () => {
    const code = await updateCmd(['--pm', 'pip'], deps);
    expect(code).toBe(1);
    expect(writes.join('')).toContain('Invalid package manager: pip');
    expect(updateMocks.checkForUpdate).not.toHaveBeenCalled();
    expect(updateMocks.spawn).not.toHaveBeenCalled();
  });

  it('fails closed when the registry check fails', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: false,
      current: '1.0.0',
      latest: '1.0.0',
      checkFailed: true,
    });

    expect(await updateCmd([], deps)).toBe(1);
    expect(writes.join('')).toContain('Update check failed');
    expect(writes.join('')).not.toContain('latest version');
    expect(updateMocks.spawn).not.toHaveBeenCalled();
  });

  it('reports failure when npm exits non-zero', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
    });
    updateMocks.spawn.mockReturnValue(makeFakeChild(2, undefined, ['npm err\n']));
    const code = await updateCmd([], deps);
    expect(code).toBe(2);
    expect(writes.join('')).toContain('Update failed with exit code 2');
  });

  it('surfaces npm stderr and package-manager guidance on failure (#13)', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
    });
    // Exit 243 with a real reason in stderr — previously discarded, leaving the
    // user with only the opaque code.
    updateMocks.spawn.mockReturnValue(
      makeFakeChild(243, undefined, [
        'npm error code EACCES\n',
        'npm error EACCES: permission denied\n',
      ]),
    );
    const code = await updateCmd([], deps);
    expect(code).toBe(243);
    const out = writes.join('');
    expect(out).toContain('Update failed with exit code 243');
    // The underlying npm reason is now shown.
    expect(out).toContain('EACCES: permission denied');
    // And the alternative package managers are offered.
    expect(out).toContain('pnpm add -g --ignore-scripts wrongstack@1.2.3');
    expect(out).toContain('yarn global add --ignore-scripts wrongstack@1.2.3');
    expect(out).toContain('bun add -g --ignore-scripts wrongstack@1.2.3');
  });

  it('explains Windows native-file locks without relying on a user-specific path', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
    });
    updateMocks.spawn.mockReturnValue(
      makeFakeChild(1, undefined, [
        'npm error code EBUSY\n',
        'npm error EBUSY: resource busy or locked, copyfile .wrongstack-staging\\electron.exe\n',
      ]),
    );

    expect(await updateCmd([], deps)).toBe(1);
    const out = writes.join('');
    if (process.platform === 'win32') {
      expect(out).toContain('native file held by a running WrongStack process');
      expect(out).toContain('Stop any WrongStack WebUI, Desktop, or background process');
      expect(out).not.toMatch(/Users\\|AppData\\|PID \d+/);
    } else {
      expect(out).not.toContain('native file held by a running WrongStack process');
    }
  });

  it('treats signal-only child termination as failure', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
      checkFailed: false,
    });
    updateMocks.spawn.mockReturnValue(makeFakeChild(null, undefined, [], 'SIGTERM'));

    expect(await updateCmd([], deps)).toBe(1);
    expect(writes.join('')).toContain('Update terminated by SIGTERM');
    expect(writes.join('')).not.toContain('Updated to');
  });

  it('handles ENOENT (npm not installed)', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
    });
    updateMocks.spawn.mockImplementation(() => {
      throw new Error('spawn npm ENOENT');
    });
    const code = await updateCmd([], deps);
    expect(code).toBe(1);
    expect(writes.join('')).toContain('npm not found in PATH');
  });

  it('reports generic error string when spawn throws non-ENOENT', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
    });
    updateMocks.spawn.mockImplementation(() => {
      throw 'boom';
    });
    const code = await updateCmd([], deps);
    expect(code).toBe(1);
    expect(writes.join('')).toContain('Update failed: boom');
  });
});

describe('detectUpdatePackageName', () => {
  it('detects the direct CLI package and defaults to the umbrella package', () => {
    expect(
      detectUpdatePackageName(['node', 'C:\\x\\node_modules\\@wrongstack\\cli\\dist\\index.js']),
    ).toBe('@wrongstack/cli');
    expect(
      detectUpdatePackageName(['node', 'C:\\x\\node_modules\\wrongstack\\src\\index.js']),
    ).toBe('wrongstack');
  });
});

describe('detectUpdatePackageManager', () => {
  it('uses WRONGSTACK_UPDATE_PM when present', () => {
    expect(detectUpdatePackageManager({ WRONGSTACK_UPDATE_PM: 'pnpm' }, [])).toBe('pnpm');
  });

  it('detects package managers from npm_config_user_agent', () => {
    expect(
      detectUpdatePackageManager({ npm_config_user_agent: 'pnpm/11.5.3 npm/? node/v24' }, []),
    ).toBe('pnpm');
    expect(
      detectUpdatePackageManager({ npm_config_user_agent: 'yarn/1.22.22 npm/? node/v24' }, []),
    ).toBe('yarn');
    expect(
      detectUpdatePackageManager({ npm_config_user_agent: 'bun/1.2.0 npm/? node/v24' }, []),
    ).toBe('bun');
  });
});

describe('Windows package-manager resolution', () => {
  it('skips a project-local npm.cmd shim and invokes an external executable', async () => {
    if (process.platform !== 'win32') return;
    const root = mkdtempSync(path.join(tmpdir(), 'wrongstack-update-'));
    const projectDir = path.join(root, 'project');
    const projectBin = path.join(projectDir, 'node_modules', '.bin');
    const globalBin = path.join(root, 'global-bin');
    const externalNpm = path.join(globalBin, 'npm.CMD');
    try {
      mkdirSync(projectBin, { recursive: true });
      mkdirSync(globalBin, { recursive: true });
      writeFileSync(path.join(projectBin, 'npm.CMD'), '@echo broken');
      writeFileSync(externalNpm, '@echo external');
      deps.cwd = projectDir;
      (deps as unknown as { environment: NodeJS.ProcessEnv }).environment = {
        Path: `${projectBin};${globalBin}`,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      };
      updateMocks.checkForUpdate.mockResolvedValue({
        outdated: true,
        current: '1.0.0',
        latest: '1.2.3',
      });
      updateMocks.spawn.mockReturnValue(makeFakeChild(0));

      expect(await updateCmd([], deps)).toBe(0);
      const [, args] = updateMocks.spawn.mock.calls[0] as [string, string[]];
      expect(args[2]).toContain(`"${externalNpm}"`);
      expect(args[2]).not.toContain(`"${path.join(projectBin, 'npm.CMD')}"`);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

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

import { updateCmd } from '../src/subcommands/handlers/update.js';

let writes: string[];
let deps: Parameters<typeof updateCmd>[1];

beforeEach(() => {
  writes = [];
  updateMocks.checkForUpdate.mockReset();
  updateMocks.spawn.mockReset();
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
  vi.restoreAllMocks();
});

function makeFakeChild(exitCode: number | null, errOnSpawn?: Error, stderrChunks: string[] = []) {
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
    ee.emit('close', exitCode);
  });
  return ee;
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

  it('runs npm install -g wrongstack@latest and reports success', async () => {
    updateMocks.checkForUpdate.mockResolvedValue({
      outdated: true,
      current: '1.0.0',
      latest: '1.2.3',
    });
    updateMocks.spawn.mockReturnValue(makeFakeChild(0));
    const code = await updateCmd([], deps);
    expect(code).toBe(0);
    expect(updateMocks.spawn).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '-g', 'wrongstack@latest'],
      expect.objectContaining({ cwd: '/tmp', stdio: 'pipe' }),
    );
    const out = writes.join('');
    expect(out).toContain('Updating wrongstack from v1.0.0 to v1.2.3');
    expect(out).toContain('Updated to v1.2.3');
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
      makeFakeChild(243, undefined, ['npm error code EACCES\n', 'npm error EACCES: permission denied\n']),
    );
    const code = await updateCmd([], deps);
    expect(code).toBe(243);
    const out = writes.join('');
    expect(out).toContain('Update failed with exit code 243');
    // The underlying npm reason is now shown.
    expect(out).toContain('EACCES: permission denied');
    // And the alternative package managers are offered.
    expect(out).toContain('pnpm add -g wrongstack@latest');
    expect(out).toContain('yarn global add wrongstack@latest');
    expect(out).toContain('bun  add -g wrongstack@latest');
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

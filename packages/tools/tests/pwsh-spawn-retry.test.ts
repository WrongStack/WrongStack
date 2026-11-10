import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pwshTool } from '../src/pwsh.js';
import { mkSandbox, newSignal } from './fixtures.js';

// A Microsoft Store PowerShell is an app execution alias; CreateProcess on it
// intermittently fails with EPERM while other alias launches are in flight
// and succeeds when repeated. The mocked spawn() throws that EPERM for the
// first `epermThrows` calls, then hands back a child that prints and exits 0.
const hoisted = vi.hoisted(() => ({
  epermThrows: 0,
  spawnCalls: 0,
  makeError: (): Error =>
    Object.assign(new Error('spawn EPERM'), { code: 'EPERM', syscall: 'spawn' }),
}));

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, default: actual, platform: () => 'win32' as NodeJS.Platform };
});

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  const spawn = () => {
    hoisted.spawnCalls++;
    if (hoisted.spawnCalls <= hoisted.epermThrows) {
      throw hoisted.makeError();
    }
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null as number | null,
      killed: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
      unref: () => {},
    });
    setImmediate(() => {
      child.stdout.end('spawned-after-eperm\n');
      child.stderr.end();
      child.exitCode = 0;
      child.emit('close', 0, null);
    });
    return child;
  };
  return { ...actual, default: { ...actual, spawn }, spawn };
});

const epermError = hoisted.makeError;
afterEach(() => {
  hoisted.epermThrows = 0;
  hoisted.spawnCalls = 0;
  hoisted.makeError = epermError;
});

describe('pwsh spawn EPERM retry (Store app execution alias)', () => {
  it('retries a transient synchronous EPERM and runs the command', async () => {
    hoisted.epermThrows = 2;
    const sb = await mkSandbox();
    try {
      const out = await pwshTool.execute({ command: 'Write-Output "x"' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(hoisted.spawnCalls).toBe(3);
      expect(out.exit_code).toBe(0);
      expect(out.output).toContain('spawned-after-eperm');
    } finally {
      await sb.cleanup();
    }
  });

  it('retries the same denial when libuv leaves it untranslated (0xC0070005)', async () => {
    // Seen on a loaded Windows host: "spawn Unknown system error -1073283067".
    hoisted.makeError = () =>
      Object.assign(new Error('spawn Unknown system error -1073283067'), {
        errno: -1073283067,
        code: 'Unknown system error -1073283067',
        syscall: 'spawn',
      });
    hoisted.epermThrows = 1;
    const sb = await mkSandbox();
    try {
      const out = await pwshTool.execute({ command: 'Write-Output "x"' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(hoisted.spawnCalls).toBe(2);
      expect(out.exit_code).toBe(0);
    } finally {
      await sb.cleanup();
    }
  });

  it('still throws once the EPERM outlasts the retries', async () => {
    hoisted.epermThrows = Number.POSITIVE_INFINITY;
    const sb = await mkSandbox();
    try {
      await expect(
        pwshTool.execute({ command: 'Write-Output "x"' }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow(/^pwsh: spawn failed: spawn EPERM/);
      expect(hoisted.spawnCalls).toBe(4);
    } finally {
      await sb.cleanup();
    }
  });
});

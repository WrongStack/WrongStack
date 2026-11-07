import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pwshTool } from '../src/pwsh.js';
import { mkSandbox, newSignal } from './fixtures.js';

// A Microsoft Store PowerShell is an app execution alias; CreateProcess on it
// intermittently fails with EPERM while other alias launches are in flight
// and succeeds when repeated. The mocked spawn() throws that EPERM for the
// first `epermThrows` calls, then hands back a child that prints and exits 0.
const hoisted = vi.hoisted(() => ({ epermThrows: 0, spawnCalls: 0 }));

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, default: actual, platform: () => 'win32' as NodeJS.Platform };
});

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  const spawn = () => {
    hoisted.spawnCalls++;
    if (hoisted.spawnCalls <= hoisted.epermThrows) {
      throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM', syscall: 'spawn' });
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

afterEach(() => {
  hoisted.epermThrows = 0;
  hoisted.spawnCalls = 0;
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

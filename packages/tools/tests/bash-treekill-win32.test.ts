import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bashTool } from '../src/bash.js';
import { mkSandbox, newSignal } from './fixtures.js';
import { runtimeFixtureCommand } from './shell-fixture-command.js';

const isWin = process.platform === 'win32';

function runtimeProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission failures are not evidence that the process exited.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

function killMarkedProcesses(marker: string): void {
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "name='node.exe' OR name='bun.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 },
  );
}

/**
 * Regression test for the host-OOM / hang chain on Windows:
 *
 * bash spawns `cmd.exe /c <command>`; the real command (node, vitest, dev
 * server) is a *grandchild*. A plain `child.kill()` on timeout terminated
 * only cmd.exe — the grandchild survived, kept the inherited stdio pipes
 * open (so 'close' never fired and the tool hung), and kept streaming into
 * the host's data handlers, growing `pending`/`queue` until the host
 * process ran out of heap. The fix tree-kills via `taskkill /T /F`.
 */
describe.runIf(isWin)('bash win32 tree kill', () => {
  it('kills the grandchild Bun process when a command times out', async () => {
    const marker = `wstack_orphan_${process.pid}_${Date.now()}`;
    const sb = await mkSandbox();
    const script = path.join(sb.dir, 'spin.js');
    fs.writeFileSync(
      script,
      "require('node:fs').writeFileSync('spin-ready', String(process.pid)); setInterval(() => console.log('tick'), 200);\n",
    );
    let childExited = false;
    try {
      const out = await bashTool.execute(
        {
          command: runtimeFixtureCommand(script, [marker]),
          timeout_ms: 1500,
        },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.timed_out).toBe(true);

      // A timed-out parse error is not evidence that a real child was reaped.
      const pid = Number(fs.readFileSync(path.join(sb.dir, 'spin-ready'), 'utf8'));
      expect(Number.isInteger(pid) && pid > 1).toBe(true);
      // Probe the exact fixture PID. Enumerating every runtime process via
      // synchronous CIM queries can itself exceed the test timeout under load.
      await vi.waitFor(() => expect(runtimeProcessIsAlive(pid)).toBe(false), {
        timeout: 5000,
        interval: 100,
      });
      childExited = true;
    } finally {
      if (!childExited) killMarkedProcesses(marker);
      await sb.cleanup();
    }
  }, 20_000);
});

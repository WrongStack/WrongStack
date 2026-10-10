import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { bashTool } from '../src/bash.js';

const isWin = process.platform === 'win32';

function mkCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-treekill-'));
  return {
    cwd: dir,
    projectRoot: dir,
    workingDir: dir,
    session: undefined,
  };
}

function findRuntimeProcessesWithMarker(marker: string): string[] {
  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "name='node.exe' OR name='bun.exe'" | Select-Object -ExpandProperty CommandLine`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return (ps.stdout ?? '').split('\n').filter((l) => l.includes(marker));
}

function killMarkedProcesses(marker: string): void {
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "name='node.exe' OR name='bun.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ],
    { encoding: 'utf8', windowsHide: true },
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
    const ctx = mkCtx();
    const script = path.join(ctx.projectRoot, 'spin.js');
    fs.writeFileSync(script, `setInterval(() => console.log('tick'), 200);\n`);
    try {
      const out = await bashTool.execute(
        { command: `"${process.execPath}" "${script}" ${marker}`, timeout_ms: 1500 },
        ctx as never,
        { signal: new AbortController().signal },
      );
      expect(out.timed_out).toBe(true);

      // Give taskkill a moment to finish reaping the tree.
      await new Promise((r) => setTimeout(r, 2500));

      const orphans = findRuntimeProcessesWithMarker(marker);
      if (orphans.length > 0) {
        // Clean up so a failed assertion doesn't leave the orphan running.
        killMarkedProcesses(marker);
      }
      expect(orphans).toEqual([]);
    } finally {
      killMarkedProcesses(marker);
      await removeProjectFixtureDirectory(ctx.projectRoot);
    }
  }, 20_000);
});

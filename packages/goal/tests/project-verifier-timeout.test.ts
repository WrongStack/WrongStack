import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyGoalProject } from '../src/project-verifier.js';

import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';

// A real cmd.exe shim tree: `pnpm.cmd` -> node script that records its pid and
// hangs. The step timeout must take the script down, not just cmd.exe.
describe.skipIf(process.platform !== 'win32')('verifyGoalProject step timeout', () => {
  let dir: string;
  let bin: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-verifier-timeout-'));
    bin = path.join(dir, 'bin');
    await fs.mkdir(bin);
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc' } }),
    );
    await fs.writeFile(
      path.join(bin, 'hang.cjs'),
      "require('node:fs').writeFileSync('hang.pid', String(process.pid)); setInterval(() => {}, 1000);",
    );
    // npm's cmd-shim spelling: `%~dp0` is wrong for a quoted call without CALL :label.
    await fs.writeFile(
      path.join(bin, 'pnpm.cmd'),
      '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nCALL :find_dp0\r\nnode "%dp0%hang.cjs" %*\r\n',
    );
    savedPath = process.env['PATH'];
    process.env['PATH'] = `${bin};${savedPath ?? ''}`;
  });

  afterEach(async () => {
    process.env['PATH'] = savedPath;
    await removeProjectFixtureDirectory(dir, { maxRetries: 10, retryDelay: 100 });
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('fails the step and tears down the hung script tree', async () => {
    const result = await verifyGoalProject({ cwd: dir, steps: ['typecheck'], timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    const pid = Number(await fs.readFile(path.join(dir, 'hang.pid'), 'utf8'));
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const leaked = alive(pid);
    if (leaked) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    expect(leaked).toBe(false);
  }, 20_000);
});

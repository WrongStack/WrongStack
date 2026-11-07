import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WIN32_TREE_KILL_BUDGET_MS } from '@wrongstack/core/utils/tree-kill';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeProjectFixtureDirectorySync } from '../../core/tests/helpers/project-server-harness.js';
import { runRunnerCommand } from '../src/runtime/index.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-exec-tree-'));
});
afterEach(() => {
  removeProjectFixtureDirectorySync(root, { maxRetries: 10, retryDelay: 100 });
});

const opts = (extra: Record<string, unknown> = {}) =>
  ({ cwd: root, projectRoot: root, timeoutMs: 20_000, ...extra }) as never;

describe('runRunnerCommand process lifecycle', () => {
  it('reports a missing executable as a spawn error, not exit 1', async () => {
    const result = await runRunnerCommand(['ws-no-such-binary-xyz'], opts());
    expect(result.spawnError).toBe(true);
    expect(result.code).toBe(127);
  });

  describe.skipIf(process.platform !== 'win32')('behind the cmd.exe shim', () => {
    const lifecycleDeadlineMs = WIN32_TREE_KILL_BUDGET_MS + 20_000;
    let savedPath: string | undefined;
    beforeEach(() => {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, 'hang.cjs'),
        "require('node:fs').writeFileSync('hang.pid', String(process.pid)); setInterval(() => {}, 1000);",
      );
      // npm cmd-shim spelling: `%~dp0` is wrong for a quoted call without CALL :label.
      fs.writeFileSync(
        path.join(bin, 'pnpm.cmd'),
        '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nCALL :find_dp0\r\nnode "%dp0%hang.cjs" %*\r\n',
      );
      savedPath = process.env['PATH'];
      process.env['PATH'] = `${bin};${savedPath ?? ''}`;
    });
    afterEach(() => {
      process.env['PATH'] = savedPath;
    });

    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const expectGone = async (): Promise<void> => {
      const pid = Number(fs.readFileSync(path.join(root, 'hang.pid'), 'utf8'));
      const deadline = Date.now() + 5000;
      while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      const leaked = alive(pid);
      if (leaked) process.kill(pid);
      expect(leaked).toBe(false);
    };

    it(
      'kills the program, not just cmd.exe, at the timeout',
      async () => {
        const result = await runRunnerCommand(['pnpm', 'dev'], opts({ timeoutMs: 2000 }));
        expect(result.timedOut).toBe(true);
        await expectGone();
      },
      lifecycleDeadlineMs,
    );

    it(
      'kills the program, not just cmd.exe, on abort',
      async () => {
        const controller = new AbortController();
        const pending = runRunnerCommand(['pnpm', 'dev'], opts({ signal: controller.signal }));
        const pidFile = path.join(root, 'hang.pid');
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(pidFile) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        controller.abort();
        expect((await pending).timedOut).toBe(true);
        await expectGone();
      },
      lifecycleDeadlineMs,
    );
  });
});

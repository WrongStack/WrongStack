import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));
const treeKillSpy = vi.hoisted(() => vi.fn());
vi.mock('@wrongstack/core/utils/tree-kill', async (importOriginal) => ({
  // Partial: the installer now loads through the runtime, whose process
  // registry reads the module's other exports at import.
  ...(await importOriginal<typeof import('@wrongstack/core/utils/tree-kill')>()),
  treeKill: treeKillSpy,
}));

const { installPluginPackage } = await import('../src/plugin-package-install.js');

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-install-timeout-'));
  execFileMock.mockReset();
  treeKillSpy.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

describe('plugin install package-manager timeout', () => {
  it('kills the whole install tree at the timeout, not just the cmd.exe wrapper', async () => {
    vi.useFakeTimers();
    const child = { stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() } };
    let finish: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    execFileMock.mockImplementation((...args: unknown[]) => {
      finish = args[3] as typeof finish;
      return child;
    });
    const pending = installPluginPackage('some-plugin', ['--pm', 'npm'], {
      config: {} as never,
      configPath: path.join(root, 'config.json'),
      globalRoot: root,
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    await vi.advanceTimersByTimeAsync(300_000);
    // execFile's own `timeout` killed only cmd.exe and left npm installing.
    expect(treeKillSpy).toHaveBeenCalledWith(child);
    expect(child.stdout.destroy).toHaveBeenCalled();
    finish?.(Object.assign(new Error('killed'), { code: 1 }), '', '');
    expect(JSON.stringify(await pending)).toMatch(/failed/);
  });
});

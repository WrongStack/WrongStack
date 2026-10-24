import { resolve } from 'node:path';
import type { PluginAPI, Tool } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: mocks.execFile,
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: () => true,
}));

import plugin from '../src/git-autocommit/index.js';

const hosts: PluginAPI[] = [];
let handle: (args: string[]) => string;
beforeEach(() => {
  handle = (args) => (args.includes('--name-only') && args.includes('--cached') ? 'owned.ts' : '');
  mocks.execFile
    .mockReset()
    .mockImplementation(
      (
        _program: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, output: string) => void,
      ) => {
        try {
          callback(null, handle(args));
        } catch (error) {
          callback(error as Error, '');
        }
        return {};
      },
    );
});
afterEach(async () => {
  for (const api of hosts.splice(0)) await plugin.teardown?.(api);
});
function load() {
  let tool!: Tool;
  const api = {
    config: { cwd: resolve('.temp_files/host-project'), extensions: {} },
    tools: {
      register: (value: Tool) => {
        tool = value;
      },
    },
    log: { info() {}, warn() {}, error() {} },
  } as unknown as PluginAPI;
  hosts.push(api);
  plugin.setup(api);
  return { api, tool };
}
const input = { files: ['owned.ts'], type: 'fix', message: 'owned change' };
describe('git-autocommit execution boundaries', () => {
  it('runs every git operation in the calling project instead of process cwd', async () => {
    const { tool } = load();
    const root = resolve('.temp_files/calling-project');
    await tool.execute(input, { projectRoot: root } as never, {
      signal: new AbortController().signal,
    });
    expect(mocks.execFile).toHaveBeenCalled();
    for (const call of mocks.execFile.mock.calls) expect(call[2]).toMatchObject({ cwd: root });
  });
  it('performs no git operation for an already cancelled call', async () => {
    const { tool } = load();
    await expect(
      tool.execute(input, {} as never, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it('does not commit after cancellation during staging', async () => {
    const { tool } = load();
    const controller = new AbortController();
    handle = (args) => {
      if (args[0] === 'add') controller.abort();
      return args.includes('--cached') && args.includes('--name-only') ? 'owned.ts' : '';
    };
    await expect(tool.execute(input, {} as never, { signal: controller.signal })).rejects.toThrow();
    expect(mocks.execFile.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
  });
  it('refuses a scoped commit when drift cannot be checked', async () => {
    const { tool } = load();
    handle = (args) => {
      if (args[0] === 'diff' && args[1] === '--name-only') throw new Error('index unavailable');
      return args.includes('--cached') && args.includes('--name-only') ? 'owned.ts' : '';
    };
    await expect(
      tool.execute(input, {} as never, { signal: new AbortController().signal }),
    ).rejects.toThrow(/index unavailable/);
    expect(mocks.execFile.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
  });
  it('cannot run a retained tool after its host is unloaded', async () => {
    const { api, tool } = load();
    await plugin.teardown?.(api);
    await expect(
      tool.execute(input, {} as never, { signal: new AbortController().signal }),
    ).rejects.toThrow();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});

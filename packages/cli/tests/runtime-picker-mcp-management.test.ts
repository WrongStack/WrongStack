import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimePickerDeps } from '../src/wiring/runtime-picker-deps.js';

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function harness() {
  root = await mkdtemp(join(tmpdir(), 'mcp-panel-'));
  const configPath = join(root, 'config.json');
  let config = { mcpServers: {}, unrelated: 'keep' } as unknown as Config;
  await writeFile(configPath, JSON.stringify(config));
  const registry = {
    list: () => [],
    markDisabled: vi.fn(),
    stop: vi.fn(),
    forget: vi.fn(),
    start: vi.fn(),
    restart: vi.fn(),
  };
  const deps = createRuntimePickerDeps({
    getConfig: () => config,
    setConfig: (next: Config) => {
      config = next;
    },
    profileConfigPath: configPath,
    mcpRegistry: registry,
  } as never);
  return {
    deps,
    registry,
    configPath,
    read: async () => JSON.parse(await readFile(configPath, 'utf8')),
  };
}

describe('TUI MCP operations against the active profile', () => {
  it('adds, edits and removes a custom server, preserving unrelated and credential settings', async () => {
    const { deps, registry, configPath, read } = await harness();
    const server = {
      name: 'custom',
      transport: 'stdio',
      command: 'node',
      args: ['path with spaces/server.js'],
    };
    expect((await deps.onMcpManage!('add', server)).error).toBeUndefined();
    expect(deps.getMcpServers!()).toEqual([expect.objectContaining({ ...server, enabled: false })]);
    expect(registry.start).not.toHaveBeenCalled();
    const saved = await read();
    saved.mcpServers.custom.env = { CUSTOM_TOKEN: 'keep-fixture' };
    saved.mcpServers.custom.permission = 'confirm';
    await writeFile(configPath, JSON.stringify(saved));
    expect(
      (await deps.onMcpManage!('edit', { ...server, args: ['new path/server.js'] })).error,
    ).toBeUndefined();
    expect((await read()).mcpServers.custom).toMatchObject({
      args: ['new path/server.js'],
      env: { CUSTOM_TOKEN: 'keep-fixture' },
      permission: 'confirm',
    });
    expect((await deps.onMcpManage!('remove', server)).error).toBeUndefined();
    expect(deps.getMcpServers!()).toEqual([]);
    expect(await read()).toMatchObject({ unrelated: 'keep', mcpServers: {} });
  });

  it('supports presets and remote server URLs, and disables enabled servers whose connection is down', async () => {
    const { deps, registry, configPath, read } = await harness();
    expect(
      (await deps.onMcpManage!('add', { name: 'filesystem', transport: 'stdio' })).error,
    ).toBeUndefined();
    const remote = { name: 'remote', transport: 'streamable-http', url: 'https://example.com/mcp' };
    expect((await deps.onMcpManage!('add', remote)).error).toBeUndefined();
    const saved = await read();
    saved.mcpServers.remote.enabled = true;
    await writeFile(configPath, JSON.stringify(saved));
    await deps.onMcpManage!('edit', remote); // Syncs the persisted enabled flag; mocked registry remains empty.
    registry.start.mockClear();
    await deps.onMcpToggle!('remote');
    expect(registry.stop).toHaveBeenCalledWith('remote');
    expect(registry.start).not.toHaveBeenCalled();
    expect(deps.getMcpServers!().find((item) => item.name === 'remote')?.enabled).toBe(false);
    expect((await read()).mcpServers.remote).toMatchObject({ url: remote.url, enabled: false });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { createPluginManagerTool } from '../../src/tools/plugin-manager.js';
import type { Config } from '../../src/types/config.js';
import type { Tool } from '../../src/types/tool.js';

const catalog = [
  {
    name: 'alpha-plugin',
    description: 'Alpha code analysis plugin.',
    risk: 'low' as const,
    defaultState: 'active' as const,
    canDisable: true,
    aliases: ['alpha'],
  },
  {
    name: 'beta-plugin',
    description: 'Beta release helper.',
    risk: 'medium' as const,
    defaultState: 'inactive' as const,
    canDisable: true,
  },
];

function config(overrides: Partial<Config> = {}): Config {
  return {
    provider: 'test',
    model: 'test-model',
    features: { plugins: true },
    ...overrides,
  } as Config;
}

function execute(
  tool: Tool,
  input: Record<string, unknown>,
  meta: Record<string, unknown> = {},
): Promise<unknown> {
  return tool.execute(input, { meta } as never, { signal: new AbortController().signal });
}

describe('plugin_manager', () => {
  it('teaches the model the discovery-first workflow and permission boundaries', () => {
    const tool = createPluginManagerTool({
      getConfig: () => config(),
      catalog,
      toolRegistry: new ToolRegistry(),
      setEnabled: vi.fn(),
    });

    expect(tool.description).toContain('discovery-first');
    expect(tool.usageHint).toContain('never enable a guessed plugin name');
    expect(tool.usageHint).toContain('"action":"search"');
    expect(tool.usageHint).toContain('generate_release_notes');
    expect(tool.usageHint).toContain('managerControl="allowed"');
    expect(tool.usageHint).toContain('restartRequired=true');
    expect(tool.usageHint).toContain('needs_direct_call');
    expect(tool.selection?.doNotUseWhen).toContain('bypassing');
  });

  it('discovers catalog and user-configured plugins with effective state', async () => {
    const registry = new ToolRegistry();
    const tool = createPluginManagerTool({
      getConfig: () =>
        config({
          plugins: [{ name: 'alpha-plugin', enabled: false }, 'custom-plugin'],
        }),
      catalog,
      toolRegistry: registry,
      setEnabled: vi.fn(),
    });

    const result = (await execute(tool, { action: 'list' })) as {
      count: number;
      plugins: Array<{ name: string; enabled: boolean; stateSource: string }>;
    };

    expect(result.count).toBe(3);
    expect(result.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'alpha-plugin', enabled: false, stateSource: 'config' }),
        expect.objectContaining({ name: 'beta-plugin', enabled: false, stateSource: 'default' }),
        expect.objectContaining({ name: 'custom-plugin', enabled: true, stateSource: 'config' }),
      ]),
    );
  });

  it('searches plugin descriptions and live plugin tool metadata', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'alpha_scan',
        description: 'Find architectural drift.',
        inputSchema: { type: 'object', properties: {} },
        permission: 'auto',
        mutating: false,
        async execute() {
          return 'ok';
        },
      },
      'alpha-plugin',
    );
    const tool = createPluginManagerTool({
      getConfig: () => config(),
      catalog,
      toolRegistry: registry,
      setEnabled: vi.fn(),
    });

    const result = (await execute(tool, { action: 'search', query: 'architectural drift' })) as {
      plugins: Array<{ name: string; callableNow: boolean; tools: string[] }>;
    };

    expect(result.plugins).toEqual([
      expect.objectContaining({ name: 'alpha-plugin', callableNow: true, tools: ['alpha_scan'] }),
    ]);
  });

  it('persists enable/disable through the host callback and reports restart', async () => {
    const setEnabled = vi.fn(async () => ({
      ok: true,
      message: 'Enabled beta-plugin.',
      restartRequired: true,
    }));
    const tool = createPluginManagerTool({
      getConfig: () => config(),
      catalog,
      toolRegistry: new ToolRegistry(),
      setEnabled,
    });

    const result = await execute(tool, { action: 'enable', plugin: 'beta' });

    expect(setEnabled).toHaveBeenCalledWith('beta-plugin', true);
    expect(result).toEqual(
      expect.objectContaining({ status: 'ok', changed: true, restartRequired: true }),
    );
  });

  it('refuses LLM state changes for a user-locked plugin while keeping it discoverable', async () => {
    const setEnabled = vi.fn();
    const tool = createPluginManagerTool({
      getConfig: () =>
        config({
          pluginManager: { locked: ['alpha'] },
        }),
      catalog,
      toolRegistry: new ToolRegistry(),
      setEnabled,
    });

    const described = await execute(tool, { action: 'describe', plugin: 'alpha-plugin' });
    const changed = await execute(tool, { action: 'disable', plugin: 'alpha-plugin' });

    expect(described).toEqual(
      expect.objectContaining({
        status: 'ok',
        plugin: expect.objectContaining({ managerControl: 'locked' }),
      }),
    );
    expect(changed).toEqual(
      expect.objectContaining({ status: 'error', code: 'plugin_manager_locked' }),
    );
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('supports a wildcard lock for every plugin', async () => {
    const tool = createPluginManagerTool({
      getConfig: () => config({ pluginManager: { locked: ['*'] } }),
      catalog,
      toolRegistry: new ToolRegistry(),
      setEnabled: vi.fn(),
    });

    const result = (await execute(tool, { action: 'list' })) as {
      plugins: Array<{ managerControl: string }>;
    };

    expect(result.plugins.every((plugin) => plugin.managerControl === 'locked')).toBe(true);
  });

  it('validates and invokes an auto-permission tool owned by the plugin', async () => {
    const registry = new ToolRegistry();
    const run = vi.fn(async (input: unknown) => ({ echoed: input }));
    registry.register(
      {
        name: 'alpha_scan',
        description: 'Scan one path.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        permission: 'auto',
        mutating: false,
        execute: run,
      },
      'alpha-plugin',
    );
    const tool = createPluginManagerTool({
      getConfig: () => config(),
      catalog,
      toolRegistry: registry,
      setEnabled: vi.fn(),
    });

    const invalid = await execute(tool, {
      action: 'use',
      plugin: 'alpha',
      tool: 'alpha_scan',
      input: {},
    });
    const valid = await execute(tool, {
      action: 'use',
      plugin: 'alpha',
      tool: 'alpha_scan',
      input: { path: 'src' },
    });

    expect(invalid).toEqual(expect.objectContaining({ status: 'error' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(valid).toEqual(
      expect.objectContaining({
        status: 'ok',
        plugin: 'alpha-plugin',
        tool: 'alpha_scan',
        result: { echoed: { path: 'src' } },
      }),
    );
  });

  it('does not bypass a plugin tool that requires confirmation', async () => {
    const registry = new ToolRegistry();
    const run = vi.fn();
    registry.register(
      {
        name: 'alpha_write',
        description: 'Write generated output.',
        inputSchema: { type: 'object', properties: {} },
        permission: 'confirm',
        mutating: true,
        execute: run,
      },
      'alpha-plugin',
    );
    const tool = createPluginManagerTool({
      getConfig: () => config(),
      catalog,
      toolRegistry: registry,
      setEnabled: vi.fn(),
    });

    const result = await execute(tool, {
      action: 'use',
      plugin: 'alpha-plugin',
      tool: 'alpha_write',
      input: {},
    });

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'needs_direct_call',
        directCall: expect.objectContaining({ tool: 'alpha_write' }),
      }),
    );
  });
});

/**
 * `plugin_manager action:'use'` calls `tool.execute()` itself. That is a
 * DIRECT invocation: it does not pass through `PermissionPolicy`, so
 * `ReadOnlyPermissionPolicy` — which is what a read-only session is — never
 * sees it. The existing `permission !== 'auto'` guard did not cover this,
 * because a plugin tool at `permission: 'auto'` with `mutating: true` is
 * exactly the shape that slips through: allowed by the guard, blocked by
 * read-only mode, executed anyway.
 */
describe('plugin_manager honours read-only mode on the use path', () => {
  function registryWithAutoWriter(run: () => unknown): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'alpha_autowrite',
        description: 'Writes a file without asking.',
        inputSchema: { type: 'object', properties: {} },
        permission: 'auto',
        mutating: true,
        execute: run as never,
      },
      'alpha-plugin',
    );
    return registry;
  }

  it('refuses to run a mutating plugin tool when the session is read-only', async () => {
    const run = vi.fn();
    const tool = createPluginManagerTool({
      getConfig: () => config(),
      catalog,
      toolRegistry: registryWithAutoWriter(run),
      setEnabled: vi.fn(),
    });

    const result = await execute(
      tool,
      { action: 'use', plugin: 'alpha-plugin', tool: 'alpha_autowrite', input: {} },
      { readOnly: true },
    );

    expect(run, 'read-only mode was walked around via plugin_manager').not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'needs_direct_call',
        directCall: expect.objectContaining({ tool: 'alpha_autowrite' }),
      }),
    );
    expect((result as { message: string }).message).toContain('read-only');
  });

  it('runs the same tool when the session is not read-only', async () => {
    const run = vi.fn().mockResolvedValue({ wrote: true });
    const tool = createPluginManagerTool({
      getConfig: () => config(),
      catalog,
      toolRegistry: registryWithAutoWriter(run),
      setEnabled: vi.fn(),
    });

    const result = await execute(tool, {
      action: 'use',
      plugin: 'alpha-plugin',
      tool: 'alpha_autowrite',
      input: {},
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ status: 'ok', tool: 'alpha_autowrite' }));
  });

  it('still runs a NON-mutating plugin tool in a read-only session', async () => {
    const run = vi.fn().mockResolvedValue({ read: true });
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'alpha_read',
        description: 'Reads something.',
        inputSchema: { type: 'object', properties: {} },
        permission: 'auto',
        execute: run as never,
      },
      'alpha-plugin',
    );
    const tool = createPluginManagerTool({
      getConfig: () => config(),
      catalog,
      toolRegistry: registry,
      setEnabled: vi.fn(),
    });

    const result = await execute(
      tool,
      { action: 'use', plugin: 'alpha-plugin', tool: 'alpha_read', input: {} },
      { readOnly: true },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ status: 'ok' }));
  });
});

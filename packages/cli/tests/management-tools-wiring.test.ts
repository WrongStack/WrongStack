import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createFallbackManageTools: vi.fn(),
  createPluginManagerTool: vi.fn(),
  runPluginManagementCommand: vi.fn(),
  createInterface: vi.fn(),
  fallbackOptions: undefined as unknown,
  pluginOptions: undefined as unknown,
  entries: [
    {
      name: 'plain',
      summary: 'Plain plugin',
      risk: 'low',
      defaultState: 'active',
      canDisable: true,
    },
    {
      name: '@wrongstack/plug-lsp',
      summary: 'LSP',
      risk: 'medium',
      defaultState: 'inactive',
      canDisable: true,
    },
    {
      name: 'telegram',
      summary: 'Telegram',
      risk: 'high',
      defaultState: 'inactive',
      canDisable: false,
    },
  ],
}));

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
}));

vi.mock('node:readline', () => ({
  createInterface: mocks.createInterface,
}));

vi.mock('@wrongstack/core/tools', () => ({
  createFallbackManageTools: mocks.createFallbackManageTools,
  createPluginManagerTool: mocks.createPluginManagerTool,
}));

vi.mock('../src/plugin-management.js', () => ({
  PLUGIN_AUDIT_ENTRIES: mocks.entries,
  runPluginManagementCommand: mocks.runPluginManagementCommand,
}));

import { registerCliManagementTools } from '../src/wiring/management-tools.js';

function harness(stdinInteractive: boolean) {
  const config = { provider: 'provider', model: 'model' };
  const configStore = {
    get: vi.fn(() => config),
    update: vi.fn(),
  };
  const toolRegistry = { register: vi.fn() };
  registerCliManagementTools({
    toolRegistry: toolRegistry as never,
    configStore: configStore as never,
    profileConfigPath: 'C:/profile/config.json',
    stdinInteractive,
  });
  return { config, configStore, toolRegistry };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fallbackOptions = undefined;
  mocks.pluginOptions = undefined;
  mocks.createFallbackManageTools.mockImplementation((options) => {
    mocks.fallbackOptions = options;
    return [{ name: 'manage-provider' }, { name: 'manage-model' }];
  });
  mocks.createPluginManagerTool.mockImplementation((options) => {
    mocks.pluginOptions = options;
    return { name: 'manage-plugin' };
  });
});

describe('registerCliManagementTools', () => {
  it('registers fallback and plugin tools with the projected catalog', () => {
    const state = harness(false);

    expect(state.toolRegistry.register.mock.calls.map(([tool]) => tool)).toEqual([
      { name: 'manage-provider' },
      { name: 'manage-model' },
      { name: 'manage-plugin' },
    ]);
    expect(mocks.fallbackOptions).toEqual(
      expect.objectContaining({
        getConfig: expect.any(Function),
        updateConfig: expect.any(Function),
      }),
    );
    expect(mocks.fallbackOptions).not.toHaveProperty('requestInput');
    expect((mocks.pluginOptions as { catalog: unknown[] }).catalog).toEqual([
      expect.objectContaining({
        name: 'plain',
        aliases: ['@wrongstack/plugins/plain'],
      }),
      expect.objectContaining({
        name: '@wrongstack/plug-lsp',
        aliases: ['lsp'],
      }),
      expect.objectContaining({
        name: 'telegram',
        aliases: ['@wrongstack/plugins/telegram', '@wrongstack/telegram'],
      }),
    ]);
  });

  it('mutates persisted profile config and recovers a missing file', async () => {
    const state = harness(false);
    mocks.readFile.mockRejectedValueOnce(new Error('missing'));
    const options = mocks.fallbackOptions as {
      updateConfig(mutate: (config: Record<string, unknown>) => void): Promise<void>;
    };

    await options.updateConfig((config) => {
      config['provider'] = 'updated';
    });

    expect(mocks.writeFile).toHaveBeenCalledWith(
      'C:/profile/config.json',
      JSON.stringify({ provider: 'updated' }, null, 2),
      { mode: 0o600 },
    );
    expect(state.configStore.update).toHaveBeenCalledWith({ provider: 'updated' });
  });

  it('mutates existing persisted profile config', async () => {
    const state = harness(false);
    mocks.readFile.mockResolvedValueOnce('{"provider":"old","keep":true}');
    const options = mocks.fallbackOptions as {
      getConfig(): unknown;
      updateConfig(mutate: (config: Record<string, unknown>) => void): Promise<void>;
    };

    expect(options.getConfig()).toBe(state.config);
    await options.updateConfig((config) => {
      config['provider'] = 'new';
    });
    expect(state.configStore.update).toHaveBeenCalledWith({
      provider: 'new',
      keep: true,
    });
  });

  it('provides interactive input and closes readline after answering', async () => {
    const close = vi.fn();
    mocks.createInterface.mockReturnValue({
      question: vi.fn((_prompt: string, callback: (answer: string) => void) => callback('secret')),
      close,
    });
    harness(true);
    const options = mocks.fallbackOptions as {
      requestInput(prompt: string): Promise<string>;
    };

    await expect(options.requestInput('API key')).resolves.toBe('secret');
    expect(mocks.createInterface).toHaveBeenCalledWith({
      input: process.stdin,
      output: process.stdout,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('applies successful plugin patches and reports restart requirements', async () => {
    const state = harness(false);
    mocks.runPluginManagementCommand.mockResolvedValue({
      code: 0,
      message: 'Enabled',
      restartRequired: true,
      patch: { plugins: ['plain'] },
    });
    const options = mocks.pluginOptions as {
      getConfig(): unknown;
      setEnabled(plugin: string, enabled: boolean): Promise<unknown>;
    };

    expect(options.getConfig()).toBe(state.config);
    await expect(options.setEnabled('plain', true)).resolves.toEqual({
      ok: true,
      message: 'Enabled',
      restartRequired: true,
    });
    expect(mocks.runPluginManagementCommand).toHaveBeenCalledWith(['enable', 'plain'], {
      config: state.config,
      configPath: 'C:/profile/config.json',
    });
    expect(state.configStore.update).toHaveBeenCalledWith({ plugins: ['plain'] });
  });

  it('reports failed disable operations without applying a patch', async () => {
    const state = harness(false);
    mocks.runPluginManagementCommand.mockResolvedValue({
      code: 1,
      message: 'Cannot disable',
      restartRequired: false,
    });
    const options = mocks.pluginOptions as {
      setEnabled(plugin: string, enabled: boolean): Promise<unknown>;
    };

    await expect(options.setEnabled('plain', false)).resolves.toEqual({
      ok: false,
      message: 'Cannot disable',
      restartRequired: false,
    });
    expect(mocks.runPluginManagementCommand).toHaveBeenCalledWith(
      ['disable', 'plain'],
      expect.any(Object),
    );
    expect(state.configStore.update).not.toHaveBeenCalled();
  });
});

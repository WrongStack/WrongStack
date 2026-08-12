import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateJsonObjectFile: vi.fn(),
  diskConfig: {} as Record<string, unknown>,
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

vi.mock('node:readline', () => ({
  createInterface: mocks.createInterface,
}));

// management-tools now persists through the same atomic JSON helper that
// mcp_control uses on the profile config, instead of a bare read/write pair.
vi.mock('@wrongstack/core/utils', () => ({
  updateJsonObjectFile: mocks.updateJsonObjectFile,
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
  mocks.diskConfig = {};
  // Faithful stand-in for the real helper: read (from the fake disk state),
  // mutate in place, return the resulting object.
  mocks.updateJsonObjectFile.mockImplementation(
    async (_path: string, mutator: (cfg: Record<string, unknown>) => unknown) => {
      const cfg = { ...mocks.diskConfig };
      const maybeNext = await mutator(cfg);
      const next =
        maybeNext && typeof maybeNext === 'object' ? (maybeNext as Record<string, unknown>) : cfg;
      mocks.diskConfig = next;
      return next;
    },
  );
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

  it('forwards the late-bound hook runner getter to plugin_manager', () => {
    // getHookRunner is optional, so forgetting to pass it is TS-silent —
    // and without it the plugin_manager `use` path runs no PreToolUse
    // policy hooks at all. Pin both halves of the bridge: the dep is
    // forwarded here, and cli-main actually builds + fills the ref.
    const getHookRunner = vi.fn(() => null);
    registerCliManagementTools({
      toolRegistry: { register: vi.fn() } as never,
      configStore: { get: vi.fn(() => ({})), update: vi.fn() } as never,
      profileConfigPath: 'C:/profile/config.json',
      stdinInteractive: false,
      getHookRunner,
    });
    expect((mocks.pluginOptions as { getHookRunner?: unknown }).getHookRunner).toBe(getHookRunner);
  });

  it('cli-main wires the hook-runner ref into the management tools', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const cliMain = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli-main.ts'),
      'utf8',
    );
    expect(cliMain).toContain('getHookRunner: () => hookRunnerRef.current');
    expect(cliMain).toContain('hookRunnerRef.current = hookRunner;');
  });

  it('persists profile config through the shared atomic JSON helper', async () => {
    const state = harness(false);
    const options = mocks.fallbackOptions as {
      updateConfig(mutate: (config: Record<string, unknown>) => void): Promise<void>;
    };

    await options.updateConfig((config) => {
      config['provider'] = 'updated';
    });

    expect(mocks.updateJsonObjectFile).toHaveBeenCalledWith(
      'C:/profile/config.json',
      expect.any(Function),
    );
    expect(mocks.diskConfig).toEqual({ provider: 'updated' });
    expect(state.configStore.update).toHaveBeenCalledWith({ provider: 'updated' });
  });

  it('mutates existing persisted profile config', async () => {
    const state = harness(false);
    mocks.diskConfig = { provider: 'old', keep: true };
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

  it('forwards the late-bound switchProviderAndModel getter to leader_model_set', async () => {
    // The switch is created by setupProviderRuntime AFTER the management tools
    // register, so it arrives as a ref-backed getter like getHookRunner.
    const switchFn = vi.fn(async () => null);
    let current: typeof switchFn | null = null;
    registerCliManagementTools({
      toolRegistry: { register: vi.fn() } as never,
      configStore: { get: vi.fn(() => ({})), update: vi.fn() } as never,
      profileConfigPath: 'C:/profile/config.json',
      stdinInteractive: false,
      getSwitchProviderAndModel: () => current,
    });
    const options = mocks.fallbackOptions as {
      switchProviderAndModel(providerId: string, modelId: string): Promise<string | null>;
    };
    expect(options.switchProviderAndModel).toBeInstanceOf(Function);

    // Before the ref is filled, the wrapper reports not-ready instead of diverging.
    await expect(options.switchProviderAndModel('p', 'm')).resolves.toContain('not ready');

    current = switchFn;
    await expect(options.switchProviderAndModel('p', 'm')).resolves.toBeNull();
    expect(switchFn).toHaveBeenCalledWith('p', 'm');
  });

  it('cli-main wires the switch ref into the management tools', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const cliMain = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli-main.ts'),
      'utf8',
    );
    expect(cliMain).toContain('getSwitchProviderAndModel: () => switchProviderAndModelRef.current');
    expect(cliMain).toContain('switchProviderAndModelRef.current = switchProviderAndModel;');
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

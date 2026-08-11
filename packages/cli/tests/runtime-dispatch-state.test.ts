import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setupSage: vi.fn(),
  setupCodebaseIndexing: vi.fn(),
  runPluginManagementCommand: vi.fn(),
  patchConfig: vi.fn((config: object, patch: object) => ({ ...config, ...patch })),
  getToolDescriptionMode: vi.fn(() => 'full'),
  pluginEntries: [
    {
      name: 'alpha',
      defaultState: 'active',
      risk: 'low',
      summary: 'Alpha',
      canDisable: true,
    },
    {
      name: 'beta',
      defaultState: 'inactive',
      risk: 'medium',
      summary: 'Beta',
      canDisable: false,
    },
    {
      name: 'gamma',
      defaultState: 'active',
      risk: 'high',
      summary: 'Gamma',
      canDisable: true,
    },
  ],
}));

vi.mock('../src/wiring/sage.js', () => ({ setupSage: mocks.setupSage }));
vi.mock('../src/wiring/codebase-index.js', () => ({
  setupCodebaseIndexing: mocks.setupCodebaseIndexing,
}));
vi.mock('../src/plugin-management.js', () => ({
  PLUGIN_AUDIT_ENTRIES: mocks.pluginEntries,
  runPluginManagementCommand: mocks.runPluginManagementCommand,
}));
vi.mock('../src/utils.js', () => ({ patchConfig: mocks.patchConfig }));
vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return { ...actual, getToolDescriptionMode: mocks.getToolDescriptionMode };
});

import { prepareRuntimeDispatch } from '../src/wiring/runtime-dispatch-state.js';

function harness(flag: string | boolean = 'AUTO') {
  let config = {
    provider: 'provider',
    model: 'model',
    plugins: [{ name: 'alpha', enabled: false }, 'beta'],
  };
  const handlers = new Map<string, (payload: unknown) => void>();
  const configStore = { update: vi.fn() };
  const toolRegistry = {
    listWithOwner: vi.fn(() => [
      {
        tool: {
          name: 'read',
          category: 'Files',
          mutating: false,
          permission: 'read',
          description: 'Read',
        },
        owner: 'core',
      },
    ]),
    listDisabled: vi.fn(() => [
      {
        tool: {
          name: 'custom',
          mutating: true,
          permission: 'write',
          description: 'Custom',
        },
        owner: 'plugin',
      },
    ]),
    isDisabled: vi.fn((name: string) => name === 'custom'),
    isExposedToProvider: vi.fn((name: string) => name === 'read'),
  };
  const agent = { ctx: { session: { id: 'session-1' }, meta: {} as Record<string, unknown> } };
  const input = {
    getConfig: () => config,
    setConfig: vi.fn((next) => {
      config = next;
    }),
    configStore,
    profileConfigPath: 'C:/profile/config.json',
    pipelines: {},
    memoryStore: {},
    logger: {},
    events: {},
    agent,
    context: {},
    projectRoot: 'C:/repo',
    toolRegistry,
    flags: { 'chimera-auto-fix': flag },
    onEvent: vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    }),
  };
  return { input, handlers, agent, configStore, toolRegistry, getConfig: () => config };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setupSage.mockReturnValue(vi.fn());
  mocks.setupCodebaseIndexing.mockResolvedValue(vi.fn());
  vi.spyOn(process, 'once').mockImplementation(() => process);
});

describe('prepareRuntimeDispatch', () => {
  it('wires SAGE/indexing and projects plugin and tool picker state', async () => {
    const state = harness();

    const runtime = await prepareRuntimeDispatch(state.input as never);

    expect(mocks.setupSage).toHaveBeenCalledWith(
      expect.objectContaining({
        config: state.getConfig(),
        getSessionId: expect.any(Function),
      }),
    );
    expect(mocks.setupSage.mock.calls[0]?.[0].getSessionId()).toBe('session-1');
    expect(mocks.setupCodebaseIndexing).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: 'C:/repo' }),
    );
    expect(process.once).toHaveBeenCalledWith('exit', expect.any(Function));
    expect(runtime.getPluginItems()).toEqual([
      expect.objectContaining({ name: 'alpha', enabled: false, lockable: true }),
      expect.objectContaining({ name: 'beta', enabled: true, lockable: false }),
      expect.objectContaining({ name: 'gamma', enabled: true, lockable: true }),
    ]);
    delete (state.getConfig() as { plugins?: unknown }).plugins;
    expect(runtime.getPluginItems()).toEqual([
      expect.objectContaining({ name: 'alpha', enabled: true }),
      expect.objectContaining({ name: 'beta', enabled: false }),
      expect.objectContaining({ name: 'gamma', enabled: true }),
    ]);
    expect(runtime.getToolItems()).toEqual([
      {
        name: 'read',
        owner: 'core',
        category: 'Files',
        enabled: true,
        exposure: 'direct',
        mutating: false,
        permission: 'read',
        descMode: 'full',
        description: 'Read',
      },
      {
        name: 'custom',
        owner: 'plugin',
        category: 'Other',
        enabled: false,
        exposure: 'disabled',
        mutating: true,
        permission: 'write',
        descMode: 'full',
        description: 'Custom',
      },
    ]);
  });

  it('applies valid flag and event-driven Chimera autofix modes', async () => {
    const state = harness('AUTO');
    await prepareRuntimeDispatch(state.input as never);

    expect(state.agent.ctx.meta.chimeraAutoFix).toBe('auto');
    state.handlers.get('chimera.set_autofix')?.({ mode: 'ask' });
    expect(state.agent.ctx.meta.chimeraAutoFix).toBe('ask');
    state.handlers.get('chimera.set_autofix')?.({ mode: 'invalid' });
    state.handlers.get('chimera.set_autofix')?.(null);
    expect(state.agent.ctx.meta.chimeraAutoFix).toBe('ask');

    const invalidString = harness('invalid');
    await prepareRuntimeDispatch(invalidString.input as never);
    expect(invalidString.agent.ctx.meta).toEqual({});
    const nonString = harness(false);
    await prepareRuntimeDispatch(nonString.input as never);
    expect(nonString.agent.ctx.meta).toEqual({});
  });

  it('applies successful plugin patches and adds restart guidance', async () => {
    const state = harness();
    mocks.runPluginManagementCommand.mockResolvedValue({
      code: 0,
      message: 'Alpha toggled',
      restartRequired: true,
      patch: { plugins: ['gamma'] },
    });
    const runtime = await prepareRuntimeDispatch(state.input as never);

    await expect(runtime.togglePlugin('alpha')).resolves.toEqual({
      items: [
        expect.objectContaining({ name: 'alpha', enabled: true }),
        expect.objectContaining({ name: 'beta', enabled: false }),
        expect.objectContaining({ name: 'gamma', enabled: true }),
      ],
      message: 'Alpha toggled Restart WrongStack to load or unload plugin code in this session.',
      error: undefined,
    });
    expect(state.configStore.update).toHaveBeenCalledWith({ plugins: ['gamma'] });
  });

  it('returns plugin errors without changing config', async () => {
    const state = harness();
    mocks.runPluginManagementCommand.mockResolvedValue({
      code: 1,
      message: 'Cannot toggle',
      restartRequired: true,
    });
    const runtime = await prepareRuntimeDispatch(state.input as never);

    await expect(runtime.togglePlugin('missing')).resolves.toEqual({
      items: expect.any(Array),
      message: undefined,
      error: 'Cannot toggle',
    });
    expect(state.input.setConfig).not.toHaveBeenCalled();
    expect(state.configStore.update).not.toHaveBeenCalled();
  });
});

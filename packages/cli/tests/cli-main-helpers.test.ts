import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSharedProjectMailbox: vi.fn(),
  refreshRuntimeModelCatalog: vi.fn(),
  buildPickableProviders: vi.fn(),
  getTaskTracker: vi.fn(),
  getActiveBuilder: vi.fn(),
  getTaskGraphId: vi.fn(),
  installedBridgeAgents: vi.fn((): string[] => []),
  wrongForgeModels: vi.fn(
    async (): Promise<{ models: string[]; default?: string } | undefined> => undefined,
  ),
}));

vi.mock('@wrongstack/fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/fleet')>();
  return {
    ...actual,
    installedBridgeAgents: mocks.installedBridgeAgents,
    // The real wrongForgeModels reads the machine (~/.wrongforge key, a live
    // server, the info cache), which would leak this host's WrongForge into
    // assertions about the provider list.
    wrongForgeModels: mocks.wrongForgeModels,
    refreshRuntimeModelCatalog: mocks.refreshRuntimeModelCatalog,
  };
});

vi.mock('@wrongstack/coordination', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/coordination')>();
  return { ...actual, getSharedProjectMailbox: mocks.getSharedProjectMailbox };
});

vi.mock('../src/provider-helpers.js', () => ({
  buildPickableProviders: mocks.buildPickableProviders,
}));

vi.mock('../src/services/sdd-runtime.js', () => ({
  getTaskTracker: mocks.getTaskTracker,
  getActiveBuilder: mocks.getActiveBuilder,
  getTaskGraphId: mocks.getTaskGraphId,
}));

import {
  createPickableProvidersLoader,
  createTeardownEventRegistrar,
  getSddRuntimeStateForCli,
  loadOnlineAgentsForPrompt,
} from '../src/cli-main-helpers.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('cli-main helpers', () => {
  it('registers event teardown using the original handler identity', () => {
    const events = { on: vi.fn(), off: vi.fn() };
    const teardowns: Array<() => void> = [];
    const handler = vi.fn();

    createTeardownEventRegistrar(events, teardowns)('event', handler);
    expect(events.on).toHaveBeenCalledWith('event', handler);
    expect(teardowns).toHaveLength(1);

    teardowns[0]?.();
    expect(events.off).toHaveBeenCalledWith('event', handler);
  });

  it('loads online agents and contains mailbox failures', async () => {
    const statuses = [{ agentId: 'agent-1', status: 'running' }];
    mocks.getSharedProjectMailbox.mockReturnValueOnce({
      getAgentStatuses: vi.fn().mockResolvedValue(statuses),
    });
    await expect(loadOnlineAgentsForPrompt('C:/repo')).resolves.toBe(statuses);

    mocks.getSharedProjectMailbox.mockImplementationOnce(() => {
      throw new Error('mailbox unavailable');
    });
    await expect(loadOnlineAgentsForPrompt('C:/repo')).resolves.toEqual([]);
  });

  it('projects the active SDD runtime state', async () => {
    const tracker = { id: 'tracker' };
    const builder = { id: 'builder' };
    mocks.getTaskTracker.mockReturnValue(tracker);
    mocks.getActiveBuilder.mockReturnValue(builder);
    mocks.getTaskGraphId.mockReturnValue('graph-1');

    await expect(getSddRuntimeStateForCli()).resolves.toEqual({
      tracker,
      builder,
      graphId: 'graph-1',
    });
  });

  it('refreshes the model catalog before building picker options', async () => {
    const modelsRegistry = { id: 'models' };
    const logger = { warn: vi.fn() };
    const config = { provider: 'provider', model: 'model' };
    const providers = [{ id: 'provider' }];
    mocks.buildPickableProviders.mockReturnValue(providers);
    const loader = createPickableProvidersLoader({
      modelsRegistry: modelsRegistry as never,
      logger: logger as never,
      getConfig: () => config as never,
    });

    await expect(loader()).resolves.toBe(providers);
    expect(mocks.refreshRuntimeModelCatalog).toHaveBeenCalledWith({
      modelsRegistry,
      logger,
      reason: 'model-picker',
    });
    expect(mocks.buildPickableProviders).toHaveBeenCalledWith(modelsRegistry, config);
    expect(mocks.refreshRuntimeModelCatalog.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.buildPickableProviders.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('offers installed ACP agents as the `acp` provider, which the catalog never lists', async () => {
    mocks.buildPickableProviders.mockReturnValue([
      { id: 'zai', family: 'openai', models: ['glm-5'] },
    ]);
    mocks.installedBridgeAgents.mockReturnValueOnce(['claude-code']);
    const loader = createPickableProvidersLoader({
      modelsRegistry: {} as never,
      logger: {} as never,
      getConfig: () => ({ acp: {} }) as never,
    });
    await expect(loader()).resolves.toEqual([
      { id: 'zai', family: 'openai', models: ['glm-5'] },
      { id: 'acp', family: 'acp', models: ['claude-code'], modelsLabel: 'ACP agent as leader' },
    ]);
  });

  it("offers the machine's WrongForge as the `wrongforge` provider after the catalog and ACP entries", async () => {
    mocks.buildPickableProviders.mockReturnValue([
      { id: 'zai', family: 'openai', models: ['glm-5'] },
    ]);
    mocks.installedBridgeAgents.mockReturnValueOnce(['claude-code']);
    mocks.wrongForgeModels.mockReturnValueOnce(
      Promise.resolve({ models: ['claude-sonnet-5-5'], default: 'claude-sonnet-5-5' }),
    );
    const loader = createPickableProvidersLoader({
      modelsRegistry: {} as never,
      logger: {} as never,
      getConfig: () => ({ acp: {} }) as never,
    });
    await expect(loader()).resolves.toEqual([
      { id: 'zai', family: 'openai', models: ['glm-5'] },
      { id: 'acp', family: 'acp', models: ['claude-code'], modelsLabel: 'ACP agent as leader' },
      {
        id: 'wrongforge',
        family: 'wrongforge',
        models: ['claude-sonnet-5-5'],
        modelsLabel: 'WrongForge as leader',
      },
    ]);
  });

  it('keeps the catalog list when the machine has no WrongForge', async () => {
    mocks.buildPickableProviders.mockReturnValue([{ id: 'provider' }]);
    const loader = createPickableProvidersLoader({
      modelsRegistry: {} as never,
      logger: {} as never,
      getConfig: () => ({}) as never,
    });
    await expect(loader()).resolves.toEqual([{ id: 'provider' }]);
    expect(mocks.wrongForgeModels).toHaveBeenCalled();
  });
});

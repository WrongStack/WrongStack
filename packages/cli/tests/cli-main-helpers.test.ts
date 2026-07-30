import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSharedProjectMailbox: vi.fn(),
  refreshRuntimeModelCatalog: vi.fn(),
  buildPickableProviders: vi.fn(),
  getTaskTracker: vi.fn(),
  getActiveBuilder: vi.fn(),
  getTaskGraphId: vi.fn(),
}));

vi.mock('@wrongstack/core/coordination', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/coordination')>();
  return { ...actual, getSharedProjectMailbox: mocks.getSharedProjectMailbox };
});

vi.mock('../src/context-limit.js', () => ({
  refreshRuntimeModelCatalog: mocks.refreshRuntimeModelCatalog,
}));

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

  it('skips mailbox discovery when online agents are not needed', async () => {
    await expect(loadOnlineAgentsForPrompt('C:/repo', true)).resolves.toEqual([]);
    expect(mocks.getSharedProjectMailbox).not.toHaveBeenCalled();
  });

  it('loads online agents and contains mailbox failures', async () => {
    const statuses = [{ agentId: 'agent-1', status: 'running' }];
    mocks.getSharedProjectMailbox.mockReturnValueOnce({
      getAgentStatuses: vi.fn().mockResolvedValue(statuses),
    });
    await expect(loadOnlineAgentsForPrompt('C:/repo', false)).resolves.toBe(statuses);

    mocks.getSharedProjectMailbox.mockImplementationOnce(() => {
      throw new Error('mailbox unavailable');
    });
    await expect(loadOnlineAgentsForPrompt('C:/repo', false)).resolves.toEqual([]);
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
});

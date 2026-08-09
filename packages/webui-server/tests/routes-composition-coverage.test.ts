import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAutonomyRouteHandlers: vi.fn(() => ({ kind: 'autonomy' })),
  createMailboxRouteHandlers: vi.fn(() => ({ kind: 'mailbox' })),
  createModeHandlers: vi.fn(() => ({ kind: 'mode' })),
  createModelOperations: vi.fn(() => ({ switchModel: vi.fn(), refineModel: vi.fn() })),
  createPrefsRouteHandlers: vi.fn(() => ({ kind: 'prefs' })),
  createProjectHandlers: vi.fn(() => ({ kind: 'project' })),
  createProviderHandlers: vi.fn(() => ({
    handleProvidersList: vi.fn(),
    handleProvidersSaved: vi.fn(),
    handleProviderModels: vi.fn(),
    handleProviderModelsSearch: vi.fn(),
    adoptDefaultProviderIfUnset: vi.fn(),
  })),
  createSessionHandlers: vi.fn(() => ({ kind: 'session' })),
}));

vi.mock('../src/server/autonomy-routes.js', () => ({
  createAutonomyRouteHandlers: mocks.createAutonomyRouteHandlers,
}));
vi.mock('../src/server/mailbox-routes.js', () => ({
  createMailboxRouteHandlers: mocks.createMailboxRouteHandlers,
}));
vi.mock('../src/server/mode-handlers.js', () => ({ createModeHandlers: mocks.createModeHandlers }));
vi.mock('../src/server/model-operations.js', () => ({
  createModelOperations: mocks.createModelOperations,
}));
vi.mock('../src/server/prefs-routes.js', () => ({
  createPrefsRouteHandlers: mocks.createPrefsRouteHandlers,
}));
vi.mock('../src/server/project-handlers.js', () => ({
  createProjectHandlers: mocks.createProjectHandlers,
}));
vi.mock('../src/server/provider-handlers.js', () => ({
  createProviderHandlers: mocks.createProviderHandlers,
}));
vi.mock('../src/server/session-handlers.js', () => ({
  createSessionHandlers: mocks.createSessionHandlers,
}));

import { buildRoutes } from '../src/server/routes.js';

describe('buildRoutes composition', () => {
  it('constructs every route family from live state and shared dependencies', () => {
    const clients = new Map();
    const config = { provider: 'openai', model: 'gpt-5.6', providers: {} };
    const fallback = vi.fn();
    const state = new Proxy(
      {
        getConfig: vi.fn(() => config),
        getClients: vi.fn(() => clients),
        getProjectRoot: vi.fn(() => 'D:\\repo'),
        getModelCapabilities: vi.fn(() => ({})),
      },
      { get: (target, property) => Reflect.get(target, property) ?? fallback },
    );
    const context = {
      meta: {},
      session: { id: 'session-1' },
      runModelTransition: vi.fn(),
    };
    const deps = new Proxy(
      {
        context,
        wpaths: {
          globalRoot: 'D:\\global',
          projectSessions: 'D:\\repo\\.wstack\\sessions',
        },
        providerRegistry: { has: vi.fn(() => false), create: vi.fn() },
        configStore: { update: vi.fn() },
        pipelines: { contextWindow: { remove: vi.fn(), use: vi.fn() } },
        logger: { warn: vi.fn(), level: 'info' },
        toolRegistry: { list: vi.fn(() => []) },
        permissionPolicy: { setYolo: vi.fn() },
        goalHandler: { handleMessage: vi.fn() },
        specsHandler: { handleMessage: vi.fn() },
        sddBoardHandler: { handleMessage: vi.fn() },
        sddWizardHandler: { handleMessage: vi.fn() },
        globalConfigPath: 'D:\\global\\config.json',
        profileConfigPath: 'D:\\global\\profiles\\default.json',
      },
      { get: (target, property) => Reflect.get(target, property) ?? {} },
    );
    const callback = vi.fn();
    const cb = new Proxy(
      { sessionStartPayload: vi.fn().mockResolvedValue({ sessionId: 'session-1' }) },
      { get: (target, property) => Reflect.get(target, property) ?? callback },
    );

    const routes = buildRoutes(state as never, deps as never, cb as never);

    expect(Object.keys(routes)).toEqual([
      'providerRoutes',
      'sessionRoutes',
      'projectRoutes',
      'modeRoutes',
      'prefsRoutes',
      'autonomyRoutes',
      'shellGitRoutes',
      'mailboxRoutes',
      'mcpRoutes',
      'brainRoutes',
      'goalRoutes',
      'specsRoutes',
      'sddBoardRoutes',
      'sddWizardRoutes',
    ]);
    expect(mocks.createProviderHandlers).toHaveBeenCalledWith(
      expect.objectContaining({ clients, modelsRegistry: expect.anything() }),
    );
    expect(mocks.createSessionHandlers).toHaveBeenCalledWith(
      expect.objectContaining({ config, clients, context }),
    );
    expect(mocks.createModeHandlers).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: 'D:\\repo', clients, context }),
    );
    expect(mocks.createMailboxRouteHandlers).toHaveBeenCalledWith(
      expect.objectContaining({ getProjectRoot: state.getProjectRoot }),
    );

    const ws = {} as never;
    routes.providerRoutes.listProviders(ws, { type: 'providers.list' } as never);
    expect(
      mocks.createProviderHandlers.mock.results[0]?.value.handleProvidersList,
    ).toHaveBeenCalledWith(ws);
    routes.goalRoutes.handleMessage(ws, { type: 'goal.get' } as never);
    expect(deps.goalHandler.handleMessage).toHaveBeenCalledWith(ws, { type: 'goal.get' });
  });
});

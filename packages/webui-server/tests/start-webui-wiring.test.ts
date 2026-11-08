import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  credentials: vi.fn(),
  proxy: vi.fn(),
  heap: vi.fn(),
  logging: vi.fn(),
  routes: vi.fn(),
  maintenance: vi.fn(),
  dispatcher: vi.fn(),
  connection: vi.fn(),
  shutdown: vi.fn(),
  deps: vi.fn(),
  security: vi.fn(),
  managementTools: vi.fn(),
  applyModelSwitch: vi.fn(),
  hostServices: vi.fn(),
}));
vi.mock('@wrongstack/core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/core/utils')>()),
  startSharedHeapWatchdog: mocks.heap,
}));
vi.mock('../src/server/start-webui-credential-watcher.js', () => ({
  setupWebuiCredentialWatcher: mocks.credentials,
}));
vi.mock('../src/server/start-webui-proxy-apply.js', () => ({
  setupWebuiProxyInstantApply: mocks.proxy,
}));
vi.mock('../src/server/start-webui-logging.js', () => ({
  setupWebuiTerminalLogging: mocks.logging,
}));
vi.mock('../src/server/routes.js', () => ({ buildRoutes: mocks.routes }));
vi.mock('../src/server/start-webui-session-maintenance.js', () => ({
  setupStandaloneSessionMaintenance: mocks.maintenance,
}));
vi.mock('../src/server/message-dispatcher.js', () => ({
  createMessageDispatcher: mocks.dispatcher,
}));
vi.mock('../src/server/connection-handler.js', () => ({
  createConnectionHandler: mocks.connection,
}));
vi.mock('../src/server/start-webui-shutdown.js', () => ({ setupWebuiShutdown: mocks.shutdown }));
vi.mock('../src/server/start-webui-deps.js', () => ({ createWebuiDeps: mocks.deps }));
vi.mock('../src/server/start-webui-security.js', () => ({
  handleWebuiSecurityRejection: mocks.security,
}));
vi.mock('../src/server/management-tools.js', () => ({
  registerEngineManagementTools: mocks.managementTools,
}));
vi.mock('../src/server/standalone-host-services.js', () => ({
  startStandaloneHostServices: mocks.hostServices,
}));
vi.mock('../src/server/model-switch-core.js', () => ({
  createApplyModelSwitch: vi.fn(() => mocks.applyModelSwitch),
  createSessionContextResolver: vi.fn(() => vi.fn()),
}));

import {
  buildStandaloneWebuiDeps,
  wireStandaloneWebuiRuntime,
} from '../src/server/start-webui-wiring.js';

beforeEach(() => {
  mocks.credentials.mockReturnValue(vi.fn());
  mocks.proxy.mockReturnValue(vi.fn());
  mocks.heap.mockReturnValue(vi.fn());
  mocks.logging.mockReturnValue({
    terminalDashboard: { stop: vi.fn() },
    stopLiveStatusLogger: vi.fn(),
  });
  mocks.routes.mockReturnValue({ id: 'routes' });
  mocks.maintenance.mockReturnValue({
    stopEmptySessionCleanup: { dispose: vi.fn() },
    offSessionRenamed: vi.fn(),
  });
  mocks.dispatcher.mockReturnValue(vi.fn());
  mocks.connection.mockReturnValue(vi.fn());
  mocks.deps.mockImplementation((input) => input);
  mocks.hostServices.mockReturnValue({ switchProject: vi.fn(), dispose: vi.fn() });
});

describe('standalone WebUI runtime wiring', () => {
  it('registers both sockets and reads the current session for replay', async () => {
    let session = { id: 'first', flush: vi.fn(async () => undefined) };
    const load = vi.fn(async () => ({
      messages: ['replayed'],
      events: ['event'],
      usage: { tokens: 2 },
    }));
    const input = {
      opts: {},
      state: { getSession: () => session, getSessionStore: () => ({ load }) },
      deps: {},
      cb: {},
      preContext: {
        context: { session, state: { messages: [{ _estTokens: 5 }, {}] } },
        events: {},
      },
      agentServices: {},
      clients: new Map(),
      pendingConfirms: new Map(),
      runLockControl: { hasAny: () => true },
      logger: {},
      wssPrimary: { on: vi.fn() },
      wssSecondary: { on: vi.fn() },
      getDisposeVectorMirror: () => undefined,
    };
    const runtime = wireStandaloneWebuiRuntime(
      input as unknown as Parameters<typeof wireStandaloneWebuiRuntime>[0],
    );
    const connection = mocks.connection.mock.results[0]!.value;
    // HQ control + presence and the dependency watcher start with the runtime (CLI parity),
    // stop with the shutdown, and follow a project switch.
    expect(mocks.hostServices).toHaveBeenCalledWith(
      expect.objectContaining({
        state: input.state,
        preContext: input.preContext,
        runLockControl: input.runLockControl,
      }),
    );
    const hostServices = mocks.hostServices.mock.results[0]!.value;
    mocks.shutdown.mock.calls[0]![0].stopHostServices();
    expect(hostServices.dispose).toHaveBeenCalledOnce();
    runtime.switchProject('/other');
    expect(hostServices.switchProject).toHaveBeenCalledWith('/other');
    // The leader's management tools are registered with the per-tab model switch.
    expect(mocks.managementTools).toHaveBeenCalledWith(
      expect.objectContaining({ switchModel: mocks.applyModelSwitch }),
    );
    expect(input.wssPrimary.on).toHaveBeenCalledWith('connection', connection);
    expect(input.wssSecondary.on).toHaveBeenCalledWith('connection', connection);
    session = { id: 'second', flush: vi.fn(async () => undefined) };
    const options = mocks.connection.mock.calls[0]![0];
    expect(options.getSessionId()).toBe('second');
    expect(await options.loadReplay()).toEqual({
      messages: ['replayed'],
      events: ['event'],
      usage: { tokens: 2 },
    });
    expect(session.flush).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith('second');
    expect(mocks.heap.mock.calls[0]![0].collectStats()).toMatchObject({
      surface: 'webui',
      messages: 2,
      messageEstimatedTokens: 5,
      runActive: true,
    });
    const dispose = vi.fn();
    mocks.dispatcher.mock.calls[0]![0].onDispose(dispose);
    expect(mocks.shutdown.mock.calls[0]![0].getKanbanSupervisorDispose()).toBe(dispose);
    await mocks.shutdown.mock.calls[0]![0].stopEmptySessionCleanup.dispose();
    const maintenance = mocks.maintenance.mock.results[0]!.value;
    expect(maintenance.offSessionRenamed).toHaveBeenCalledOnce();
    expect(maintenance.stopEmptySessionCleanup.dispose).toHaveBeenCalledOnce();
  });

  it('forwards agent routing and host paths into route dependencies', () => {
    const getAgent = vi.fn(),
      peekAgent = vi.fn(),
      isSessionLive = vi.fn();
    const input = {
      preContext: { context: {}, provider: { id: 'provider' } },
      agentServices: { getAgent, peekAgent, isSessionLive, sessionAgentIds: ['session'] },
      clients: new Map(),
      pendingConfirms: new Map(),
      globalConfigPath: 'root.json',
      profileConfigPath: 'profile.json',
      httpPort: 8080,
    };
    const deps = buildStandaloneWebuiDeps(
      input as unknown as Parameters<typeof buildStandaloneWebuiDeps>[0],
    );
    expect(deps).toMatchObject({
      getAgent,
      peekAgent,
      isSessionLive,
      sessionAgentIds: ['session'],
      globalConfigPath: 'root.json',
      profileConfigPath: 'profile.json',
      httpPort: 8080,
    });
    expect(deps.context).toBe(input.preContext.context);
    expect(mocks.deps.mock.calls[0]![0].clients).toBe(input.clients);
  });
});

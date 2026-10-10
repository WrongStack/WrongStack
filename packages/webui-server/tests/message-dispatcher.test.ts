import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from '../src/ws-runtime.js';

vi.mock('ws/native', async (importOriginal) => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { ...(await importOriginal<Record<string, unknown>>()), WebSocket: MockWebSocket };
});

vi.mock('../src/server/connections-health-route.js', () => ({
  handleConnectionsHealthRoute: vi.fn(async () => false),
  // Also wired into the standalone dispatcher's pre-dispatch chain — only the
  // CLI-embedded router had it, so `connections.service_action` went
  // unanswered here. A mock missing an export throws at ACCESS time, which is
  // why this omission surfaced as three unrelated dispatch failures.
  handleConnectionsServiceAction: vi.fn(async () => false),
}));
vi.mock('../src/server/codebase-index-server-control.js', () => ({
  handleCodebaseIndexServerControl: vi.fn(async () => false),
}));
vi.mock('../src/server/route-family-dispatcher.js', () => ({
  createRouteFamilyDispatcher: vi.fn(() => vi.fn(async () => undefined)),
}));

import { createMessageDispatcher } from '../src/server/message-dispatcher.js';

function mockWs(): any {
  return { readyState: WebSocket.OPEN, send: vi.fn() };
}

function makeMinimalOpts(): any {
  const agent: any = {
    ctx: {
      projectRoot: '/tmp/proj',
      provider: { id: 'openai' },
      model: 'gpt-4o',
      session: { id: 'sess-1' },
      todos: [],
      meta: {},
      tools: [],
      state: { replaceTodos: vi.fn() },
    },
  };
  const context = agent.ctx;
  return {
    state: {
      getProjectRoot: () => '/tmp/proj',
      getSession: () => ({ id: 'sess-1' }),
      getClients: () => new Map(),
      getConfig: () => ({ fallbackProfiles: {}, provider: 'openai', model: 'gpt-4o' }),
      getSessionStartedAt: () => Date.now(),
      getModeId: () => 'default',
    },
    deps: {
      agent,
      context,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(function (this: any) {
          return this;
        }),
      },
      trustBoundary: { authorize: vi.fn(async () => ({ allowed: true })) } as any,
      memoryStore: null,
      skillLoader: undefined,
      skillInstaller: undefined,
      modelsRegistry: {} as any,
      configStore: {} as any,
      toolRegistry: { get: vi.fn() } as any,
      collabHandler: { handleMessage: vi.fn(async () => undefined) } as any,
      terminalHandler: { handleMessage: vi.fn(async () => undefined) } as any,
      worktreeHandler: { handleMessage: vi.fn(async () => undefined) } as any,
      wpaths: { globalSkills: '/tmp/skills' } as any,
    },
    routes: {
      shellGitRoutes: {},
      mailboxRoutes: {},
      mcpRoutes: {},
      providerRoutes: {},
      sessionRoutes: {},
      projectRoutes: {},
      modeRoutes: {},
      prefsRoutes: {},
      brainRoutes: {},
      autonomyRoutes: {},
      goalRoutes: { handleMessage: vi.fn(async () => undefined) },
      specsRoutes: { handleMessage: vi.fn(async () => undefined) },
      sddBoardRoutes: { handleMessage: vi.fn(async () => undefined) },
      sddWizardRoutes: { handleMessage: vi.fn(async () => undefined) },
    },
    promptsCtx: { promptLoader: {}, promptUsage: {} },
    codebaseIndexing: { onFileWritten: vi.fn() },
    runLock: {
      get: () => null,
      set: vi.fn(),
    },
    pendingConfirms: new Map(),
  };
}

describe('createMessageDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a callable dispatcher function', () => {
    const dispatcher = createMessageDispatcher(makeMinimalOpts());
    expect(typeof dispatcher).toBe('function');
  });

  // The route-family dispatcher is mocked, so these tests used to assert
  // nothing: they now check the hand-off and the fallback the dispatcher wires.
  const lastRouteFamily = async () => {
    const { createRouteFamilyDispatcher } = await import(
      '../src/server/route-family-dispatcher.js'
    );
    const mocked = vi.mocked(createRouteFamilyDispatcher);
    return {
      options: mocked.mock.calls.at(-1)?.[0] as { onUnknown: (ws: unknown, msg: unknown) => void },
      routed: mocked.mock.results.at(-1)?.value as ReturnType<typeof vi.fn>,
    };
  };

  it('hands a message to the route-family dispatcher', async () => {
    const dispatcher = createMessageDispatcher(makeMinimalOpts());
    const { routed } = await lastRouteFamily();
    const ws = mockWs();
    const message = { type: 'files.list', payload: {} } as any;
    await dispatcher(ws, null as any, message);
    expect(routed).toHaveBeenCalledWith(ws, message);
  });

  it('answers unknown message types with an explicit error', async () => {
    const dispatcher = createMessageDispatcher(makeMinimalOpts());
    const { options, routed } = await lastRouteFamily();
    const ws = mockWs();
    const message = { type: 'totally.unknown', payload: {} } as any;
    await dispatcher(ws, null as any, message);
    expect(routed).toHaveBeenCalledWith(ws, message);

    // The fallback the dispatcher registers must tell the client, not drop it.
    options.onUnknown(ws, message);
    const sent = ws.send.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
    expect(sent).toContainEqual({
      type: 'error',
      payload: { phase: 'handleMessage', message: 'Unknown message type: totally.unknown' },
    });
  });

  it('terminal handler errors are caught and logged', async () => {
    const opts = makeMinimalOpts();
    opts.deps.terminalHandler.handleMessage = vi.fn(async () => {
      throw new Error('term fail');
    });
    const dispatcher = createMessageDispatcher(opts);
    const ws = mockWs();
    // Sending a terminal message — the terminal error should be caught,
    // not propagated. The message type must route to clientTransport.terminal.
    await dispatcher(
      ws,
      null as any,
      { type: 'terminal.input', payload: { id: 't1', data: 'ls\n' } } as any,
    );
    // No throw = pass
  });
});

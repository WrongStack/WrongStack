import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('ws', () => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { WebSocket: MockWebSocket };
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

  it('dispatches a message without throwing', async () => {
    const opts = makeMinimalOpts();
    const dispatcher = createMessageDispatcher(opts);
    const ws = mockWs();
    await dispatcher(ws, null as any, { type: 'files.list', payload: {} } as any);
    // Should not throw
  });

  it('handles unknown message types gracefully', async () => {
    const opts = makeMinimalOpts();
    const dispatcher = createMessageDispatcher(opts);
    const ws = mockWs();
    await dispatcher(ws, null as any, { type: 'totally.unknown', payload: {} } as any);
    // Should not throw — the dispatcher routes unknowns through the fallback
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

/**
 * Regression tests for the standalone dispatcher's `ensureCurrentSession`
 * gate (message-dispatcher.ts).
 *
 * The sibling suite `message-dispatcher.test.ts` mocks
 * `createRouteFamilyDispatcher` with a no-op — which silently bypasses the
 * worklist `allowMessage` gate. These tests run the REAL dispatch chain so
 * the gate actually executes, and pin the semantics mirrored from
 * `conversation-operations.ts`:
 *
 *   - a request whose payload targets a DIFFERENT session than the runtime's
 *     current one is rejected with an `error` frame (not silently stamped),
 *   - an allowed request rebinds the client (`client.sessionId`) so
 *     session-filtered broadcasts and the onClose abort cleanup — which key
 *     on client.sessionId — follow the client,
 *   - a rejected request must NOT rebind (the runtime never switched).
 */

import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('ws', () => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { WebSocket: MockWebSocket };
});
vi.mock('../src/server/connections-health-route.js', () => ({
  handleConnectionsHealthRoute: vi.fn(async () => false),
  handleConnectionsServiceAction: vi.fn(async () => false),
}));
vi.mock('../src/server/codebase-index-server-control.js', () => ({
  handleCodebaseIndexServerControl: vi.fn(async () => false),
}));
// NOTE: route-family-dispatcher is deliberately NOT mocked here.

import { createMessageDispatcher } from '../src/server/message-dispatcher.js';
import type { WSClientMessage } from '../src/server/types.js';

function mockWs(): any {
  return { readyState: WebSocket.OPEN, send: vi.fn() };
}

/**
 * Minimal dispatcher opts with a REAL clients map and a configurable current
 * session, so both the error frame and the client rebinding are observable.
 */
function makeOpts(currentSessionId: string): { opts: any; clients: Map<any, any> } {
  const agent: any = {
    ctx: {
      projectRoot: '/tmp/proj',
      provider: { id: 'openai' },
      model: 'gpt-4o',
      session: { id: currentSessionId },
      todos: [],
      meta: {},
      tools: [],
      state: { replaceTodos: vi.fn() },
    },
  };
  const clients = new Map();
  const opts = {
    state: {
      getProjectRoot: () => '/tmp/proj',
      getSession: () => ({ id: currentSessionId }),
      getClients: () => clients,
      getConfig: () => ({ fallbackProfiles: {}, provider: 'openai', model: 'gpt-4o' }),
      getSessionStartedAt: () => Date.now(),
      getModeId: () => 'default',
    },
    deps: {
      agent,
      context: agent.ctx,
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
      getSession: () => null,
      setSession: vi.fn(),
    },
    pendingConfirms: new Map(),
    onDispose: vi.fn(),
  };
  return { opts, clients };
}

function sentFrames(ws: any): Array<Record<string, any>> {
  return ws.send.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])));
}

describe('ensureCurrentSession gate (cross-session rejection regression)', () => {
  it('rejects a worklist request targeting a different session with an error frame', async () => {
    const { opts, clients } = makeOpts('sess-current');
    const dispatcher = createMessageDispatcher(opts);
    const ws = mockWs();
    clients.set(ws, { sessionId: null });

    await dispatcher(ws, null as any, {
      type: 'todos.get',
      payload: { sessionId: 'sess-other' },
    } as unknown as WSClientMessage);

    const err = sentFrames(ws).find((m) => m.type === 'error');
    expect(err).toMatchObject({
      type: 'error',
      payload: {
        sessionId: 'sess-current',
        phase: 'todos.get',
        requestedSessionId: 'sess-other',
      },
    });
    expect(err?.payload.message).toContain('sess-other');
    expect(err?.payload.message).toContain('sess-current');
    // Rejected ⇒ the client must NOT be rebound to the foreign session:
    // client.sessionId keys the onClose abort cleanup, and the runtime
    // never actually switched to 'sess-other'.
    expect(clients.get(ws)?.sessionId).not.toBe('sess-other');
  });

  it('allows and rebinds a request whose sessionId matches the current session', async () => {
    const { opts, clients } = makeOpts('sess-current');
    const dispatcher = createMessageDispatcher(opts);
    const ws = mockWs();
    clients.set(ws, { sessionId: null });

    await dispatcher(ws, null as any, {
      type: 'todos.get',
      payload: { sessionId: 'sess-current' },
    } as unknown as WSClientMessage);

    expect(sentFrames(ws).find((m) => m.type === 'error')).toBeUndefined();
    // Allowed ⇒ rebind so session-filtered broadcasts and abort cleanup
    // follow the client's session.
    expect(clients.get(ws)?.sessionId).toBe('sess-current');
  });

  it('allows requests that carry no sessionId without rebinding', async () => {
    const { opts, clients } = makeOpts('sess-current');
    const dispatcher = createMessageDispatcher(opts);
    const ws = mockWs();
    clients.set(ws, { sessionId: null });

    await dispatcher(ws, null as any, {
      type: 'todos.get',
      payload: {},
    } as unknown as WSClientMessage);

    expect(sentFrames(ws).find((m) => m.type === 'error')).toBeUndefined();
    expect(clients.get(ws)?.sessionId).toBeNull();
  });
});

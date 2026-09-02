import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  createSessionHandlers,
  type SessionHandlersContext,
} from '../src/server/session-handlers.js';

interface SentMessage {
  type: string;
  payload: Record<string, unknown>;
}

function writer(id: string) {
  return { id, append: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
}

/**
 * The tab-close ↔ session-delete contract.
 *
 * A WebUI page closes a tab by re-declaring its open set (`session.subscribe`,
 * replace semantics) and only then deleting the record (`session.delete`). The
 * server must (a) not re-add a deliberately removed acting session, (b) treat
 * the declared set — not the stale last-acted `sessionId` — as what a
 * connection displays, and (c) let a client delete the runtime's CURRENT
 * session when the delete names the live session the strip moved to.
 */
function makeHarness(
  opts: {
    runtimeSessionId?: string;
    isRunActive?: (id: string) => boolean;
    onAbort?: (id?: string) => void;
  } = {},
) {
  const runtime = writer(opts.runtimeSessionId ?? 'sess_current');
  let active = runtime;
  const live = new Set<string>([runtime.id]);
  const agents = new Map<string, { ctx: { session: ReturnType<typeof writer> } }>();
  const clients = new Map<
    WebSocket,
    { ws: WebSocket; sessionId: string | null; sessionIds?: Set<string>; connectedAt: number }
  >();
  const sent: SentMessage[] = [];
  const broadcasts: SentMessage[] = [];
  const ws = {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data) as SentMessage),
  } as never as WebSocket;
  const store = {
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => [{ id: 'sess_current', title: 'Current', updatedAt: '2026-08-01' }]),
  };
  const onSessionSwapped = vi.fn(async () => undefined);
  const onSessionsUndisplayed = vi.fn();
  /** Ordered trace of "abort happened" vs "transition gate entered". */
  const order: string[] = [];
  const abortActiveRun = vi.fn((id?: string) => {
    order.push('abort');
    opts.onAbort?.(id);
  });
  const withSessionTransition = <T>(operation: () => Promise<T>): Promise<T> => {
    order.push('gate');
    return operation();
  };
  const setSession = vi.fn((next: unknown) => {
    active = next as typeof runtime;
  });
  const routes = createSessionHandlers({
    withSessionTransition,
    config: { provider: 'test-provider', model: 'test-model' },
    clients: clients as never,
    context: {
      session: runtime,
      messages: [],
      state: { replaceMessages: vi.fn(), replaceTodos: vi.fn() },
      readFiles: new Set(),
      fileMtimes: new Map(),
    } as never,
    tokenCounter: { total: vi.fn(() => ({})), reset: vi.fn() } as never,
    getProjectRoot: () => '/tmp/wstack-delete-sync',
    getSession: () => active as never,
    getSessionStore: () => store as never,
    canSwapSessions: () => true,
    sessionsDir: '/tmp/wstack-delete-sync/sessions',
    setSession,
    setSessionStartedAt: vi.fn(),
    claimSession: vi.fn(async () => async () => undefined),
    onSessionSwapped,
    isRunActive: opts.isRunActive ?? (() => false),
    abortActiveRun,
    sessionStartPayload: async (overrides?: Record<string, unknown>) => ({
      sessionId: active.id,
      ...(overrides ?? {}),
    }),
    sendMessage: (_ws: unknown, message: unknown) => ws.send(JSON.stringify(message)),
    broadcastMessage: (message: unknown) => broadcasts.push(message as SentMessage),
    getAgent: (id: string | undefined) => (id ? agents.get(id) : undefined),
    isSessionLive: (id: string) => live.has(id),
    onSessionsUndisplayed,
  } as never as SessionHandlersContext);

  return {
    routes,
    ws,
    clients,
    store,
    sent,
    broadcasts,
    live,
    agents,
    onSessionSwapped,
    onSessionsUndisplayed,
    abortActiveRun,
    order,
    current: () => active.id,
  };
}

function connect(h: ReturnType<typeof makeHarness>, sessionId: string, sessionIds?: string[]) {
  const clientWs = { readyState: 1, send: vi.fn() } as never as WebSocket;
  const client = {
    ws: clientWs,
    sessionId,
    ...(sessionIds ? { sessionIds: new Set(sessionIds) } : {}),
    connectedAt: 0,
  };
  h.clients.set(clientWs, client);
  return { clientWs, client };
}

describe('session.subscribe — deliberate removal of the acting session', () => {
  it('does not force a previously declared acting session back into the set', async () => {
    const h = makeHarness();
    connect(h, 'sess_a', ['sess_a', 'sess_b']);
    const clientWs = h.clients.keys().next().value as WebSocket;

    await h.routes.subscribeSessions(
      clientWs as never,
      {
        type: 'session.subscribe',
        payload: { sessionIds: ['sess_b'] },
      } as never,
    );

    const client = h.clients.get(clientWs);
    expect([...(client?.sessionIds ?? [])]).toEqual(['sess_b']);
  });

  it('still force-adds an acting session the strip never declared (lag protection)', async () => {
    const h = makeHarness();
    connect(h, 'sess_a', ['sess_b']);
    const clientWs = h.clients.keys().next().value as WebSocket;

    await h.routes.subscribeSessions(
      clientWs as never,
      {
        type: 'session.subscribe',
        payload: { sessionIds: ['sess_b'] },
      } as never,
    );

    const client = h.clients.get(clientWs);
    // 'sess_a' is the acting session and was NOT in the previous declaration:
    // the lag safety net keeps it displayed.
    expect(client?.sessionIds?.has('sess_a')).toBe(true);
    expect(client?.sessionIds?.has('sess_b')).toBe(true);
  });

  it('reports the dropped session as undisplayed when nobody else shows it', async () => {
    const h = makeHarness();
    connect(h, 'sess_b', ['sess_a', 'sess_b']);
    const clientWs = h.clients.keys().next().value as WebSocket;

    await h.routes.subscribeSessions(
      clientWs as never,
      {
        type: 'session.subscribe',
        payload: { sessionIds: ['sess_b'] },
      } as never,
    );

    expect(h.onSessionsUndisplayed).toHaveBeenCalledWith(['sess_a']);
  });
});

describe('session.delete — displayed-set gating', () => {
  it('deletes a session no connection declares and broadcasts the refreshed list', async () => {
    const h = makeHarness();
    connect(h, 'sess_fg', ['sess_fg']);

    await h.routes.deleteSession(h.ws, {
      type: 'session.delete',
      payload: { id: 'sess_gone' },
    } as never);

    expect(h.store.delete).toHaveBeenCalledWith('sess_gone');
    const ok = h.sent.find((m) => m.type === 'key.operation_result');
    expect(ok?.payload['success']).toBe(true);
    const list = h.broadcasts.find((m) => m.type === 'sessions.list');
    expect(list).toBeDefined();
  });

  it('refuses a session another connection still declares', async () => {
    const h = makeHarness();
    connect(h, 'sess_fg', ['sess_fg', 'sess_shown']);

    await h.routes.deleteSession(h.ws, {
      type: 'session.delete',
      payload: { id: 'sess_shown' },
    } as never);

    expect(h.store.delete).not.toHaveBeenCalled();
    const fail = h.sent.find((m) => m.type === 'key.operation_result');
    expect(fail?.payload['success']).toBe(false);
  });

  it('ignores a stale last-acted sessionId when the declared set disagrees', async () => {
    const h = makeHarness();
    // The client closed its last declared tab for 'sess_stale'; its
    // `sessionId` lags behind the declaration.
    connect(h, 'sess_stale', ['sess_fg']);

    await h.routes.deleteSession(h.ws, {
      type: 'session.delete',
      payload: { id: 'sess_stale' },
    } as never);

    expect(h.store.delete).toHaveBeenCalledWith('sess_stale');
  });

  it('refuses a session whose run is still on a tab — that tab has a Stop button', async () => {
    const h = makeHarness({ isRunActive: (id) => id === 'sess_running' });
    connect(h, 'sess_fg', ['sess_fg', 'sess_running']);

    await h.routes.deleteSession(h.ws, {
      type: 'session.delete',
      payload: { id: 'sess_running' },
    } as never);

    expect(h.store.delete).not.toHaveBeenCalled();
    expect(h.abortActiveRun).not.toHaveBeenCalled();
    const fail = h.sent.find((m) => m.type === 'key.operation_result');
    expect(fail?.payload['success']).toBe(false);
    expect(fail?.payload['message']).toContain('agent run is active');
  });

  /**
   * The ghost-session bug: a tab closed while its run was wedged (an
   * unanswerable permission prompt) left a lock nobody could clear. No tab
   * meant no Stop button, and the delete refused forever.
   */
  it('stops the run and deletes when no tab displays the session', async () => {
    const running = new Set(['sess_ghost']);
    const h = makeHarness({
      isRunActive: (id) => running.has(id),
      onAbort: (id) => {
        if (id) running.delete(id);
      },
    });
    connect(h, 'sess_fg', ['sess_fg']);

    await h.routes.deleteSession(h.ws, {
      type: 'session.delete',
      payload: { id: 'sess_ghost' },
    } as never);

    expect(h.abortActiveRun).toHaveBeenCalledWith('sess_ghost');
    expect(h.store.delete).toHaveBeenCalledWith('sess_ghost');
    const ok = h.sent.find((m) => m.type === 'key.operation_result');
    expect(ok?.payload['success']).toBe(true);
  });

  /**
   * Stopping a wedged run can burn the whole grace window, and the transition
   * gate is shared with `user_message` setup — holding it that long would
   * stall the next turn in every OTHER tab for a delete that concerns none of
   * them. So the abort-and-wait runs before the gate is entered, not inside it.
   */
  it('stops the run before entering the shared transition gate', async () => {
    const running = new Set(['sess_ghost']);
    const h = makeHarness({
      isRunActive: (id) => running.has(id),
      onAbort: (id) => {
        if (id) running.delete(id);
      },
    });
    connect(h, 'sess_fg', ['sess_fg']);

    await h.routes.deleteSession(h.ws, {
      type: 'session.delete',
      payload: { id: 'sess_ghost' },
    } as never);

    expect(h.order).toEqual(['abort', 'gate']);
  });

  it('refuses when an off-screen run ignores the abort', async () => {
    const h = makeHarness({ isRunActive: (id) => id === 'sess_wedged' });
    connect(h, 'sess_fg', ['sess_fg']);

    await h.routes.deleteSession(h.ws, {
      type: 'session.delete',
      payload: { id: 'sess_wedged' },
    } as never);

    expect(h.abortActiveRun).toHaveBeenCalledWith('sess_wedged');
    expect(h.store.delete).not.toHaveBeenCalled();
    const fail = h.sent.find((m) => m.type === 'key.operation_result');
    expect(fail?.payload['success']).toBe(false);
    expect(fail?.payload['message']).toContain('did not stop');
  });
});

describe('session.delete — the runtime session', () => {
  it('rebinds the runtime to the tagged live fallback and deletes the doomed session', async () => {
    const h = makeHarness({ runtimeSessionId: 'sess_doomed' });
    connect(h, 'sess_doomed', ['sess_fb']);
    h.live.add('sess_fb');
    const fbWriter = writer('sess_fb');
    h.agents.set('sess_fb', { ctx: { session: fbWriter } });

    await h.routes.deleteSession(h.ws, {
      type: 'session.delete',
      payload: { id: 'sess_doomed', sessionId: 'sess_fb' },
    } as never);

    expect(h.current()).toBe('sess_fb');
    expect(h.onSessionSwapped).toHaveBeenCalledWith('sess_fb');
    expect(h.store.delete).toHaveBeenCalledWith('sess_doomed');
    const ok = h.sent.find((m) => m.type === 'key.operation_result');
    expect(ok?.payload['success']).toBe(true);
  });

  it('refuses the runtime session when no live fallback is named', async () => {
    const h = makeHarness({ runtimeSessionId: 'sess_doomed' });
    connect(h, 'sess_doomed', ['sess_fb']);

    await h.routes.deleteSession(h.ws, {
      type: 'session.delete',
      payload: { id: 'sess_doomed' },
    } as never);

    expect(h.store.delete).not.toHaveBeenCalled();
    const fail = h.sent.find((m) => m.type === 'key.operation_result');
    expect(fail?.payload['success']).toBe(false);
  });
});

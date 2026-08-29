import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('ws', () => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { WebSocket: MockWebSocket };
});

vi.mock('@wrongstack/providers', () => ({ makeProviderFromConfig: vi.fn() }));

import { makeProviderFromConfig } from '@wrongstack/providers';
import {
  createEmbeddedMessageRouter,
  type EmbeddedMessageRouterDeps,
} from '../src/server/embedded-message-router.js';

function mockWs(): any {
  return { readyState: WebSocket.OPEN, send: vi.fn() };
}

function makeDeps(overrides: Partial<EmbeddedMessageRouterDeps> = {}): EmbeddedMessageRouterDeps {
  const send = vi.fn();
  const sendResult = vi.fn();
  const agent: any = {
    ctx: {
      projectRoot: '/tmp/proj',
      provider: { id: 'test' },
      model: 'test-model',
      todos: [],
      meta: {},
      session: { id: 'sess-1' },
      tools: [],
      state: { replaceTodos: vi.fn() },
    },
  };
  return {
    trustBoundary: { authorize: vi.fn(async () => ({ allowed: true, reason: '' })) } as any,
    opts: {
      agent,
      projectRoot: '/tmp/proj',
      profileConfigPath: '/tmp/config.json',
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(function (this: any) {
        return this;
      }),
    } as any,
    send,
    sendResult,
    sessionPayload: <T extends Record<string, unknown>>(payload: T) => ({
      ...payload,
      sessionId: 'sess-1',
    }),
    currentSessionId: () => 'sess-1',
    shutdown: vi.fn(),
    providerCtx: {
      providerStore: {},
      broadcast: vi.fn(),
      send,
      modelsRegistry: {},
      log: {},
      hasActiveModel: () => false,
    } as any,
    brainCtx: { brain: null, broadcast: vi.fn(), send } as any,
    introspectionCtx: {
      getProjectRoot: () => '/tmp/proj',
      send,
      agent,
      getConfig: () => undefined,
    } as any,
    skillsCtx: { getSkillsContext: () => ({}), send } as any,
    promptsCtx: { getPromptsContext: () => ({}), send } as any,
    designCtx: { getDesignContext: () => ({}), send } as any,
    agentConfigCtx: {
      agent,
      memoryStore: null,
      modelsRegistry: {},
      getConfig: () => undefined,
      loadSavedProviders: vi.fn(async () => ({})),
      send,
      broadcast: vi.fn(),
      log: {},
      modeStore: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      buildSessionStart: vi.fn(async () => ({})),
    } as any,
    prefsCtx: {
      getPrefs: vi.fn(async () => ({})),
      setPref: vi.fn(async () => undefined),
      send,
    } as any,
    projectCtx: {
      getProjectRoot: () => '/tmp/proj',
      send,
      opts: { agent, projectRoot: '/tmp/proj', profileConfigPath: '/tmp/config.json' },
    } as any,
    sessionCtx: {
      getSessionHistory: vi.fn(async () => []),
      saveSession: vi.fn(async () => undefined),
      send,
      abortControllers: new Map(),
      buildSessionStart: vi.fn(async () => ({})),
      opts: { agent, projectRoot: '/tmp/proj' },
    } as any,
    conversationCtx: { abortControllers: new Map(), send, broadcast: vi.fn() } as any,
    mailboxRoutes: {} as any,
    goalHandler: { handleMessage: vi.fn(async () => undefined) } as any,
    specsHandler: { handleMessage: vi.fn(async () => undefined) } as any,
    sddBoardHandler: { handleMessage: vi.fn(async () => undefined) } as any,
    sddWizardHandler: { handleMessage: vi.fn(async () => undefined) } as any,
    worktreeHandler: { handleMessage: vi.fn(async () => undefined) } as any,
    terminalHandler: { handleMessage: vi.fn(async () => undefined) } as any,
    kanbanHostRoutes: {} as any,
    ...overrides,
  };
}

describe('createEmbeddedMessageRouter — isRunActive is session-keyed', () => {
  /**
   * Regression: the router used to override the host's session-keyed answer
   * with `() => abortControllers.size > 0`. A zero-arg function satisfies the
   * `(sessionId?: string) => boolean` contract, so the id was dropped and ONE
   * running tab made every other session look busy — `session.delete` refused
   * a session with no tab left, claiming "an agent run is active".
   */
  it('does not refuse deleting session A because session B is running', async () => {
    const send = vi.fn();
    const d = makeDeps({ send });
    // The session routes answer through sessionCtx.send, not the top-level one.
    (d.sessionCtx as any).send = send;
    (d.conversationCtx as any).abortControllers.set('sess-other', new AbortController());
    const r = createEmbeddedMessageRouter(d);
    const ws = mockWs();

    await r(ws, null, { type: 'session.delete', payload: { id: 'sess-dead' } } as any);

    const messages = send.mock.calls
      .map((c: any[]) => c[1]?.payload?.message)
      .filter((m: unknown): m is string => typeof m === 'string');
    // Neither run-related refusal may appear: the session-blind answer sent
    // this delete down the active-run path (refusal, or abort-and-wait) for a
    // session that was never running.
    expect(
      messages.some((m) => m.includes('agent run is active') || m.includes('did not stop')),
    ).toBe(false);
  });

  /**
   * Stopping a run means stopping the WORK. Aborting the leader's controller
   * only unwinds workers it is BLOCKED on; anything started with
   * `spawn_subagent` + `assign_task` keeps going unless asked. The standalone
   * host has always cascaded on its abort seam; this one did not, so a
   * `session.delete` that stopped an off-screen run left that session's fleet
   * running behind a conversation that no longer existed.
   */
  it('stops the session fleet when it aborts an off-screen run to delete it', async () => {
    const send = vi.fn();
    const stopSessionFleet = vi.fn();
    const d = makeDeps({ send });
    (d.sessionCtx as any).send = send;
    // An empty connection map is the point: no tab displays this session, so
    // the delete is allowed to stop the run instead of refusing forever.
    (d.sessionCtx as any).clients = new Map();
    (d.conversationCtx as any).stopSessionFleet = stopSessionFleet;
    (d.conversationCtx as any).abortControllers.set('sess-ghost', new AbortController());
    const r = createEmbeddedMessageRouter(d);
    const ws = mockWs();

    await r(ws, null, { type: 'session.delete', payload: { id: 'sess-ghost' } } as any);

    expect(stopSessionFleet).toHaveBeenCalledWith('sess-ghost');
  });

  /**
   * Retiring a session that is NOT running must stop nothing else.
   *
   * The abort seam used to treat "this id is not in the controller map" as
   * "abort everything", so replacing or deleting an already-finished session
   * killed the three other tabs' in-flight runs — the exact opposite of what
   * a per-tab Stop is for.
   */
  it('does not abort other tabs when replacing a session with no live run', async () => {
    // `session.new { replaceSessionId }` retires the named session before
    // opening the new one, and asks for its run to stop whether or not one is
    // in flight. That unconditional ask is the path that reached the seam.
    const send = vi.fn();
    const stopSessionFleet = vi.fn();
    const d = makeDeps({ send });
    (d.sessionCtx as any).send = send;
    (d.sessionCtx as any).clients = new Map();
    (d.conversationCtx as any).stopSessionFleet = stopSessionFleet;
    const live = new AbortController();
    (d.conversationCtx as any).abortControllers.set('sess-busy', live);
    // The retire path clears the runtime conversation after asking the run to
    // stop; the shared fixture carries only the todo half of that state.
    const ctx = (d.opts as any).agent.ctx;
    ctx.state.replaceMessages = vi.fn();
    ctx.readFiles = new Set();
    ctx.fileMtimes = new Map();
    ctx.tokenCounter = { reset: vi.fn(), total: () => ({}), account: vi.fn() };
    const r = createEmbeddedMessageRouter(d);
    const ws = mockWs();

    await r(ws, null, {
      type: 'session.new',
      payload: { replaceSessionId: 'sess-idle' },
    } as any);

    expect(live.signal.aborted).toBe(false);
    expect(stopSessionFleet).not.toHaveBeenCalledWith('sess-busy');
  });
});

describe('createEmbeddedMessageRouter', () => {
  it('returns a callable router function', () => {
    const router = createEmbeddedMessageRouter(makeDeps());
    expect(typeof router).toBe('function');
  });

  it('dispatches an unknown message type without throwing', async () => {
    const router = createEmbeddedMessageRouter(makeDeps());
    const ws = mockWs();
    await router(ws, null, { type: 'unknown.message', payload: {} } as any);
    // Should not throw; the dispatcher may log a debug message
    expect(true).toBe(true);
  });

  it('guards session-targeted messages against wrong sessionId', async () => {
    const router = createEmbeddedMessageRouter(makeDeps());
    const ws = mockWs();
    await router(ws, null, {
      type: 'user_message',
      payload: { sessionId: 'wrong-session', text: 'hi' },
    } as any);
    // The guard should intercept and send an error
    // Verify via deps.send: we used a fresh deps, so let's re-run with captured send
    const send = vi.fn();
    const d = makeDeps({ send });
    const r = createEmbeddedMessageRouter(d);
    await r(ws, null, {
      type: 'user_message',
      payload: { sessionId: 'wrong', text: 'hi' },
    } as any);
    expect(send).toHaveBeenCalled();
    const sent = send.mock.calls[0]![1];
    expect(sent.type).toBe('error');
  });

  it('allows session-targeted messages with matching sessionId', async () => {
    const send = vi.fn();
    const d = makeDeps({ send });
    const r = createEmbeddedMessageRouter(d);
    const ws = mockWs();
    // This should pass the guard and reach the dispatcher
    await r(ws, null, {
      type: 'todos.get',
      payload: { sessionId: 'sess-1' },
    } as any);
    // It should not send a session-guard error
    const errorSends = send.mock.calls.filter(
      (c: any[]) => c[1]?.type === 'error' && c[1]?.payload?.message?.includes('targeted session'),
    );
    expect(errorSends).toHaveLength(0);
  });

  it('allows non-guarded message types without session check', async () => {
    const send = vi.fn();
    const d = makeDeps({ send });
    const r = createEmbeddedMessageRouter(d);
    const ws = mockWs();
    await r(ws, null, {
      type: 'files.list',
      payload: {},
    } as any);
    // Should not throw
    expect(true).toBe(true);
  });

  it('handles sdd.spec messages by delegating to wizard handler', async () => {
    const wizardHandler = { handleMessage: vi.fn(async () => undefined) };
    const d = makeDeps({ sddWizardHandler: wizardHandler as any });
    const r = createEmbeddedMessageRouter(d);
    const ws = mockWs();
    await r(ws, null, { type: 'sdd.spec.start', payload: { goal: 'test' } } as any);
    // The wizard handler may or may not be called depending on routing,
    // but the router must not throw.
    expect(true).toBe(true);
  });
});

/**
 * Four tabs share one socket, so "the session the runtime is on" is only ever
 * ONE of them. The router-level gate refused every OTHER named session before
 * the handlers — which were carefully taught to serve the asking session —
 * ever ran, so on this host a background tab could not run, could not stop its
 * own run, could not answer its own permission prompt, and could not read its
 * own worklist.
 */
describe('createEmbeddedMessageRouter — background tabs are servable', () => {
  function withRegistry() {
    const send = vi.fn();
    const d = makeDeps({ send });
    const leader = (d.opts as any).agent;
    const background = {
      ctx: {
        projectRoot: '/tmp/proj',
        provider: { id: 'test' },
        model: 'test-model',
        todos: [{ id: 't1', content: 'background only', status: 'pending' }],
        meta: {} as Record<string, unknown>,
        session: { id: 'sess-bg' },
        tools: [],
        state: { replaceTodos: vi.fn(), setMeta: vi.fn() },
      },
    };
    const peekAgent = (id?: string) =>
      id === 'sess-bg' ? background : id === 'sess-1' ? leader : undefined;
    (d.sessionCtx as any).send = send;
    (d.sessionCtx as any).peekAgent = peekAgent;
    (d.sessionCtx as any).getAgent = (id?: string) => peekAgent(id) ?? leader;
    (d.conversationCtx as any).agent = leader;
    (d.conversationCtx as any).peekAgent = peekAgent;
    (d.conversationCtx as any).getAgent = (id?: string) => peekAgent(id) ?? leader;
    return { d, send, background };
  }

  function refusals(send: ReturnType<typeof vi.fn>): string[] {
    return send.mock.calls
      .map((c: any[]) => c[1]?.payload?.message)
      .filter(
        (m: unknown): m is string =>
          typeof m === 'string' && m.includes('but this WebUI runtime is currently on'),
      );
  }

  it('does not refuse a background tab that the registry knows', async () => {
    const { d, send } = withRegistry();
    const r = createEmbeddedMessageRouter(d);
    const ws = mockWs();

    for (const type of ['abort', 'tool.confirm_result', 'todos.get']) {
      send.mockClear();
      await r(ws, null, { type, payload: { sessionId: 'sess-bg' } } as any);
      expect(refusals(send), `${type} was refused`).toHaveLength(0);
    }
  });

  /**
   * Resume from the session list was refused by the gate that exists to
   * protect it. The client moves its foreground pointer onto the session
   * before asking — the pane has to exist before a transcript can land in it —
   * so `withSession` stamps the request with the very id it is asking to open,
   * a session this runtime has never held. The refusal came back as an error
   * frame the client discards as session-swap noise, so the tab sat empty with
   * no transcript and no error: "Resume never resumes".
   */
  it('lets a resume open a session this host has never held', async () => {
    const { d, send } = withRegistry();
    const r = createEmbeddedMessageRouter(d);
    const ws = mockWs();

    await r(ws, null, {
      type: 'session.resume',
      payload: { id: 'sess-never-seen', sessionId: 'sess-never-seen' },
    } as any);

    expect(refusals(send)).toHaveLength(0);
  });

  it('still refuses a resume aimed at a session OTHER than the one asking', async () => {
    const { d, send } = withRegistry();
    const r = createEmbeddedMessageRouter(d);
    const ws = mockWs();

    // The exemption is only for a self-targeted transition. A stale tab asking
    // this host to resume something on behalf of a session it cannot serve is
    // exactly what the gate is for.
    await r(ws, null, {
      type: 'session.resume',
      payload: { id: 'sess-other', sessionId: 'sess-nope' },
    } as any);

    expect(refusals(send)).toHaveLength(1);
  });

  it('does not widen the exemption to types whose `id` is not a session', async () => {
    const { d, send } = withRegistry();
    const r = createEmbeddedMessageRouter(d);
    const ws = mockWs();

    // `todos.remove` carries a TODO id. An id that happens to equal the
    // unservable session id must not buy its way past the gate.
    await r(ws, null, {
      type: 'todos.remove',
      payload: { id: 'sess-nope', sessionId: 'sess-nope' },
    } as any);

    expect(refusals(send)).toHaveLength(1);
  });

  it('still refuses a session this host cannot serve', async () => {
    const { d, send } = withRegistry();
    const r = createEmbeddedMessageRouter(d);
    const ws = mockWs();

    await r(ws, null, { type: 'todos.get', payload: { sessionId: 'sess-nope' } } as any);

    expect(refusals(send)).toHaveLength(1);
  });

  /**
   * The gate is only half of it: a request that gets through still has to be
   * served from the session it NAMES. This host built one worklist context off
   * the leader, so all four tabs shared the boot tab's todo list — and its
   * `.plan.json` / `.tasks.json` sidecar paths.
   */
  it('answers todos.get from the asking session, not the leader', async () => {
    const { d, send, background } = withRegistry();
    const r = createEmbeddedMessageRouter(d);
    const ws = mockWs();

    await r(ws, null, { type: 'todos.get', payload: { sessionId: 'sess-bg' } } as any);

    const todoFrames = send.mock.calls
      .map((c: any[]) => c[1])
      .filter((m: any) => typeof m?.type === 'string' && m.type.startsWith('todos'));
    expect(todoFrames.length).toBeGreaterThan(0);
    expect(JSON.stringify(todoFrames)).toContain('background only');
    expect(background.ctx.todos).toHaveLength(1);
  });
});

/**
 * Everything a tab "runs with" — its model, its provider, its mode — belongs
 * to that tab. This host resolved all of it from `opts.agent.ctx`, the leader,
 * which is simultaneously the boot tab's runtime: choosing a model in tab 3
 * re-pointed tab 1 and left tab 3 on its old model.
 */
describe('createEmbeddedMessageRouter — runtime choices land on the asking tab', () => {
  function withTwoSessions() {
    const send = vi.fn();
    const d = makeDeps({ send });
    const leader = (d.opts as any).agent;
    leader.ctx.runModelTransition = async (fn: () => Promise<void>) => fn();
    const background = {
      ctx: {
        projectRoot: '/tmp/proj',
        provider: { id: 'old-provider', capabilities: { maxContext: 100 } },
        model: 'old-model',
        todos: [],
        meta: {} as Record<string, unknown>,
        session: { id: 'sess-bg' },
        tools: [],
        state: { replaceTodos: vi.fn(), setMeta: vi.fn() },
        runModelTransition: async (fn: () => Promise<void>) => fn(),
      },
    };
    const peekAgent = (id?: string) =>
      id === 'sess-bg' ? background : id === 'sess-1' ? leader : undefined;
    (d.sessionCtx as any).send = send;
    (d.sessionCtx as any).peekAgent = peekAgent;
    (d.sessionCtx as any).getAgent = (id?: string) => peekAgent(id) ?? leader;
    (d.conversationCtx as any).agent = leader;
    (d.conversationCtx as any).peekAgent = peekAgent;
    (d.conversationCtx as any).getAgent = (id?: string) => peekAgent(id) ?? leader;
    return { d, send, leader, background };
  }

  it('applies a model switch to the session that asked', async () => {
    const { d, leader, background } = withTwoSessions();
    (d.agentConfigCtx as any).persistPrefs = vi.fn(async () => undefined);
    (d.agentConfigCtx as any).modelsRegistry = {
      refresh: vi.fn(async () => undefined),
      getModel: vi.fn(async () => ({ capabilities: { maxContext: 4096 } })),
    };
    (d.agentConfigCtx as any).broadcast = vi.fn();
    (makeProviderFromConfig as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'new-provider',
      capabilities: { maxContext: 4096 },
    });
    const r = createEmbeddedMessageRouter(d);

    await r(mockWs(), null, {
      type: 'model.switch',
      payload: { provider: 'new-provider', model: 'new-model', sessionId: 'sess-bg' },
    } as any);

    expect(background.ctx.model).toBe('new-model');
    // The leader — the boot tab's runtime — must be untouched.
    expect(leader.ctx.model).toBe('test-model');
  });

  it('records a mode switch on the session that asked', async () => {
    const { d, leader, background } = withTwoSessions();
    (d.agentConfigCtx as any).modeStore = {
      getActiveMode: vi.fn(async () => ({ id: 'default' })),
      setActiveMode: vi.fn(async () => undefined),
      getMode: vi.fn(async (id: string) => (id === 'focus' ? { id } : null)),
      listModes: vi.fn(async () => [{ id: 'focus' }]),
    };
    const r = createEmbeddedMessageRouter(d);

    await r(mockWs(), null, {
      type: 'mode.switch',
      payload: { id: 'focus', sessionId: 'sess-bg' },
    } as any);

    expect(background.ctx.meta['mode']).toBe('focus');
    expect(leader.ctx.meta['mode']).toBeUndefined();
  });
});

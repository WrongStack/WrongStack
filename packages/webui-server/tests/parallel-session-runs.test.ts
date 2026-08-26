import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { createConversationOperations } from '../src/server/conversation-operations.js';
import { createSessionHandlers } from '../src/server/session-handlers.js';

/**
 * Parallel-session guarantees for the multi-tab WebUI:
 *
 *  G1 — switching tabs (session.resume) must never abort or mutate the
 *       previous tab's in-flight run.
 *  G2 — a session that is running keeps its live agent context; resuming
 *       back into it replays the LIVE transcript and skips message
 *       replacement.
 *  G3 — up to 4 sessions can run concurrently; runs are keyed by session,
 *       never by socket or global lock.
 *  G4 — run-starting conversation ops cannot interleave with an in-flight
 *       session transition (no run on a half-swapped / empty context).
 *
 * These tests pin the guarantees at the handler level using the same
 * harness shape as session-swap-lifecycle.test.ts.
 */

const ws = {} as WebSocket;

// ---------------------------------------------------------------------------
// Session-handler harness
// ---------------------------------------------------------------------------

function writer(id: string) {
  return {
    id,
    append: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    truncateToCheckpoint: vi.fn(async () => undefined),
  };
}

interface HarnessInput {
  current?: ReturnType<typeof writer>;
  created?: ReturnType<typeof writer>;
  resumed?: ReturnType<typeof writer>;
  /** Sessions with an active run, e.g. { sess_a: true }. */
  running?: Record<string, boolean>;
}

function makeSessionHarness(input: HarnessInput = {}) {
  const current0 = input.current ?? writer('sess_a');
  let current = current0;
  const running = input.running ?? {};
  const isRunActive = vi.fn((sessionId?: string) =>
    sessionId ? Boolean(running[sessionId]) : Object.values(running).some(Boolean),
  );
  const abortActiveRun = vi.fn();

  /** Ordered op log to pin resolve-order invariants (G2/E). */
  const ops: Array<{ op: string; id?: string; sessionNow: string }> = [];
  const agents = new Map<
    string,
    {
      ctx: {
        session: unknown;
        messages: Array<{ role: string; content: string }>;
        state: {
          replaceMessages: ReturnType<typeof vi.fn>;
          replaceTodos: ReturnType<typeof vi.fn>;
          setMeta: ReturnType<typeof vi.fn>;
          deleteMeta: ReturnType<typeof vi.fn>;
        };
        readFiles: Set<string>;
        fileMtimes: Map<string, number>;
        flushConversationJournal: () => Promise<void>;
        clearMemoryEvidence: () => void;
      };
    }
  >();
  const makeAgent = (id: string, messages: Array<{ role: string; content: string }>) => {
    const agent = {
      ctx: {
        session: null,
        messages,
        state: {
          replaceMessages: vi.fn(),
          replaceTodos: vi.fn(),
          setMeta: vi.fn(),
          deleteMeta: vi.fn(),
        },
        readFiles: new Set<string>(),
        fileMtimes: new Map<string, number>(),
        flushConversationJournal: vi.fn(async () => undefined),
        clearMemoryEvidence: vi.fn(),
      },
    };
    agents.set(id, agent);
    return agent;
  };
  // The boot session starts on the shared root agent, mirroring
  // backend-services' sessionAgents boot registration.
  makeAgent(current0.id, [{ role: 'user', content: 'live in-flight turn' }]);

  const getAgent = vi.fn((sessionId?: string) => {
    ops.push({
      op: 'getAgent',
      ...(sessionId !== undefined ? { id: sessionId } : {}),
      sessionNow: current.id,
    });
    if (!sessionId) return agents.get(current0.id);
    return agents.get(sessionId) ?? makeAgent(sessionId, []);
  });

  const context = {
    session: current0,
    messages: [{ role: 'user', content: 'live in-flight turn' }],
    provider: { id: 'p' },
    lastRequestTokens: 1,
    lastRealInputTokens: 1,
    state: {
      replaceMessages: vi.fn(),
      replaceTodos: vi.fn(),
      setMeta: vi.fn(),
      deleteMeta: vi.fn(),
    },
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
  };
  const sent: Array<{ type: string; payload: unknown }> = [];
  const wsFake = {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data) as { type: string; payload: unknown }),
  } as unknown as WebSocket;
  const store = {
    create: vi.fn(async () => input.created ?? writer('sess_next')),
    delete: vi.fn(async () => undefined),
    resume: vi.fn(async (sessionId: string) => ({
      writer: input.resumed ?? writer(sessionId),
      data: {
        messages: [{ role: 'user', content: `persisted ${sessionId}` }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    })),
    list: vi.fn(async () => []),
  };
  const setSession = vi.fn((next: { id: string }) => {
    ops.push({ op: 'setSession', id: next.id, sessionNow: current.id });
    current = next as typeof current;
  });
  const sessionStartPayload = vi.fn(async (overrides: Record<string, unknown> = {}) => ({
    sessionId: current.id,
    model: 'm',
    provider: 'p',
    maxContext: 100,
    projectName: 'proj',
    projectRoot: '/proj',
    cwd: '/proj',
    mode: 'default',
    contextMode: 'balanced',
    ...overrides,
  }));

  const routes = createSessionHandlers({
    config: { provider: 'p', model: 'm' },
    clients: new Map(),
    context: context as never,
    toolRegistry: {} as never,
    compactor: {} as never,
    customModeStore: {} as never,
    tokenCounter: {
      total: vi.fn(() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
      reset: vi.fn(),
      account: vi.fn(),
    } as never,
    getProjectRoot: () => '/proj',
    getSession: () => current as never,
    getSessionStore: () => store as never,
    sessionsDir: '/proj/.wrongstack/sessions',
    setSession: setSession as never,
    setSessionStartedAt: vi.fn(),
    claimSession: vi.fn(async () => async () => undefined),
    onSessionSwapped: vi.fn(async () => undefined),
    abortActiveRun,
    isRunActive,
    getAgent: getAgent as never,
    sessionStartPayload: sessionStartPayload as never,
  });

  return {
    routes,
    ws: wsFake,
    sent,
    store,
    ops,
    agents,
    abortActiveRun,
    isRunActive,
    sessionStartPayload,
    /** Register (or fetch) a session's agent the way getAgent would. */
    ensureAgent: (id: string) => agents.get(id) ?? makeAgent(id, []),
    currentId: () => current.id,
    currentWriter: () => current,
  };
}

// ---------------------------------------------------------------------------
// Conversation-ops harness
// ---------------------------------------------------------------------------

function makeConversationHarness(
  options: { withSessionTransition?: <T>(fn: () => Promise<T>) => Promise<T> } = {},
) {
  const sent: Array<{ type: string; payload: unknown }> = [];
  const controllers = new Map<string, AbortController>();
  const runGates = new Map<string, (result: { status: string; finalText: string }) => void>();
  const agentFor = (sessionId: string) => ({
    run: vi.fn(
      (input: string) =>
        new Promise((resolve) => {
          runGates.set(sessionId, resolve as never);
          void input;
        }),
    ),
    ctx: {
      provider: { id: 'p', capabilities: { vision: false } },
      model: 'm',
      messages: [{ role: 'user', content: `history ${sessionId}` }],
      meta: {},
    },
    tools: { list: () => [] },
  });
  const runCalls: Array<{ sessionId: string; messages: unknown }> = [];
  const getAgent = (sessionId?: string) => {
    const id = sessionId ?? 'session-live';
    const agent = agentFor(id);
    runCalls.push({ sessionId: id, messages: agent.ctx.messages });
    return agent;
  };
  const routes = createConversationOperations({
    getAgent: getAgent as never,
    getSessionId: () => 'session-live',
    hasSession: () => true,
    runControl: {
      begin: (_ws, sessionId) => {
        if (controllers.has(sessionId)) return undefined;
        const controller = new AbortController();
        controllers.set(sessionId, controller);
        return controller;
      },
      end: (_ws, sessionId, controller) => {
        if (controllers.get(sessionId) === controller) controllers.delete(sessionId);
      },
      abort: (_ws, sessionId) => controllers.get(sessionId)?.abort(),
    },
    pendingConfirms: new Map(),
    send: (_ws, message) => sent.push(message),
    notifyAbort: (_ws, message) => sent.push(message),
    ...(options.withSessionTransition
      ? { withSessionTransition: options.withSessionTransition }
      : {}),
  });
  const send = (sessionId: string, content = `hello ${sessionId}`) =>
    routes.userMessage(ws, {
      type: 'user_message',
      payload: { content, sessionId },
    } as never);
  /**
   * Resolve a session's in-flight run. Waits (bounded) for `agent.run()` to
   * actually be reached first: how many microtask ticks separate the caller
   * from the run is an implementation detail, and hard-coding it in every
   * test makes the spec brittle rather than precise.
   */
  const finishRun = async (sessionId: string) => {
    for (let i = 0; i < 50 && !runGates.has(sessionId); i += 1) await Promise.resolve();
    runGates.get(sessionId)?.({ status: 'completed', finalText: `done ${sessionId}` });
  };
  return { routes, sent, send, finishRun, controllers, runGates, runCalls };
}

// ---------------------------------------------------------------------------
// G1 — switching tabs never aborts the previous tab's run
// ---------------------------------------------------------------------------

describe('parallel session guarantees — session transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('G1a: resume to another session does not abort the previous session (running tab survives switch)', async () => {
    const h = makeSessionHarness({ running: { sess_a: true } });
    await h.routes.resumeSession(h.ws, {
      type: 'session.resume',
      payload: { id: 'sess_b' },
    });
    expect(h.abortActiveRun).not.toHaveBeenCalled();
    expect(h.isRunActive).toHaveBeenCalled();
  });

  it('G1b: session.new while the current session is running does not abort or finalize it', async () => {
    const running = writer('sess_a');
    const next = writer('sess_next');
    const h = makeSessionHarness({ current: running, created: next, running: { sess_a: true } });

    // This is exactly what the WebUI client sends today: withSession() stamps
    // the active session id onto session.new.
    await h.routes.newSession(h.ws, {
      type: 'session.new',
      payload: { sessionId: 'sess_a' },
    });

    expect(h.abortActiveRun).not.toHaveBeenCalledWith('sess_a');
    expect(running.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_end' }),
    );
    expect(running.close).not.toHaveBeenCalled();
    expect(h.currentId()).toBe('sess_next');
  });

  it('G1c: session.new leaves an IDLE session open too — a background tab is not garbage', async () => {
    const idle = writer('sess_idle');
    const next = writer('sess_next');
    const h = makeSessionHarness({ current: idle, created: next });

    await h.routes.newSession(h.ws, {
      type: 'session.new',
      payload: { sessionId: 'sess_idle' },
    });

    // Idle is not the same as disposable: the user can click straight back
    // into that tab, and a finalized writer makes its history unappendable.
    expect(idle.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session_end' }));
    expect(idle.close).not.toHaveBeenCalled();
    expect(h.currentId()).toBe('sess_next');
  });

  it('G1d: retiring a session on session.new is opt-in via replaceSessionId', async () => {
    const idle = writer('sess_idle');
    const next = writer('sess_next');
    const h = makeSessionHarness({ current: idle, created: next });

    await h.routes.newSession(h.ws, {
      type: 'session.new',
      payload: { replaceSessionId: 'sess_idle' },
    });

    expect(h.abortActiveRun).toHaveBeenCalledWith('sess_idle');
    expect(idle.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'session_end' }));
    expect(idle.close).toHaveBeenCalledOnce();
    expect(h.currentId()).toBe('sess_next');
  });

  it('G2a: resuming a RUNNING session skips message replacement on its live context', async () => {
    const h = makeSessionHarness({ running: { sess_a: true } });
    await h.routes.resumeSession(h.ws, {
      type: 'session.resume',
      payload: { id: 'sess_a' },
    });
    // sess_a is the boot session → its agent IS the shared root; the live
    // in-flight messages must not be replaced.
    const sharedAgent = h.agents.get('sess_a')!;
    expect(sharedAgent.ctx.state.replaceMessages).not.toHaveBeenCalled();
  });

  it('G2b: resume-to-running replays the LIVE agent transcript, not the stale persisted one', async () => {
    const h = makeSessionHarness({
      current: writer('sess_other'),
      resumed: writer('sess_a'),
      running: { sess_a: true },
    });
    // Register sess_a's agent (the harness only auto-seeds the boot session)
    // and make its live transcript distinguishable from the persisted one.
    h.ensureAgent('sess_a').ctx.messages.push({ role: 'assistant', content: 'STREAMING NOW' });

    await h.routes.resumeSession(h.ws, {
      type: 'session.resume',
      payload: { id: 'sess_a' },
    });

    const start = h.sent.find((m) => m.type === 'session.start');
    expect(start).toBeTruthy();
    const replay = (start?.payload as { replayMessages?: Array<Record<string, unknown>> })
      ?.replayMessages;
    const replayed = JSON.stringify(replay ?? []);
    expect(replayed).toContain('STREAMING NOW');
    expect(replayed).not.toContain('persisted sess_a');
    expect((start?.payload as { isRunning?: boolean })?.isRunning).toBe(true);
  });

  it('G2c/E: the target agent is resolved BEFORE the active session is re-pointed (no shared-context hijack)', async () => {
    const h = makeSessionHarness({
      current: writer('sess_a'),
      resumed: writer('sess_b'),
      running: { sess_a: true },
    });

    await h.routes.resumeSession(h.ws, {
      type: 'session.resume',
      payload: { id: 'sess_b' },
    });

    const getAgentCall = h.ops.find((o) => o.op === 'getAgent' && o.id === 'sess_b');
    const setSessionCall = h.ops.find((o) => o.op === 'setSession' && o.id === 'sess_b');
    expect(getAgentCall).toBeTruthy();
    expect(setSessionCall).toBeTruthy();
    // Resolving sess_b's agent must happen while the runtime still reports
    // sess_a active — otherwise a shared root agent mid-run for sess_a gets
    // adopted for sess_b and its live messages wiped.
    expect(getAgentCall!.sessionNow).toBe('sess_a');
    expect(h.ops.indexOf(getAgentCall!)).toBeLessThan(h.ops.indexOf(setSessionCall!));
    // And the running session's live context is untouched by the swap.
    expect(h.agents.get('sess_a')!.ctx.state.replaceMessages).not.toHaveBeenCalled();
    // sess_b got its own context hydrated from persisted messages.
    expect(h.agents.get('sess_b')!.ctx.state.replaceMessages).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// G3/G4 — conversation ops
// ---------------------------------------------------------------------------

describe('parallel session guarantees — conversation ops', () => {
  it('G3: four sessions run concurrently; results are stamped per session', async () => {
    const h = makeConversationHarness();
    const ids = ['sess_1', 'sess_2', 'sess_3', 'sess_4'];
    const runs = ids.map((id) => h.send(id));
    await Promise.resolve();
    await Promise.resolve();

    // All four began — no global busy lock.
    expect([...h.controllers.keys()].sort()).toEqual([...ids].sort());
    // All four agent runs are in flight with their own session history.
    for (const call of h.runCalls) {
      expect(JSON.stringify(call.messages)).toContain(`history ${call.sessionId}`);
    }
    expect(h.sent.filter((m) => m.type === 'error')).toHaveLength(0);

    h.finishRun('sess_2');
    h.finishRun('sess_1');
    h.finishRun('sess_4');
    h.finishRun('sess_3');
    await Promise.all(runs);

    const results = h.sent.filter((m) => m.type === 'run.result');
    expect(results).toHaveLength(4);
    for (const id of ids) {
      expect(results.some((m) => (m.payload as { sessionId?: string })?.sessionId === id)).toBe(
        true,
      );
    }
  });

  it('G3b: a busy session rejects only its own session, not the others', async () => {
    const h = makeConversationHarness();
    const first = h.send('sess_1');
    await Promise.resolve();
    const second = h.send('sess_1'); // same session → busy
    const other = h.send('sess_2'); // different session → allowed
    await Promise.resolve();

    const busyErrors = h.sent.filter(
      (m) => m.type === 'error' && (m.payload as { sessionId?: string })?.sessionId === 'sess_1',
    );
    expect(busyErrors.length).toBeGreaterThan(0);
    expect(h.controllers.has('sess_2')).toBe(true);

    h.finishRun('sess_1');
    h.finishRun('sess_2');
    await Promise.all([first, second, other]);
  });

  it('G4: user_message setup runs inside the session-transition gate, the run outside it', async () => {
    let gateHeld = false;
    let releaseGate!: () => void;
    const gate = vi.fn(async (fn: () => Promise<unknown>) => {
      gateHeld = true;
      await new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      gateHeld = false;
      return fn();
    });
    const h = makeConversationHarness({ withSessionTransition: gate as never });

    const pending = h.send('sess_1');
    await Promise.resolve();
    await Promise.resolve();

    // Gate captured; run must NOT have started while a session transition
    // could be in flight.
    expect(gate).toHaveBeenCalled();
    expect(h.controllers.has('sess_1')).toBe(false);

    releaseGate();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Gate released → setup completed → run started (and still in flight:
    // the gate is not held for the duration of the run).
    expect(h.controllers.has('sess_1')).toBe(true);
    expect(gateHeld).toBe(false);

    h.finishRun('sess_1');
    await pending;
    expect(
      h.sent.some(
        (m) =>
          m.type === 'run.result' && (m.payload as { sessionId?: string })?.sessionId === 'sess_1',
      ),
    ).toBe(true);
  });
});

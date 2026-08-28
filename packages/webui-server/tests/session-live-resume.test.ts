import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import {
  createSessionAgentRegistry,
  inheritedSessionMeta,
} from '../src/server/session-agent-registry.js';
import { createSessionHandlers } from '../src/server/session-handlers.js';

/**
 * What happens when a tab is switched to, and when one is closed.
 *
 * Four tabs turn "resume this session" into the most-travelled path in the
 * product: it fires on every click of the tab strip, not just on picking a
 * session out of history. The cost of getting it wrong is not a slow click —
 * it is a second journal writer on a file that already has one, an agent
 * evicted out from under a tab the user is looking at, and a spinner that
 * never stops.
 */

const ws = {} as WebSocket;

type Writer = { id: string; append: () => Promise<void>; close: () => Promise<void> };
const writer = (id: string): Writer => ({
  id,
  append: async () => undefined,
  close: async () => undefined,
});

function harness(options?: { live?: string[] }) {
  const bootWriter = writer('sess_boot');
  const contexts = new Map<string, Record<string, unknown>>();
  const mkCtx = (id: string) => {
    const ctx = {
      session: writer(id),
      lastRequestTokens: id === 'sess_bg' ? 4242 : 7,
      state: {
        messages: [{ role: 'user', content: `transcript of ${id}` }],
        todos: [],
        replaceMessages: vi.fn(),
        replaceTodos: vi.fn(),
        setMeta: vi.fn(),
        deleteMeta: vi.fn(),
      },
      readFiles: new Set<string>(),
      fileMtimes: new Map<string, number>(),
      messages: [{ role: 'user', content: `transcript of ${id}` }],
      provider: { id: 'p' },
      flushConversationJournal: vi.fn(async () => undefined),
      clearMemoryEvidence: vi.fn(),
    };
    contexts.set(id, ctx as unknown as Record<string, unknown>);
    return ctx;
  };
  const rootCtx = mkCtx('sess_boot');
  rootCtx.session = bootWriter;
  for (const id of options?.live ?? []) mkCtx(id);

  const resumeCalls: string[] = [];
  const sent: Array<{ type: string; payload: unknown }> = [];
  let current: Writer = bootWriter;

  const handlers = createSessionHandlers({
    config: { model: 'm', provider: 'p' },
    context: rootCtx as never,
    tokenCounter: { account: vi.fn(), total: () => ({}), reset: vi.fn() } as never,
    getProjectRoot: () => '/repo',
    getSession: () => current as never,
    setSession: (next) => {
      current = next as never;
    },
    getSessionStore: () =>
      ({
        resolveId: async (id: string) => id,
        resume: async (id: string) => {
          resumeCalls.push(id);
          return { writer: writer(id), data: { messages: [], events: [], usage: undefined } };
        },
        list: async () => [],
      }) as never,
    isSessionLive: (id) => contexts.has(id),
    isRunActive: (id) => id === 'sess_running',
    getAgent: (id) => ({ ctx: contexts.get(id ?? '') ?? rootCtx }) as never,
    sessionStartPayload: async (overrides) => ({ ...overrides }) as never,
    sendMessage: (_ws, message) => sent.push(message),
    broadcastMessage: (message) => sent.push(message),
  });

  return { handlers, resumeCalls, sent, currentId: () => current.id };
}

describe('resuming a tab that is already open', () => {
  it('answers a live background session from memory instead of re-opening its journal', async () => {
    const h = harness({ live: ['sess_bg'] });

    await h.handlers.resumeSession(ws, { type: 'session.resume', payload: { id: 'sess_bg' } });

    // The whole point: no second FileSessionWriter, no second file handle, no
    // re-read of the transcript — on a path that runs on every tab click.
    expect(h.resumeCalls).toEqual([]);
    const start = h.sent.find((m) => m.type === 'session.start');
    expect(start?.payload).toMatchObject({ sessionId: 'sess_bg', isRunning: false });
  });

  it('reports the resumed tab’s own context estimate, not the runtime’s', async () => {
    const h = harness({ live: ['sess_bg'] });

    await h.handlers.resumeSession(ws, { type: 'session.resume', payload: { id: 'sess_bg' } });

    const start = h.sent.find((m) => m.type === 'session.start');
    const payload = start?.payload as { replayUsage?: { input?: number } } | undefined;
    expect(payload?.replayUsage?.input).toBe(4242);
  });

  it('moves the foreground pointer onto the session it just brought forward', async () => {
    const h = harness({ live: ['sess_bg'] });

    await h.handlers.resumeSession(ws, { type: 'session.resume', payload: { id: 'sess_bg' } });

    expect(h.currentId()).toBe('sess_bg');
  });

  it('still opens the journal for a session this process has never held', async () => {
    const h = harness();

    await h.handlers.resumeSession(ws, { type: 'session.resume', payload: { id: 'sess_cold' } });

    expect(h.resumeCalls).toEqual(['sess_cold']);
  });
});

describe('session.subscribe', () => {
  function subscribeHarness() {
    const clients = new Map<WebSocket, { sessionId: string | null; sessionIds?: Set<string> }>();
    clients.set(ws, { sessionId: null });
    const sent: Array<{ type: string; payload: unknown }> = [];
    const undisplayed: string[][] = [];
    const handlers = createSessionHandlers({
      config: { model: 'm', provider: 'p' },
      context: { session: writer('sess_boot') } as never,
      tokenCounter: { account: vi.fn(), total: () => ({}) } as never,
      clients: clients as never,
      getProjectRoot: () => '/repo',
      getSession: () => writer('sess_boot') as never,
      setSession: vi.fn(),
      getSessionStore: () => ({}) as never,
      isRunActive: (id) => id === 'sess_2',
      onSessionsUndisplayed: (ids) => undisplayed.push(ids),
      sessionStartPayload: async (o) => ({ ...o }) as never,
      sendMessage: (_ws, message) => sent.push(message),
      broadcastMessage: (message) => sent.push(message),
    });
    return { handlers, sent, undisplayed, clients };
  }

  it('answers every declared tab with its own run state', async () => {
    const h = subscribeHarness();

    await h.handlers.subscribeSessions(ws, {
      type: 'session.subscribe',
      payload: { sessionIds: ['sess_1', 'sess_2'] },
    });

    const states = h.sent.filter((m) => m.type === 'session.run_state').map((m) => m.payload);
    // Without this, a tab whose run ended while the socket was down spins for
    // the rest of the page's life.
    expect(states).toEqual([
      { sessionId: 'sess_1', isRunning: false },
      { sessionId: 'sess_2', isRunning: true },
    ]);
  });

  it('hard-caps the declared set at four, keeping the acting session', async () => {
    const h = subscribeHarness();
    const client = h.clients.get(ws);
    if (!client) throw new Error('client missing');
    client.sessionId = 'sess_acting';

    // Five distinct ids declared while the acting session is NOT among them:
    // the set must not grow past the four-tab ceiling, and the acting
    // session — the tab in front — must survive (the last DECLARED id gives
    // up its slot instead).
    await h.handlers.subscribeSessions(ws, {
      type: 'session.subscribe',
      payload: { sessionIds: ['sess_1', 'sess_2', 'sess_3', 'sess_4', 'sess_5'] },
    });

    const subscribed = client.sessionIds;
    expect(subscribed?.size).toBe(4);
    expect(subscribed?.has('sess_acting')).toBe(true);
    expect(subscribed?.has('sess_1')).toBe(true);
    expect(subscribed?.has('sess_2')).toBe(true);
    expect(subscribed?.has('sess_3')).toBe(true);
    expect(subscribed?.has('sess_4')).toBe(false);
  });

  it('does not evict anything when the acting session is already declared', async () => {
    const h = subscribeHarness();
    const client = h.clients.get(ws);
    if (!client) throw new Error('client missing');
    client.sessionId = 'sess_1';

    await h.handlers.subscribeSessions(ws, {
      type: 'session.subscribe',
      payload: { sessionIds: ['sess_1', 'sess_2', 'sess_3', 'sess_4'] },
    });

    expect(client.sessionIds).toEqual(
      new Set(['sess_1', 'sess_2', 'sess_3', 'sess_4']),
    );
  });

  it('reports the sessions that just lost their last viewer', async () => {
    const h = subscribeHarness();
    await h.handlers.subscribeSessions(ws, {
      type: 'session.subscribe',
      payload: { sessionIds: ['sess_1', 'sess_2'] },
    });
    h.undisplayed.length = 0;

    await h.handlers.subscribeSessions(ws, {
      type: 'session.subscribe',
      payload: { sessionIds: ['sess_1'] },
    });

    expect(h.undisplayed).toEqual([['sess_2']]);
  });

  it('gives every declared tab a leader of its own', async () => {
    const h = subscribeHarness();

    await h.handlers.subscribeSessions(ws, {
      type: 'session.subscribe',
      payload: { sessionIds: ['sess_1', 'sess_2'] },
    });

    const leaders = h.sent
      .filter((m) => m.type === 'subagent.event')
      .map((m) => m.payload as { kind: string; sessionId: string; subagentId: string });
    expect(leaders.map((l) => l.kind)).toEqual(['leader_updated', 'leader_updated']);
    expect(leaders.map((l) => l.sessionId)).toEqual(['sess_1', 'sess_2']);
    // Distinct ids matter as much as distinct stamps: the roster is a map
    // keyed by subagent id, so one shared `leader` row meant the second tab's
    // announcement re-pointed the first tab's leader instead of adding one.
    expect(leaders[0]?.subagentId).not.toBe(leaders[1]?.subagentId);
    for (const leader of leaders) expect(leader.subagentId).toMatch(/^leader@[0-9a-f]{8}$/);
  });

  it('keeps a session alive while another connection still shows it', async () => {
    const h = subscribeHarness();
    const other = {} as WebSocket;
    h.clients.set(other, { sessionId: null, sessionIds: new Set(['sess_2']) });
    await h.handlers.subscribeSessions(ws, {
      type: 'session.subscribe',
      payload: { sessionIds: ['sess_1', 'sess_2'] },
    });
    h.undisplayed.length = 0;

    await h.handlers.subscribeSessions(ws, {
      type: 'session.subscribe',
      payload: { sessionIds: ['sess_1'] },
    });

    expect(h.undisplayed).toEqual([]);
  });
});

describe('a new conversation starts on the project defaults', () => {
  /**
   * The leader's meta is not the project's settings — it is the first tab's
   * live choices. Copying it wholesale into a new tab's context started that
   * conversation under another tab's YOLO, autonomy, iteration ceiling and
   * identity variant. Project-level facts still come across so the tab is
   * configured rather than bare.
   */
  it('inherits project facts but none of the per-conversation preferences', () => {
    const leaderMeta = {
      // Project-level: a new tab should start with these.
      mode: 'build',
      effectiveMaxContext: 200_000,
      contextWindowMode: 'balanced',
      designStudio: 'kit-a',
      // Per-conversation: the FIRST TAB's choices, not the project's.
      yolo: true,
      autonomy: 'eternal',
      maxIterations: 999,
      systemPromptVariant: 'pro',
      contextStrategy: 'lossless',
      tokenSavingTier: 'aggressive',
      reasoningEffort: 'high',
    };

    const inherited = inheritedSessionMeta(leaderMeta);

    expect(inherited).toEqual({
      mode: 'build',
      effectiveMaxContext: 200_000,
      contextWindowMode: 'balanced',
      designStudio: 'kit-a',
    });
    // Spelled out: a permission bypass must never arrive by inheritance.
    expect('yolo' in inherited).toBe(false);
  });

  it('does not mutate the leader’s meta', () => {
    const leaderMeta = { mode: 'build', yolo: true };
    inheritedSessionMeta(leaderMeta);
    expect(leaderMeta).toEqual({ mode: 'build', yolo: true });
  });
});

describe('per-tab agent registry', () => {
  /**
   * A session's Agent, minus the container. `createAgent` exists so a caller
   * can decide how one is built; here it keeps the test about the registry's
   * bookkeeping rather than about wiring a whole agent.
   */
  const stubAgent = (sessionId: string, live = true) =>
    ({
      ctx: {
        // A newly created agent carries a PLACEHOLDER writer — an object with
        // the id and nothing that can append — until the session transition
        // that owns the id installs the real one.
        session: live ? writer(sessionId) : { id: sessionId },
        readFiles: new Set<string>(),
        fileMtimes: new Map<string, number>(),
      },
    }) as never;

  it('peek never materialises an agent for an unknown id', () => {
    const registry = createSessionAgentRegistry({
      template: stubAgent('sess_boot'),
      createAgent: (id) => stubAgent(id, false),
    });

    expect(registry.peek('sess_stale')).toBeUndefined();
    // Read-only questions (status logging, introspection, "can I serve this
    // id") used to go through `get`, which creates — a stale browser tab could
    // therefore push a live tab's agent out of the registry.
    expect(registry.ids()).toEqual(['sess_boot']);
  });

  it('evicts a session nobody is displaying before one that is on screen', () => {
    const displayed = new Set(['sess_open']);
    const registry = createSessionAgentRegistry({
      template: stubAgent('sess_boot'),
      // The budget governs EVICTABLE agents; the leader's own is pinned and
      // does not spend a slot.
      maxAgents: 2,
      isDisplayed: (id) => displayed.has(id),
      createAgent: (id) => stubAgent(id, false),
    });
    registry.get('sess_open');
    registry.get('sess_closed');

    registry.get('sess_new');

    // Insertion order alone would have taken `sess_open`, the older of the two.
    expect(registry.has('sess_open')).toBe(true);
    expect(registry.has('sess_closed')).toBe(false);
  });

  it('keeps four open tabs even though the leader holds a slot of its own', () => {
    // The pinned leader used to count against the cap, so the fourth tab
    // evicted one of the three beside it — a tab the user still had open lost
    // its in-memory transcript and came back as a fresh, empty agent.
    const open = ['sess_1', 'sess_2', 'sess_3', 'sess_4'];
    const registry = createSessionAgentRegistry({
      template: stubAgent('sess_boot'),
      isDisplayed: (id) => open.includes(id),
      createAgent: (id) => stubAgent(id, false),
    });
    for (const id of open) registry.get(id);

    for (const id of open) expect(registry.has(id), `${id} was evicted`).toBe(true);
    expect(registry.has('sess_boot')).toBe(true);
  });

  it('knows a placeholder writer is not a live session', () => {
    const registry = createSessionAgentRegistry({
      template: stubAgent('sess_boot'),
      createAgent: (id) => stubAgent(id, false),
    });
    registry.get('sess_new');

    expect(registry.isLive('sess_boot')).toBe(true);
    // Created, but the session transition that owns the id has not installed
    // its writer yet — running against it would fail deep inside the turn.
    expect(registry.isLive('sess_new')).toBe(false);
  });
});

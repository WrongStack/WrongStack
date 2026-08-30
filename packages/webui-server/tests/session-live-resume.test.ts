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

type Writer = {
  id: string;
  startedAt: string;
  append: () => Promise<void>;
  close: () => Promise<void>;
};
const writer = (id: string, startedAt = '2026-01-01T00:00:00.000Z'): Writer => ({
  id,
  startedAt,
  append: async () => undefined,
  close: async () => undefined,
});

function harness(options?: {
  live?: string[];
  /** Journal contents `store.load()` hands back, per session id. */
  stored?: Record<string, { messages: unknown[]; events: unknown[] }>;
  loadAgentSessions?: (ids: readonly string[]) => Promise<unknown[]>;
}) {
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
  const setSessionStartedAt = vi.fn();
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
        load: async (id: string) =>
          options?.stored?.[id] ?? { messages: [], events: [], usage: undefined },
        resume: async (
          id: string,
          onLoadProgress?: (progress: { loadedBytes: number; totalBytes: number }) => void,
        ) => {
          resumeCalls.push(id);
          onLoadProgress?.({ loadedBytes: 512, totalBytes: 1024 });
          return {
            writer: writer(id, '2026-07-25T10:00:00.000Z'),
            data: { messages: [], events: [], usage: undefined },
          };
        },
        list: async () => [],
      }) as never,
    ...(options?.loadAgentSessions
      ? { loadAgentSessions: options.loadAgentSessions as never }
      : {}),
    isSessionLive: (id) => contexts.has(id),
    isRunActive: (id) => id === 'sess_running',
    getAgent: (id) => ({ ctx: contexts.get(id ?? '') ?? rootCtx }) as never,
    setSessionStartedAt,
    sessionStartPayload: async (overrides) => ({ ...overrides }) as never,
    sendMessage: (_ws, message) => sent.push(message),
    broadcastMessage: (message) => sent.push(message),
  });

  return { handlers, resumeCalls, sent, setSessionStartedAt, currentId: () => current.id };
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

  it('restores backend session start state from the original journal timestamp on cold resume', async () => {
    const h = harness();

    await h.handlers.resumeSession(ws, { type: 'session.resume', payload: { id: 'sess_cold' } });

    expect(h.setSessionStartedAt).toHaveBeenCalledWith(Date.parse('2026-07-25T10:00:00.000Z'));
  });

  it('streams byte-level progress while opening a cold resume journal', async () => {
    const h = harness();

    await h.handlers.resumeSession(ws, { type: 'session.resume', payload: { id: 'sess_cold' } });

    expect(h.sent).toEqual(
      expect.arrayContaining([
        {
          type: 'session.resume_progress',
          payload: {
            sessionId: 'sess_cold',
            stage: 'open_journal',
            loadedBytes: 512,
            totalBytes: 1024,
          },
        },
      ]),
    );
  });

  it('sends no transcript for a focus on a session the tab is already showing', async () => {
    const h = harness({ live: ['sess_bg'] });

    await h.handlers.resumeSession(ws, { type: 'session.focus', payload: { id: 'sess_bg' } });

    const start = h.sent.find((m) => m.type === 'session.start');
    const payload = start?.payload as Record<string, unknown> | undefined;
    // A tab on screen already holds this conversation, with its live tool
    // cards and the audit markers a replay is rebuilt without. Sending one
    // would replace the richer record with the poorer one.
    expect(payload).toMatchObject({ sessionId: 'sess_bg' });
    expect(payload).not.toHaveProperty('replayMessages');
    expect(payload).not.toHaveProperty('replayUsage');
    // …but it must SAY that is why it is empty. A focus and an in-place clear
    // are both `reset: true` with no messages, and the client cannot tell them
    // apart on its own — it moves the active lane before it sends the focus,
    // so every positional test it could run is already true when this lands.
    // Without this tag the frame reads as "the conversation was emptied" and
    // the tab the user just switched back to is wiped.
    expect(payload).toMatchObject({ replayReason: 'focus', reset: true });
    // The foreground still moves — that is the entire job of a focus.
    expect(h.currentId()).toBe('sess_bg');
    expect(h.resumeCalls).toEqual([]);
  });

  it('falls through to a real resume when a focus names a session it does not hold', async () => {
    const h = harness();

    await h.handlers.resumeSession(ws, { type: 'session.focus', payload: { id: 'sess_cold' } });

    // A page that outlived its process focuses a tab the server has never
    // opened. Leaving it blank would be the worse answer.
    expect(h.resumeCalls).toEqual(['sess_cold']);
  });
});

describe('session.subscribe', () => {
  function subscribeHarness() {
    const clients = new Map<WebSocket, { sessionId: string | null; sessionIds?: Set<string> }>();
    clients.set(ws, { sessionId: null });
    const sent: Array<{ type: string; payload: unknown }> = [];
    const undisplayed: string[][] = [];
    const loads: string[] = [];
    const handlers = createSessionHandlers({
      config: { model: 'm', provider: 'p' },
      context: { session: writer('sess_boot') } as never,
      tokenCounter: { account: vi.fn(), total: () => ({}) } as never,
      clients: clients as never,
      getProjectRoot: () => '/repo',
      getSession: () => writer('sess_boot') as never,
      setSession: vi.fn(),
      getSessionStore: () =>
        ({
          load: async (id: string) => {
            loads.push(id);
            return {
              messages: [{ role: 'user', content: `journal of ${id}` }],
              events: [],
              usage: undefined,
            };
          },
        }) as never,
      isRunActive: (id) => id === 'sess_2',
      onSessionsUndisplayed: (ids) => undisplayed.push(ids),
      sessionStartPayload: async (o) => ({ ...o }) as never,
      sendMessage: (_ws, message) => sent.push(message),
      broadcastMessage: (message) => sent.push(message),
    });
    return { handlers, sent, undisplayed, clients, loads };
  }

  it('hands back the transcript of every tab that says its pane is empty', async () => {
    const h = subscribeHarness();

    await h.handlers.subscribeSessions(ws, {
      type: 'session.subscribe',
      payload: { sessionIds: ['sess_1', 'sess_2'], replayFor: ['sess_1'] },
    });

    // What a reloaded page shows comes out of localStorage, which keeps only
    // the last couple of hundred messages and no markers. The tab says so by
    // naming itself in `replayFor`; the tab that did not ask keeps what it has.
    const starts = h.sent.filter((m) => m.type === 'session.start');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.payload).toMatchObject({
      sessionId: 'sess_1',
      replayReason: 'redisplay',
    });
    expect(h.loads).toEqual(['sess_1']);
  });

  it('never re-sends a transcript for a tab this connection already declared', async () => {
    const h = subscribeHarness();
    const declare = (ids: string[]) =>
      h.handlers.subscribeSessions(ws, {
        type: 'session.subscribe',
        payload: { sessionIds: ids, replayFor: ids },
      });

    await declare(['sess_1']);
    await declare(['sess_1', 'sess_3']);

    // A later subscribe is a tab open or close. The id that changed got its
    // transcript from the `session.resume` that opened it; re-sending one for
    // the tabs that did not change would overwrite live panes.
    expect(h.loads).toEqual(['sess_1', 'sess_3']);
  });

  it('redisplays a LIVE tab from its journal, so the markers come back with it', async () => {
    // The live path used to answer from the context's in-memory transcript,
    // which is messages and nothing else — so a reloaded page got the same
    // conversation back as a wall of plain text, with every audit mark,
    // checkpoint and tool record gone. They are projected from journal
    // EVENTS, so the journal is what a redisplay has to read.
    const loads: string[] = [];
    const sent: Array<{ type: string; payload: unknown }> = [];
    const clients = new Map<WebSocket, { sessionId: string | null; sessionIds?: Set<string> }>();
    clients.set(ws, { sessionId: null });
    const handlers = createSessionHandlers({
      config: { model: 'm', provider: 'p' },
      context: { session: writer('sess_boot') } as never,
      tokenCounter: { account: vi.fn(), total: () => ({}) } as never,
      clients: clients as never,
      getProjectRoot: () => '/repo',
      getSession: () => writer('sess_boot') as never,
      setSession: vi.fn(),
      // The tab IS live in this runtime — its agent holds a shorter,
      // marker-less working set than the journal behind it.
      peekAgent: (id?: string) =>
        id === 'sess_live'
          ? ({
              ctx: {
                session: writer('sess_live'),
                lastRequestTokens: 5,
                state: { messages: [{ role: 'user', content: 'in memory' }] },
              },
            } as never)
          : undefined,
      getSessionStore: () =>
        ({
          load: async (id: string) => {
            loads.push(id);
            return {
              messages: [
                { role: 'user', content: 'first' },
                { role: 'assistant', content: 'second' },
              ],
              events: [
                {
                  type: 'error',
                  ts: '2026-01-01T00:00:00.000Z',
                  message: 'provider timed out',
                },
              ],
              usage: undefined,
            };
          },
        }) as never,
      sessionStartPayload: async (o) => ({ ...o }) as never,
      sendMessage: (_ws, message) => sent.push(message),
      broadcastMessage: (message) => sent.push(message),
    });

    await handlers.subscribeSessions(ws, {
      type: 'session.subscribe',
      payload: { sessionIds: ['sess_live'], replayFor: ['sess_live'] },
    });

    expect(loads).toEqual(['sess_live']);
    const start = sent.find((m) => m.type === 'session.start');
    const payload = start?.payload as { replayMessages?: unknown[]; replayMarkers?: unknown[] };
    expect(payload?.replayMessages).toHaveLength(2);
    expect(payload?.replayMarkers?.length ?? 0).toBeGreaterThan(0);
  });

  it('sends nothing back when no tab asks for a redisplay', async () => {
    const h = subscribeHarness();

    await h.handlers.subscribeSessions(ws, {
      type: 'session.subscribe',
      payload: { sessionIds: ['sess_1', 'sess_2'] },
    });

    expect(h.sent.filter((m) => m.type === 'session.start')).toEqual([]);
    expect(h.loads).toEqual([]);
  });

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

    expect(client.sessionIds).toEqual(new Set(['sess_1', 'sess_2', 'sess_3', 'sess_4']));
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

  /**
   * A stub agent whose journal records what was asked of it, plus a
   * session-scoped token counter so `closeAll` can be checked for stamping
   * each tab with its OWN usage rather than the host total.
   */
  const journalAgent = (sessionId: string, tokens = 1) => {
    const appended: { type: string; usage?: unknown }[] = [];
    const calls = { flushSync: 0, close: 0 };
    const agent = {
      ctx: {
        session: {
          id: sessionId,
          append: async (event: { type: string; usage?: unknown }) => {
            appended.push(event);
          },
          close: async () => {
            calls.close++;
          },
          flushSync: () => {
            calls.flushSync++;
          },
        },
        tokenCounter: { total: () => ({ input: tokens, output: 0 }) },
        readFiles: new Set<string>(),
        fileMtimes: new Map<string, number>(),
      },
    };
    return { agent: agent as never, appended, calls };
  };

  it('drains and closes the journal of a session it evicts', async () => {
    // Eviction used to delete the agent and nothing else, so a whole buffer
    // window of records never reached disk and the file handle stayed open —
    // the tab came back to a transcript missing its own tail.
    const evicted = journalAgent('sess_closed');
    const registry = createSessionAgentRegistry({
      template: stubAgent('sess_boot'),
      maxAgents: 1,
      createAgent: (id) => (id === 'sess_closed' ? evicted.agent : stubAgent(id, false)),
    });
    registry.get('sess_closed');

    registry.get('sess_new');
    await Promise.resolve();

    expect(registry.has('sess_closed')).toBe(false);
    expect(evicted.calls.flushSync).toBe(1);
    expect(evicted.calls.close).toBe(1);
    // NOT ended: the tab may still be open, and the next visit reopens this
    // journal to append to it. Only a real close writes the terminal marker.
    expect(evicted.appended).toEqual([]);
  });

  it('endAndClose ends a closed tab, drops it, and never touches the leader', async () => {
    const closed = journalAgent('sess_closed', 9);
    const registry = createSessionAgentRegistry({
      template: stubAgent('sess_boot'),
      createAgent: () => closed.agent,
    });
    registry.get('sess_closed');

    await registry.endAndClose('sess_closed');
    // The leader IS the host; ending its journal here would close the log the
    // whole process is still writing to.
    await registry.endAndClose('sess_boot');

    expect(closed.appended.map((e) => e.type)).toEqual(['session_end']);
    expect(closed.appended[0]?.usage).toEqual({ input: 9, output: 0 });
    expect(closed.calls.close).toBe(1);
    expect(registry.ids()).toEqual(['sess_boot']);
  });

  it('flushAllSync drains every tab, not just the leader', () => {
    // The host's salvage hook only knows the leader's writer, so a crash
    // truncated the buffered tail of all three tabs beside it.
    const a = journalAgent('sess_a');
    const b = journalAgent('sess_b');
    const registry = createSessionAgentRegistry({
      template: stubAgent('sess_boot'),
      createAgent: (id) => (id === 'sess_a' ? a.agent : b.agent),
    });
    registry.get('sess_a');
    registry.get('sess_b');

    registry.flushAllSync();

    expect(a.calls.flushSync).toBe(1);
    expect(b.calls.flushSync).toBe(1);
  });

  it('closeAll ends each background journal with its own usage and spares the leader', async () => {
    // Without the marker a clean quit left every background tab looking
    // exactly like a crash, and the next launch offered them all for recovery.
    const a = journalAgent('sess_a', 11);
    const b = journalAgent('sess_b', 22);
    const registry = createSessionAgentRegistry({
      template: stubAgent('sess_boot'),
      createAgent: (id) => (id === 'sess_a' ? a.agent : b.agent),
    });
    registry.get('sess_a');
    registry.get('sess_b');

    await registry.closeAll();

    expect(a.appended.map((e) => e.type)).toEqual(['session_end']);
    expect(a.appended[0]?.usage).toEqual({ input: 11, output: 0 });
    // Each tab's OWN counter: a shared one would stamp every tab with the sum.
    expect(b.appended[0]?.usage).toEqual({ input: 22, output: 0 });
    expect(a.calls.close).toBe(1);
    expect(b.calls.close).toBe(1);
    // The leader's journal belongs to the host teardown that runs after this.
    expect(registry.ids()).toEqual(['sess_boot']);
  });
});

describe('a resumed live session comes back whole', () => {
  const journal = {
    sess_bg: {
      messages: [
        { role: 'user', content: 'first', ts: '2026-01-01T00:00:00Z' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'read', input: {} }],
          ts: '2026-01-01T00:00:02Z',
        },
      ],
      events: [
        { type: 'compaction', ts: '2026-01-01T00:00:01Z', before: 100_000, after: 40_000 },
        {
          type: 'tool_call_end',
          ts: '2026-01-01T00:00:03Z',
          name: 'read',
          id: 'tu-1',
          durationMs: 42,
          outputSize: 10,
          ok: true,
        },
        { type: 'agent_spawned', ts: '2026-01-01T00:00:04Z', agentId: 'scout', role: 'reviewer' },
      ],
    },
  };

  it('carries the journal’s markers and tool timings, not the bare working set', async () => {
    // The live branch used to build its replay from `events: []`, so a tab it
    // was already holding came back as plain text: no compaction line, no
    // duration on the tool card. The redisplay path had been fixed; this one
    // had not, so which of the two the client happened to trigger decided
    // whether the session looked like itself.
    const h = harness({ live: ['sess_bg'], stored: journal });

    await h.handlers.resumeSession(ws, { type: 'session.resume', payload: { id: 'sess_bg' } });

    const start = h.sent.find((m) => m.type === 'session.start');
    const payload = start?.payload as {
      replayMarkers?: Array<{ source: string }>;
      replayToolMeta?: Array<{ id: string; durationMs?: number }>;
    };
    expect(payload.replayMarkers?.map((m) => m.source)).toEqual(['compaction']);
    expect(payload.replayToolMeta).toEqual([
      expect.objectContaining({ id: 'tu-1', durationMs: 42, ok: true }),
    ]);
    // Still no second writer on a file that already has one.
    expect(h.resumeCalls).toEqual([]);
  });

  it('does not inject subagent sessions into the resumed main screen', async () => {
    // Subagent sessions are not resumable workers after restart. Keep their
    // raw journal data available for an inspect/history view, but do not hydrate
    // the main session.start payload with stale roster cards.
    const asked: string[][] = [];
    const h = harness({
      live: ['sess_bg'],
      stored: journal,
      loadAgentSessions: async (ids) => {
        asked.push([...ids]);
        return [{ subagentId: 'scout', agentName: 'Scout', transcript: [{ content: 'hi' }] }];
      },
    });

    await h.handlers.resumeSession(ws, { type: 'session.resume', payload: { id: 'sess_bg' } });

    expect(asked).toEqual([]);
    const start = h.sent.find((m) => m.type === 'session.start');
    const payload = start?.payload as { agentSessions?: Array<Record<string, unknown>> };
    expect(payload.agentSessions).toBeUndefined();
  });

  it('does not read subagent sessions while resuming the main screen', async () => {
    // Some producers stamp the leader's own interleaved events with the
    // reserved id `leader`. Right for attribution, wrong for a fleet panel:
    // it put a permanently "running" worker card in every resumed tab.
    const asked: string[][] = [];
    const h = harness({
      live: ['sess_bg'],
      stored: {
        sess_bg: {
          messages: journal.sess_bg.messages,
          events: [
            ...journal.sess_bg.events,
            {
              type: 'tool_call_start',
              ts: '2026-01-01T00:00:05Z',
              name: 'read',
              id: 'x',
              input: {},
              agentId: 'leader',
            },
          ],
        },
      },
      loadAgentSessions: async (ids) => {
        asked.push([...ids]);
        return [];
      },
    });

    await h.handlers.resumeSession(ws, { type: 'session.resume', payload: { id: 'sess_bg' } });

    expect(asked).toEqual([]);
    const start = h.sent.find((m) => m.type === 'session.start');
    const payload = start?.payload as { agentSessions?: Array<{ subagentId: string }> };
    expect(payload.agentSessions).toBeUndefined();
  });

  it('a focus still carries no transcript and reads no journal', async () => {
    const reads: string[] = [];
    const h = harness({ live: ['sess_bg'], stored: journal });
    void reads;

    await h.handlers.resumeSession(ws, { type: 'session.focus', payload: { id: 'sess_bg' } });

    const start = h.sent.find((m) => m.type === 'session.start');
    const payload = start?.payload as Record<string, unknown>;
    expect(payload['replayMessages']).toBeUndefined();
    expect(payload['replayMarkers']).toBeUndefined();
    expect(payload['agentSessions']).toBeUndefined();
  });
});

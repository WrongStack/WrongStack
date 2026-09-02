import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { handleBrainAsk, handleBrainRisk } from '../src/server/brain-handlers.js';
import { createModelOperations } from '../src/server/model-operations.js';
import { createSessionHandlers } from '../src/server/session-handlers.js';

/**
 * Four tabs, one runtime: a request is answered ABOUT the tab that asked.
 *
 * Each case here was a handler reading the runtime's own session — the tab
 * the runtime last switched to — instead of the one named on the message.
 * That reads correct on a single-session host and is wrong three times out of
 * four with the WebUI's four tabs open.
 */

type Frame = { type: string; payload: Record<string, unknown> };

function collector() {
  const frames: Frame[] = [];
  return {
    frames,
    send: (_ws: WebSocket, msg: unknown) => {
      frames.push(msg as Frame);
    },
    ofType: (type: string) => frames.filter((f) => f.type === type),
  };
}

const WS = {} as WebSocket;

describe('the Brain answers the tab that asked', () => {
  function brainCtx(sink: ReturnType<typeof collector>) {
    return {
      brainSettings: { maxAutoRisk: 'medium' as const },
      getBrainLog: () => [
        { at: 1, kind: 'tool', question: 'q-tab1', outcome: 'auto', sessionId: 'tab-1' },
        { at: 2, kind: 'tool', question: 'q-tab2', outcome: 'auto', sessionId: 'tab-2' },
        { at: 3, kind: 'tool', question: 'q-none', outcome: 'auto' },
      ],
      resolveArbiter: () => undefined,
      // The runtime is on tab-1; every ask below comes from tab-2.
      getSessionId: () => 'tab-1',
      send: sink.send,
    };
  }

  it('reports only the asking tab’s decisions after a risk change', () => {
    const sink = collector();
    handleBrainRisk(brainCtx(sink) as never, WS, 'high', 'tab-2');
    const status = sink.ofType('brain.status').at(-1);
    expect(status?.payload['sessionId']).toBe('tab-2');
    const log = status?.payload['log'] as Array<{ question: string }>;
    // Its own, plus the unattributed one; never tab-1's.
    expect(log.map((entry) => entry.question)).toEqual(['q-tab2', 'q-none']);
  });

  it('stamps brain.answer with the asking tab, not the runtime’s session', async () => {
    const sink = collector();
    const seen: Array<string | undefined> = [];
    const ctx = {
      ...brainCtx(sink),
      resolveArbiter: () => ({
        decide: async (input: { sessionId?: string | undefined }) => {
          seen.push(input.sessionId);
          return { action: 'auto' };
        },
      }),
    };
    await handleBrainAsk(ctx as never, WS, 'ship it?', 'tab-2');
    // The decision is filed under the tab that asked — otherwise the entry
    // shows up in another tab's `/brain` log, and the answer comes back
    // stamped for a session the asking tab's own gate then drops.
    expect(seen).toEqual(['tab-2']);
    expect(sink.ofType('brain.answer').at(-1)?.payload['sessionId']).toBe('tab-2');
  });

  it('falls back to the runtime session when nothing was named', async () => {
    const sink = collector();
    const ctx = {
      ...brainCtx(sink),
      resolveArbiter: () => ({ decide: async () => ({ action: 'auto' }) }),
    };
    await handleBrainAsk(ctx as never, WS, 'ship it?');
    expect(sink.ofType('brain.answer').at(-1)?.payload['sessionId']).toBe('tab-1');
  });
});

describe('prompt refinement belongs to the asking tab', () => {
  /** A provider whose completion always fails, so only the inputs matter. */
  const deadProvider = { complete: async () => Promise.reject(new Error('no provider')) };

  it('reads that session’s model and history, never the shared root’s', async () => {
    const sink = collector();
    const rootCtx = {
      model: 'root-model',
      provider: { id: 'root-provider', capabilities: {}, ...deadProvider },
      messages: [{ role: 'user', content: 'ROOT-ONLY-SECRET' }],
      meta: {},
      readFiles: new Set<string>(),
    };
    const tabCtx = {
      model: 'tab-model',
      provider: { id: 'tab-provider', capabilities: {}, ...deadProvider },
      messages: [{ role: 'user', content: 'TAB-ONLY' }],
      meta: {},
      readFiles: new Set<string>(),
    };
    const asked: string[] = [];
    const ops = createModelOperations({
      context: rootCtx as never,
      getConfig: () => undefined,
      getLiveProviderId: () => 'root-provider',
      buildProvider: () => ({}) as never,
      applyModelSwitch: async () => undefined,
      getSessionContext: (id?: string) => {
        asked.push(id ?? '<none>');
        return (id === 'tab-2' ? tabCtx : rootCtx) as never;
      },
      send: sink.send,
    });
    await ops.refineModel(WS, { sessionId: 'tab-2', text: 'make this better', timeoutMs: 1 });
    // Resolved through the session seam, not read off the root. Refining in a
    // background tab used to run on the foreground's model AND feed the
    // foreground's recent turns to the refiner — a content leak, not a label.
    expect(asked).toContain('tab-2');
    const frame = sink.ofType('model.refine_result').at(-1);
    expect(frame?.payload['sessionId']).toBe('tab-2');
  });

  it('addresses the empty-text rejection too', async () => {
    const sink = collector();
    const ctx = {
      model: 'm',
      provider: { id: 'p', capabilities: {}, ...deadProvider },
      messages: [],
      meta: {},
      readFiles: new Set<string>(),
    };
    const ops = createModelOperations({
      context: ctx as never,
      getConfig: () => undefined,
      getLiveProviderId: () => 'p',
      buildProvider: () => ({}) as never,
      applyModelSwitch: async () => undefined,
      send: sink.send,
    });
    await ops.refineModel(WS, { sessionId: 'tab-3', text: '' });
    expect(sink.ofType('model.refine_result').at(-1)?.payload['sessionId']).toBe('tab-3');
  });
});

describe('the session catalogue marks the asking tab as current', () => {
  it('does not hand a background tab the runtime session as "current"', async () => {
    const sink = collector();
    const summaries = [
      { id: 'tab-1', title: 'one', startedAt: 1, model: 'm', provider: 'p', tokenTotal: 0 },
      { id: 'tab-2', title: 'two', startedAt: 2, model: 'm', provider: 'p', tokenTotal: 0 },
    ];
    const ctx = {
      session: { id: 'tab-1', append: async () => undefined, close: async () => undefined },
      messages: [],
      provider: { id: 'p' },
      model: 'm',
      meta: {} as Record<string, unknown>,
      readFiles: new Set<string>(),
      fileMtimes: new Map<string, number>(),
      state: { messages: [], todos: [], replaceMessages: () => undefined },
    };
    const handlers = createSessionHandlers({
      config: { model: 'm', provider: 'p' },
      context: ctx as never,
      tokenCounter: {
        account: () => undefined,
        total: () => ({}),
        reset: () => undefined,
      } as never,
      getProjectRoot: () => '/repo',
      getSession: () => ctx.session as never,
      setSession: () => undefined,
      getSessionStore: () => ({ list: async () => summaries }) as never,
      hasSession: () => true,
      sessionStartPayload: async (overrides?: Record<string, unknown>) => ({ ...overrides }),
      sendMessage: sink.send as never,
      broadcastMessage: () => undefined,
    } as never);

    await handlers.listSessions(WS, {
      type: 'sessions.list',
      payload: { limit: 50, sessionId: 'tab-2' },
    } as never);

    const reply = sink.ofType('sessions.list').at(-1)?.payload as {
      sessionId?: string;
      sessions: Array<{ id: string; isCurrent: boolean }>;
    };
    // `isCurrent` disables the resume button on that row, drives the "active"
    // filter and spares the row from the empty-session sweep. Answered from
    // the runtime's session it disabled resume on a row the user was not on
    // and offered three live tabs' fresh sessions up for deletion.
    expect(reply?.sessionId).toBe('tab-2');
    expect(reply?.sessions.find((s) => s.id === 'tab-2')?.isCurrent).toBe(true);
    expect(reply?.sessions.find((s) => s.id === 'tab-1')?.isCurrent).toBe(false);
  });
});

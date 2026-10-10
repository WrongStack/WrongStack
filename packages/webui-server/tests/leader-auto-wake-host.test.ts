import { LeaderAutoWakeController, LeaderDeliveryHub } from '@wrongstack/core/coordination';
import { EventBus } from '@wrongstack/core/kernel';
import { AUTO_WAKE_PROMPT_MARKER } from '@wrongstack/webui-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('ws/native', () => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { WebSocket: MockWebSocket };
});

vi.mock('@wrongstack/providers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  makeProviderFromConfig: vi.fn(() => ({ id: 'openai', capabilities: { maxContext: 128000 } })),
}));

import { AUTO_WAKE_MARKER } from '@wrongstack/core/coordination';
import { createEmbeddedConversationRoutes } from '../src/server/embedded-host-adapters.js';
import { createWebuiLeaderAutoWakeHost } from '../src/server/leader-auto-wake-host.js';
import type { PendingConfirm } from '../src/server/pending-confirms.js';

/**
 * The CLI-hosted WebUI's auto-wake binding, driven end to end with the REAL
 * core controller and a private delivery hub: a woken turn must take the same
 * conversation path a user message takes, with runtime origin.
 */

const SESSION = 'sess_tab';

function delivery(id: string, sessionId = SESSION, wake = true) {
  return {
    deliveryId: `dlv_${id}`,
    sessionId,
    kind: 'delegation_result' as const,
    createdAt: Date.now(),
    wake,
    payload: {
      delegationId: `del_${id}`,
      taskId: `task_${id}`,
      target: 'explore',
      task: 'map the module',
      ok: true,
      status: 'success',
      summary: 'done',
    },
  } as never;
}

interface Deferred {
  resolve: () => void;
  promise: Promise<void>;
}
function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

function setup(
  options: {
    displayed?: boolean;
    open?: boolean;
    runStatus?: string;
    config?: Record<string, unknown>;
  } = {},
) {
  const events = new EventBus();
  // The hub takes no constructor options; `events` rides on each enqueue call.
  const hub = new LeaderDeliveryHub();
  const controller = new LeaderAutoWakeController({
    events,
    hub,
    minWakeIntervalMs: 0,
    config: () => ({ autoWakeDebounceMs: 0, ...options.config }),
  });
  const abortControllers = new Map<string, AbortController>();
  const pendingConfirms = new Map<string, PendingConfirm>();
  const broadcasts: Array<{ type: string; payload: any }> = [];
  const sent: Array<{ type: string; payload: any }> = [];
  let displayed = options.displayed ?? true;
  const runs: Array<{ input: unknown; gate: Deferred; signal: AbortSignal }> = [];
  const agent = {
    ctx: {
      meta: {},
      session: { id: SESSION, append: vi.fn() },
      provider: { id: 'p', capabilities: { vision: false } },
      model: 'm',
    },
    run: vi.fn(async (input: unknown, runOpts: { signal: AbortSignal }) => {
      // The real loop drains pending deliveries on iteration 0.
      hub.take(SESSION, { maxItems: 8, maxChars: 1_000_000 });
      const gate = deferred();
      runs.push({ input, gate, signal: runOpts.signal });
      await gate.promise;
      return { status: options.runStatus ?? 'done', iterations: 1, finalText: 'ok' };
    }),
  };
  const host = createWebuiLeaderAutoWakeHost({
    controller,
    events,
    hub,
    abortControllers,
    pendingConfirms,
    isOpen: (id) => (options.open ?? true) && id === SESSION,
    isDisplayed: (id) => displayed && id === SESSION,
    broadcast: (m) => broadcasts.push(m as never),
  });
  const routes = createEmbeddedConversationRoutes({
    agent: agent as never,
    events,
    getAgent: () => agent as never,
    peekAgent: (id?: string) => (id === SESSION ? (agent as never) : undefined),
    abortControllers,
    pendingConfirms,
    autoWake: host,
    send: (_ws, m) => sent.push(m as never),
    broadcast: (m) => broadcasts.push(m as never),
    log: () => undefined,
  });
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return {
    // Production enqueues pass the bus, which is what emits `leader.delivery_pending`.
    enqueue: (item: never) => hub.enqueue(item, { events }),
    events,
    hub,
    controller,
    host,
    routes,
    agent,
    runs,
    abortControllers,
    pendingConfirms,
    broadcasts,
    sent,
    flush,
    setDisplayed: (value: boolean) => {
      displayed = value;
    },
    dispose: () => {
      host.dispose();
      controller.dispose();
    },
  };
}

const userMessage = (content: string) =>
  ({ type: 'user_message', payload: { sessionId: SESSION, content } }) as never;

let active: ReturnType<typeof setup> | undefined;
afterEach(() => {
  active?.dispose();
  active = undefined;
});

describe('WebUI leader auto-wake host', () => {
  it('keeps the protocol marker identical to core', () => {
    expect(AUTO_WAKE_PROMPT_MARKER).toBe(AUTO_WAKE_MARKER);
  });

  it('wakes an idle, displayed session through the user-message path with runtime origin', async () => {
    const h = setup();
    active = h;
    h.enqueue(delivery('a'));
    await h.flush();

    expect(h.agent.run).toHaveBeenCalledTimes(1);
    const [input] = h.agent.run.mock.calls[0] as unknown as [string];
    expect(input.startsWith(AUTO_WAKE_MARKER)).toBe(true);
    expect(input).toContain('del_a');
    // The same run lock a user message claims.
    expect(h.abortControllers.has(SESSION)).toBe(true);

    h.runs[0]?.gate.resolve();
    await h.flush();
    expect(h.abortControllers.has(SESSION)).toBe(false);
    // No socket asked: the result is broadcast to the session, marked runtime.
    const result = h.broadcasts.find((m) => m.type === 'run.result');
    expect(result?.payload).toMatchObject({ sessionId: SESSION, origin: 'auto_wake' });
    expect(h.sent).toHaveLength(0);
    expect(h.broadcasts.find((m) => m.type === 'delegation.auto_wake_started')?.payload).toEqual({
      sessionId: SESSION,
      delegationIds: ['del_a'],
      chain: 1,
    });
  });

  it('forwards delivery_pending with delegation ids, session-scoped', async () => {
    const h = setup({ config: { autoWake: false } });
    active = h;
    h.enqueue(delivery('a'));
    await h.flush();
    expect(h.broadcasts.find((m) => m.type === 'delegation.delivery_pending')?.payload).toEqual({
      sessionId: SESSION,
      count: 1,
      delegationIds: ['del_a'],
      wake: true,
    });
    expect(h.agent.run).not.toHaveBeenCalled();
  });

  it('does not wake a running session, then wakes after the run ends', async () => {
    const h = setup();
    active = h;
    const turn = h.routes.userMessage({} as never, userMessage('hello'));
    await h.flush();
    expect(h.agent.run).toHaveBeenCalledTimes(1);

    h.enqueue(delivery('b'));
    await h.flush();
    expect(h.agent.run).toHaveBeenCalledTimes(1);

    h.runs[0]?.gate.resolve();
    await turn;
    await h.flush();
    expect(h.agent.run).toHaveBeenCalledTimes(2);
    expect(String(h.agent.run.mock.calls[1]?.[0])).toContain('del_b');
    h.runs[1]?.gate.resolve();
    await h.flush();
  });

  it('never follows a user-aborted run with a wake', async () => {
    const h = setup();
    active = h;
    const turn = h.routes.userMessage({} as never, userMessage('hello'));
    await h.flush();
    h.enqueue(delivery('c'));
    await h.flush();

    h.routes.abort({} as never, { type: 'abort', payload: { sessionId: SESSION } } as never);
    h.runs[0]?.gate.resolve();
    await turn;
    await h.flush();

    expect(h.agent.run).toHaveBeenCalledTimes(1);
    expect(h.hub.pending(SESSION)).toBe(1);
  });

  it('holds results for an undisplayed session and wakes when a tab displays it', async () => {
    const h = setup({ displayed: false });
    active = h;
    h.enqueue(delivery('d'));
    await h.flush();
    expect(h.agent.run).not.toHaveBeenCalled();
    // The hold is not forwarded: no tab shows the session.
    expect(h.broadcasts.some((m) => m.type === 'delegation.auto_wake_suppressed')).toBe(false);

    h.setDisplayed(true);
    h.host.onSessionsDisplayed([SESSION]);
    await h.flush();
    expect(h.agent.run).toHaveBeenCalledTimes(1);
    h.runs[0]?.gate.resolve();
    await h.flush();
  });

  it('holds while a tool confirm or an input form is pending', async () => {
    const h = setup();
    active = h;
    h.pendingConfirms.set('c1', { resolve: () => undefined, sessionId: SESSION });
    h.enqueue(delivery('e'));
    await h.flush();
    expect(h.agent.run).not.toHaveBeenCalled();

    h.pendingConfirms.delete('c1');
    h.events.emit('user.input_requested', {
      sessionId: SESSION,
      request: { id: 'form1', title: 'Q', tabs: [] },
      resolve: () => undefined,
    } as never);
    h.controller.evaluate(SESSION);
    await h.flush();
    expect(h.agent.run).not.toHaveBeenCalled();

    h.events.emit('user.input_resolved', {
      sessionId: SESSION,
      requestId: 'form1',
      response: { requestId: 'form1', answers: [] },
      source: 'user',
    } as never);
    h.controller.evaluate(SESSION);
    await h.flush();
    expect(h.agent.run).toHaveBeenCalledTimes(1);
    h.runs[0]?.gate.resolve();
    await h.flush();
  });

  it('counts a user submit waiting on the transition gate as pending user input', () => {
    const h = setup();
    active = h;
    const release = h.host.onUserMessage(SESSION);
    expect(h.host.port.hasPendingUserInput(SESSION)).toBe(true);
    release();
    expect(h.host.port.hasPendingUserInput(SESSION)).toBe(false);
  });

  it('a user submit resets the chain cap', async () => {
    const h = setup({ config: { maxChainedWakes: 1 } });
    active = h;
    h.enqueue(delivery('f'));
    await h.flush();
    expect(h.agent.run).toHaveBeenCalledTimes(1);
    h.runs[0]?.gate.resolve();
    await h.flush();

    h.enqueue(delivery('g'));
    await h.flush();
    // Chain of 1 exhausted: held, and the tab is told.
    expect(h.agent.run).toHaveBeenCalledTimes(1);
    expect(h.broadcasts.find((m) => m.type === 'delegation.auto_wake_suppressed')?.payload).toEqual(
      { sessionId: SESSION, reason: 'chain_cap', pending: 1 },
    );

    const turn = h.routes.userMessage({} as never, userMessage('continue'));
    await h.flush();
    expect(h.controller.chainLength(SESSION)).toBe(0);
    h.runs[1]?.gate.resolve();
    await turn;
    await h.flush();
  });

  it('dispose unbinds the port and stops forwarding', async () => {
    const h = setup();
    active = h;
    h.host.dispose();
    h.enqueue(delivery('h'));
    await h.flush();
    expect(h.agent.run).not.toHaveBeenCalled();
    expect(h.broadcasts).toHaveLength(0);
  });
});

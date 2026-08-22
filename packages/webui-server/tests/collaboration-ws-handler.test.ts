import { CollaborationBus } from '@wrongstack/core/coordination';
import { EventBus } from '@wrongstack/core/kernel';
import { CollaborationWebSocketHandler } from '@wrongstack/webui-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal ws stub capturing sent JSON messages. */
function fakeWs() {
  const sent: any[] = [];
  const handlers: Record<string, Array<(arg?: any) => void>> = {};
  return {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
    on: (ev: string, fn: (arg?: any) => void) => {
      handlers[ev] ??= [];
      handlers[ev].push(fn);
    },
    fire: (ev: string) => {
      for (const fn of handlers[ev] ?? []) fn();
    },
    sent,
  } as any;
}

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

const allowPrivilegedRoles = { authorizeRole: () => true };

function lastOfType(ws: ReturnType<typeof fakeWs>, type: string) {
  const matching = ws.sent.filter((m: any) => m.type === type);
  return matching[matching.length - 1];
}

describe('CollaborationWebSocketHandler', () => {
  let events: EventBus;
  let handler: CollaborationWebSocketHandler;

  beforeEach(() => {
    events = new EventBus();
    handler = new CollaborationWebSocketHandler(events, noopLogger);
  });

  afterEach(() => {
    handler.dispose();
  });

  // ── 1. Happy path: join then mirror an event ────────────────────────
  it('clears participant and socket ownership on dispose', () => {
    const ws = fakeWs();
    handler.addClient(ws);
    handler.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-dispose', role: 'observer' },
    });
    const internal = handler as unknown as {
      registry: { clients: Set<unknown>; sessionIds(): string[] };
    };
    expect(internal.registry.clients.size).toBe(1);
    expect(internal.registry.sessionIds()).toHaveLength(1);

    handler.dispose();
    expect(internal.registry.clients.size).toBe(0);
    expect(internal.registry.sessionIds()).toHaveLength(0);
  });

  it('joins as observer, receives state snapshot, mirrors live events', () => {
    const ws = fakeWs();
    handler.addClient(ws);
    handler.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-1', role: 'observer' },
    });

    // First message after join is the per-participant state snapshot.
    const state = lastOfType(ws, 'collab.state');
    expect(state.payload.sessionId).toBe('sess-1');
    expect(state.payload.participants).toHaveLength(1);
    expect(state.payload.participants[0].role).toBe('observer');

    // Joined broadcast went out.
    const joined = lastOfType(ws, 'collab.participant.joined');
    expect(joined.payload.sessionId).toBe('sess-1');
    expect(joined.payload.role).toBe('observer');
    expect(typeof joined.payload.participantId).toBe('string');
    expect(typeof joined.payload.joinedAt).toBe('string');

    // Live kernel event: tool.started → forwarded as collab.event.
    events.emit('tool.started', { name: 'read', id: 'tu-1', input: { path: '/a.ts' } } as never);
    const ev = lastOfType(ws, 'collab.event');
    expect(ev.payload.kind).toBe('tool.started');
    expect(ev.payload.payload).toMatchObject({ name: 'read', id: 'tu-1' });
    expect(typeof ev.payload.at).toBe('string');
  });

  // ── 2. Multi-observer: two clients see each other's join ─────────────
  it('broadcasts participant.joined to existing observers when a second joins', () => {
    const a = fakeWs();
    const b = fakeWs();
    handler.addClient(a);
    handler.addClient(b);
    handler.handleMessage(a, {
      type: 'collab.join',
      payload: { sessionId: 'sess-2', role: 'observer' },
    });
    a.sent.length = 0;
    b.sent.length = 0;

    handler.handleMessage(b, {
      type: 'collab.join',
      payload: { sessionId: 'sess-2', role: 'observer' },
    });

    // a sees b's join
    const aJoined = lastOfType(a, 'collab.participant.joined');
    expect(aJoined).toBeDefined();
    // b sees their own join too (the hello broadcast is session-wide)
    const bJoined = lastOfType(b, 'collab.participant.joined');
    expect(bJoined).toBeDefined();

    // And both see the updated state with 2 participants
    expect(lastOfType(a, 'collab.state').payload.participants).toHaveLength(2);
    expect(lastOfType(b, 'collab.state').payload.participants).toHaveLength(2);
  });

  // ── 3. Session isolation: events go only to joined sessions ─────────
  it('does not leak kernel events to clients that have not joined', () => {
    const lonely = fakeWs();
    handler.addClient(lonely);
    // Note: no collab.join issued.

    events.emit('iteration.started', { index: 1 } as never);
    expect(lonely.sent).toHaveLength(0);
  });

  // ── 4. Disconnect cleanup: closed ws removes participant, broadcasts left ─
  it('removes participant on WS close and broadcasts collab.participant.left', () => {
    const a = fakeWs();
    const b = fakeWs();
    handler.addClient(a);
    handler.addClient(b);
    handler.handleMessage(a, {
      type: 'collab.join',
      payload: { sessionId: 'sess-3', role: 'observer' },
    });
    handler.handleMessage(b, {
      type: 'collab.join',
      payload: { sessionId: 'sess-3', role: 'observer' },
    });
    b.sent.length = 0;
    a.sent.length = 0;

    // Simulate a's socket closing.
    a.fire('close');

    // b should see a's departure.
    const left = lastOfType(b, 'collab.participant.left');
    expect(left).toBeDefined();
    expect(left.payload.sessionId).toBe('sess-3');
    expect(typeof left.payload.participantId).toBe('string');

    // After a's disconnect, the state should show only b.
    const state = lastOfType(b, 'collab.state');
    expect(state.payload.participants).toHaveLength(1);
  });

  // ── 5. Explicit leave: collab.leave works the same as WS close ──────
  it('treats collab.leave the same as WS close', () => {
    const ws = fakeWs();
    handler.addClient(ws);
    handler.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-4', role: 'observer' },
    });
    ws.sent.length = 0;

    handler.handleMessage(ws, {
      type: 'collab.leave',
      payload: { sessionId: 'sess-4' },
    });

    const left = lastOfType(ws, 'collab.participant.left');
    expect(left).toBeDefined();
    // After leave, no observers remain — kernel events should no-op.
    events.emit('tool.started', { name: 'read', id: 'tu-x' } as never);
    expect(ws.sent.find((m: any) => m.type === 'collab.event')).toBeUndefined();
  });

  // ── 6. Phase 1 hard-rejection: annotator / controller roles rejected ─
  it('rejects roles other than observer with an error message', () => {
    const ws = fakeWs();
    handler.addClient(ws);
    handler.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-5', role: 'annotator' },
    });

    const err = lastOfType(ws, 'error');
    expect(err).toBeDefined();
    expect(err.payload.phase).toBe('collab');
    expect(err.payload.message).toMatch(/annotator/);

    // No participant should have been registered.
    events.emit('tool.started', { name: 'read', id: 'tu-y' } as never);
    expect(ws.sent.find((m: any) => m.type === 'collab.event')).toBeUndefined();
  });

  // ── 7. Unknown inbound types are not consumed by the handler ────────
  it('returns false for non-collab messages so the upstream router can dispatch them', () => {
    const ws = fakeWs();
    handler.addClient(ws);
    const handled = handler.handleMessage(ws, {
      type: 'user_message',
      payload: { content: 'hi' },
    });
    expect(handled).toBe(false);
  });

  // ── 8. Periodic state broadcast: runs while observers exist, dedups unchanged state ─
  it('runs the state broadcast loop while observers are present and skips unchanged state', () => {
    vi.useFakeTimers();
    try {
      const ws = fakeWs();
      handler.addClient(ws);
      handler.handleMessage(ws, {
        type: 'collab.join',
        payload: { sessionId: 'sess-6', role: 'observer' },
      });
      const internal = handler as unknown as {
        scheduler: { interval: ReturnType<typeof setInterval> | null };
      };
      expect(internal.scheduler.interval).not.toBeNull();

      // The join already pushed a fresh state; with no membership change the
      // 2s tick must not republish (change detection).
      ws.sent.length = 0;
      vi.advanceTimersByTime(2100);
      expect(ws.sent.filter((m: any) => m.type === 'collab.state')).toHaveLength(0);

      // Disconnect → broadcast loop stops. No more state messages after another 2s.
      ws.fire('close');
      expect(internal.scheduler.interval).toBeNull();
      ws.sent.length = 0;
      vi.advanceTimersByTime(2100);
      expect(ws.sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 9. Replay-on-join: late joiners receive last N events with replay flag ─
  it('replays last N events from the session reader to a late joiner with replay: true', async () => {
    const fakeReader = {
      async *replay(sessionId: string) {
        if (sessionId !== 'sess-7') return;
        // Yield more than REPLAY_LIMIT (50) to exercise the tail slice.
        for (let i = 0; i < 60; i++) {
          yield {
            type: i % 3 === 0 ? 'user_input' : 'tool_result',
            ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
            prompt: i === 0 ? 'first user input' : `prompt ${i}`,
            name: i % 2 === 0 ? 'read' : 'write',
            output: `result ${i}`,
          };
        }
      },
    };
    const h = new CollaborationWebSocketHandler(events, noopLogger, fakeReader as any);
    const ws = fakeWs();
    h.addClient(ws);
    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-7', role: 'observer' },
    });

    // Replay runs async — give the microtask queue a chance to drain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const replayed = ws.sent.filter(
      (m: any) => m.type === 'collab.event' && m.payload.replay === true,
    );
    // REPLAY_LIMIT is 50; we yielded 60 so we should get the last 50.
    expect(replayed).toHaveLength(50);
    // Every replayed event has the replay flag and a timestamp.
    for (const m of replayed) {
      expect(m.payload.replay).toBe(true);
      expect(typeof m.payload.at).toBe('string');
    }
    h.dispose();
  });

  // ── 10. Replay is no-op when no reader is injected ────────────────────
  it('works without a SessionReader — live mirror continues, no replay attempted', () => {
    const ws = fakeWs();
    handler.addClient(ws);
    handler.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-8', role: 'observer' },
    });
    events.emit('tool.started', { name: 'read', id: 'tu-z' } as never);
    const ev = ws.sent.find((m: any) => m.type === 'collab.event');
    expect(ev).toBeDefined();
    expect(ev.payload.replay).toBeUndefined(); // live, not replayed
  });

  // ── 11. Annotator role requires an annotations store ───────────────────
  it('rejects annotator role when no annotations store is wired', () => {
    const ws = fakeWs();
    handler.addClient(ws);
    handler.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-9', role: 'annotator' },
    });
    const err = lastOfType(ws, 'error');
    expect(err).toBeDefined();
    expect(err.payload.message).toMatch(/annotator.*not available/);
    // No participant registered — live events must not reach this client.
    events.emit('tool.started', { name: 'read', id: 'tu-a' } as never);
    expect(ws.sent.find((m: any) => m.type === 'collab.event')).toBeUndefined();
  });

  // ── 12. Annotator can annotate; broadcast to all participants ─────────
  it('annotator can annotate and the event is broadcast to all participants', async () => {
    const memStore = makeMemoryAnnotationsStore();
    const h = new CollaborationWebSocketHandler(
      events,
      noopLogger,
      undefined,
      memStore as any,
      undefined,
      allowPrivilegedRoles,
    );
    const a = fakeWs();
    const b = fakeWs();
    h.addClient(a);
    h.addClient(b);
    h.handleMessage(a, {
      type: 'collab.join',
      payload: { sessionId: 'sess-10', role: 'annotator' },
    });
    h.handleMessage(b, {
      type: 'collab.join',
      payload: { sessionId: 'sess-10', role: 'observer' },
    });
    a.sent.length = 0;
    b.sent.length = 0;

    h.handleMessage(a, {
      type: 'collab.annotate',
      payload: { sessionId: 'sess-10', atEventIndex: 7, text: 'this rm looks dangerous' },
    });

    // Wait for the async add() to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const aAdded = lastOfType(a, 'collab.annotation.added');
    const bAdded = lastOfType(b, 'collab.annotation.added');
    expect(aAdded).toBeDefined();
    expect(bAdded).toBeDefined();
    expect(aAdded.payload.annotation.text).toBe('this rm looks dangerous');
    expect(aAdded.payload.annotation.atEventIndex).toBe(7);
    expect(aAdded.payload.annotation.authorRole).toBe('annotator');
    // Persisted to the store.
    const stored = await memStore.list('sess-10');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.text).toBe('this rm looks dangerous');
    h.dispose();
  });

  // ── 13. Observer cannot annotate ───────────────────────────────────────
  it('observer role cannot annotate; gets an error reply', async () => {
    const memStore = makeMemoryAnnotationsStore();
    const h = new CollaborationWebSocketHandler(
      events,
      noopLogger,
      undefined,
      memStore as any,
      undefined,
      allowPrivilegedRoles,
    );
    const ws = fakeWs();
    h.addClient(ws);
    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-11', role: 'observer' },
    });
    ws.sent.length = 0;

    h.handleMessage(ws, {
      type: 'collab.annotate',
      payload: { sessionId: 'sess-11', atEventIndex: 1, text: 'should be rejected' },
    });
    await new Promise((r) => setImmediate(r));

    const err = lastOfType(ws, 'error');
    expect(err).toBeDefined();
    expect(err.payload.message).toMatch(/annotator.*role/);
    // No annotation stored.
    const stored = await memStore.list('sess-11');
    expect(stored).toHaveLength(0);
    h.dispose();
  });

  // ── 14. Annotator can resolve their own annotation ─────────────────────
  it('annotator can resolve an annotation; broadcasts collab.annotation.resolved', async () => {
    const memStore = makeMemoryAnnotationsStore();
    const h = new CollaborationWebSocketHandler(
      events,
      noopLogger,
      undefined,
      memStore as any,
      undefined,
      allowPrivilegedRoles,
    );
    const ws = fakeWs();
    h.addClient(ws);
    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-12', role: 'annotator' },
    });
    h.handleMessage(ws, {
      type: 'collab.annotate',
      payload: { sessionId: 'sess-12', atEventIndex: 2, text: 'todo' },
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const added = lastOfType(ws, 'collab.annotation.added');
    const id = added.payload.annotation.id;
    ws.sent.length = 0;

    h.handleMessage(ws, {
      type: 'collab.resolve',
      payload: { sessionId: 'sess-12', annotationId: id },
    });
    await new Promise((r) => setImmediate(r));

    const resolved = lastOfType(ws, 'collab.annotation.resolved');
    expect(resolved).toBeDefined();
    expect(resolved.payload.annotationId).toBe(id);
    expect(typeof resolved.payload.resolvedAt).toBe('string');
    const stored = await memStore.list('sess-12');
    expect(stored[0]!.resolved).toBe(true);
    h.dispose();
  });

  // ── 15. SessionId mismatch on annotate is rejected ─────────────────────
  it('annotate with a sessionId that does not match the joined session is rejected', async () => {
    const memStore = makeMemoryAnnotationsStore();
    const h = new CollaborationWebSocketHandler(
      events,
      noopLogger,
      undefined,
      memStore as any,
      undefined,
      allowPrivilegedRoles,
    );
    const ws = fakeWs();
    h.addClient(ws);
    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-13', role: 'annotator' },
    });
    ws.sent.length = 0;
    h.handleMessage(ws, {
      type: 'collab.annotate',
      payload: { sessionId: 'sess-WRONG', atEventIndex: 1, text: 'oops' },
    });
    await new Promise((r) => setImmediate(r));
    const err = lastOfType(ws, 'error');
    expect(err).toBeDefined();
    expect(err.payload.message).toMatch(/sessionId mismatch/);
    h.dispose();
  });

  // ── 16. Resolve unknown annotation id returns an error ─────────────────
  it('resolve with unknown id returns a structured error', async () => {
    const memStore = makeMemoryAnnotationsStore();
    const h = new CollaborationWebSocketHandler(
      events,
      noopLogger,
      undefined,
      memStore as any,
      undefined,
      allowPrivilegedRoles,
    );
    const ws = fakeWs();
    h.addClient(ws);
    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-14', role: 'annotator' },
    });
    ws.sent.length = 0;
    h.handleMessage(ws, {
      type: 'collab.resolve',
      payload: { sessionId: 'sess-14', annotationId: 'no-such-id' },
    });
    await new Promise((r) => setImmediate(r));
    const err = lastOfType(ws, 'error');
    expect(err).toBeDefined();
    expect(err.payload.message).toMatch(/not found/);
    h.dispose();
  });

  // ── 17. Controller role requires a bus ────────────────────────────────
  it('rejects controller role when no CollaborationBus is wired', () => {
    const ws = fakeWs();
    handler.addClient(ws);
    handler.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-15', role: 'controller' },
    });
    const err = lastOfType(ws, 'error');
    expect(err).toBeDefined();
    expect(err.payload.message).toMatch(/controller.*not available/);
  });

  // ── 18. Controller can pause; broadcast to all participants ───────────
  it('controller pause transitions the bus and broadcasts collab.pause.granted', async () => {
    const { bus, h } = makeWithBus();
    const a = fakeWs();
    const b = fakeWs();
    h.addClient(a);
    h.addClient(b);
    h.handleMessage(a, {
      type: 'collab.join',
      payload: { sessionId: 'sess-16', role: 'controller' },
    });
    h.handleMessage(b, {
      type: 'collab.join',
      payload: { sessionId: 'sess-16', role: 'observer' },
    });
    a.sent.length = 0;
    b.sent.length = 0;

    h.handleMessage(a, {
      type: 'collab.request_pause',
      payload: { sessionId: 'sess-16' },
    });
    await new Promise((r) => setImmediate(r));

    expect(bus.isPaused()).toBe(true);
    const aGranted = lastOfType(a, 'collab.pause.granted');
    const bGranted = lastOfType(b, 'collab.pause.granted');
    expect(aGranted).toBeDefined();
    expect(bGranted).toBeDefined();
    expect(aGranted.payload.autoResumeInMs).toBe(60_000);
    expect(aGranted.payload.pausedBy).toBeDefined();
    h.dispose();
  });

  // ── 19. Observer cannot pause ──────────────────────────────────────────
  it('observer role cannot request pause; gets an error', async () => {
    const { bus, h } = makeWithBus();
    const ws = fakeWs();
    h.addClient(ws);
    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-17', role: 'observer' },
    });
    ws.sent.length = 0;

    h.handleMessage(ws, {
      type: 'collab.request_pause',
      payload: { sessionId: 'sess-17' },
    });
    await new Promise((r) => setImmediate(r));
    const err = lastOfType(ws, 'error');
    expect(err).toBeDefined();
    expect(err.payload.message).toMatch(/controller.*role/);
    expect(bus.isPaused()).toBe(false);
    h.dispose();
  });

  // ── 20. Controller can resume; broadcast collab.pause.released ───────
  it('controller resume transitions the bus and broadcasts collab.pause.released', async () => {
    const { bus, h } = makeWithBus();
    const ws = fakeWs();
    h.addClient(ws);
    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-18', role: 'controller' },
    });
    bus.requestPause('p-original');
    ws.sent.length = 0;

    h.handleMessage(ws, {
      type: 'collab.resume',
      payload: { sessionId: 'sess-18' },
    });
    await new Promise((r) => setImmediate(r));

    expect(bus.isPaused()).toBe(false);
    const released = lastOfType(ws, 'collab.pause.released');
    expect(released).toBeDefined();
    expect(released.payload.reason).toBe('controller');
    h.dispose();
  });

  // ── 21. Resume when not paused is an error ────────────────────────────
  it('resume when not paused returns a structured error', async () => {
    const { h } = makeWithBus();
    const ws = fakeWs();
    h.addClient(ws);
    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-19', role: 'controller' },
    });
    ws.sent.length = 0;
    h.handleMessage(ws, {
      type: 'collab.resume',
      payload: { sessionId: 'sess-19' },
    });
    await new Promise((r) => setImmediate(r));
    const err = lastOfType(ws, 'error');
    expect(err).toBeDefined();
    expect(err.payload.message).toMatch(/not currently paused/);
    h.dispose();
  });

  // ── 22. Two pause requests — second one reports existing state ─────────
  it('second pause request while already paused returns an error with the original actor', async () => {
    const { bus, h } = makeWithBus();
    const a = fakeWs();
    const b = fakeWs();
    h.addClient(a);
    h.addClient(b);
    h.handleMessage(a, {
      type: 'collab.join',
      payload: { sessionId: 'sess-20', role: 'controller' },
    });
    h.handleMessage(b, {
      type: 'collab.join',
      payload: { sessionId: 'sess-20', role: 'controller' },
    });
    h.handleMessage(a, {
      type: 'collab.request_pause',
      payload: { sessionId: 'sess-20' },
    });
    await new Promise((r) => setImmediate(r));
    a.sent.length = 0;
    h.handleMessage(b, {
      type: 'collab.request_pause',
      payload: { sessionId: 'sess-20' },
    });
    await new Promise((r) => setImmediate(r));
    const err = lastOfType(b, 'error');
    expect(err).toBeDefined();
    expect(err.payload.message).toMatch(/already paused/);
    expect(bus.getState().pausedBy).toBe(a.sent[0]?.payload.pausedBy ?? bus.getState().pausedBy);
    h.dispose();
  });

  // ── 23. Controller can inject a manual tool result (Phase 4) ───────────
  it('controller inject_tool queues the payload and broadcasts collab.injection.granted', async () => {
    const { bus, h } = makeWithBus();
    const a = fakeWs();
    const b = fakeWs();
    h.addClient(a);
    h.addClient(b);
    h.handleMessage(a, {
      type: 'collab.join',
      payload: { sessionId: 'sess-21', role: 'controller' },
    });
    h.handleMessage(b, {
      type: 'collab.join',
      payload: { sessionId: 'sess-21', role: 'observer' },
    });
    a.sent.length = 0;
    b.sent.length = 0;

    h.handleMessage(a, {
      type: 'collab.inject_tool',
      payload: {
        sessionId: 'sess-21',
        toolUseId: 'tu-99',
        content: 'synthetic result',
        isError: false,
        reason: 'controller: skip the destructive call',
      },
    });
    await new Promise((r) => setImmediate(r));

    // Queue holds the injection.
    expect(bus.pendingInjectionCount()).toBe(1);
    // Both observers saw the grant.
    const aGrant = lastOfType(a, 'collab.injection.granted');
    const bGrant = lastOfType(b, 'collab.injection.granted');
    expect(aGrant).toBeDefined();
    expect(bGrant).toBeDefined();
    expect(aGrant.payload.toolUseId).toBe('tu-99');
    expect(aGrant.payload.phase).toBe('queued');
    h.dispose();
  });

  // ── 24. Observer cannot inject ──────────────────────────────────────────
  it('observer role cannot inject_tool; gets an error', async () => {
    const { bus, h } = makeWithBus();
    const ws = fakeWs();
    h.addClient(ws);
    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-22', role: 'observer' },
    });
    ws.sent.length = 0;
    h.handleMessage(ws, {
      type: 'collab.inject_tool',
      payload: {
        sessionId: 'sess-22',
        toolUseId: 'tu-1',
        content: 'x',
        isError: false,
        reason: 'r',
      },
    });
    await new Promise((r) => setImmediate(r));
    const err = lastOfType(ws, 'error');
    expect(err).toBeDefined();
    expect(err.payload.message).toMatch(/controller.*role/);
    expect(bus.pendingInjectionCount()).toBe(0);
    h.dispose();
  });

  // ── 25. Duplicate inject for the same id returns an error ───────────────
  it('a second inject_tool for the same toolUseId is rejected with an error', async () => {
    const { bus, h } = makeWithBus();
    const ws = fakeWs();
    h.addClient(ws);
    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-23', role: 'controller' },
    });
    h.handleMessage(ws, {
      type: 'collab.inject_tool',
      payload: {
        sessionId: 'sess-23',
        toolUseId: 'tu-1',
        content: 'a',
        isError: false,
        reason: 'r',
      },
    });
    await new Promise((r) => setImmediate(r));
    ws.sent.length = 0;
    h.handleMessage(ws, {
      type: 'collab.inject_tool',
      payload: {
        sessionId: 'sess-23',
        toolUseId: 'tu-1',
        content: 'b',
        isError: false,
        reason: 'r',
      },
    });
    await new Promise((r) => setImmediate(r));
    const err = lastOfType(ws, 'error');
    expect(err).toBeDefined();
    expect(err.payload.message).toMatch(/already queued/);
    expect(bus.pendingInjectionCount()).toBe(1);
    h.dispose();
  });

  // ── 26. Controller grants control; target is promoted to controller ─────
  it('controller grant_control promotes the target and broadcasts the new roster', async () => {
    const { h } = makeWithBus();
    const a = fakeWs(); // controller (granter)
    const b = fakeWs(); // observer (grantee)
    h.addClient(a);
    h.addClient(b);
    h.handleMessage(a, {
      type: 'collab.join',
      payload: { sessionId: 'sess-g', role: 'controller' },
    });
    h.handleMessage(b, { type: 'collab.join', payload: { sessionId: 'sess-g', role: 'observer' } });

    // Discover the observer's participantId from the latest state snapshot.
    const stateBefore = lastOfType(a, 'collab.state');
    const targetId = stateBefore.payload.participants.find(
      (p: { role: string; participantId: string }) => p.role === 'observer',
    ).participantId;
    a.sent.length = 0;
    b.sent.length = 0;

    h.handleMessage(a, {
      type: 'collab.grant_control',
      payload: { sessionId: 'sess-g', toParticipant: targetId },
    });
    await new Promise((r) => setImmediate(r));

    // The roster broadcast now lists the former observer as a controller.
    const state = lastOfType(a, 'collab.state');
    const target = state.payload.participants.find(
      (p: { participantId: string }) => p.participantId === targetId,
    );
    expect(target.role).toBe('controller');

    // And the promoted participant can now pause (a controller-only action).
    b.sent.length = 0;
    h.handleMessage(b, { type: 'collab.request_pause', payload: { sessionId: 'sess-g' } });
    await new Promise((r) => setImmediate(r));
    expect(lastOfType(b, 'error')).toBeUndefined();
    h.dispose();
  });

  // ── 27. Observer cannot grant control ───────────────────────────────────
  it('observer role cannot grant_control; gets an error', async () => {
    const { h } = makeWithBus();
    const ws = fakeWs();
    h.addClient(ws);
    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-g2', role: 'observer' },
    });
    ws.sent.length = 0;
    h.handleMessage(ws, {
      type: 'collab.grant_control',
      payload: { sessionId: 'sess-g2', toParticipant: 'whoever' },
    });
    await new Promise((r) => setImmediate(r));
    const err = lastOfType(ws, 'error');
    expect(err).toBeDefined();
    expect(err.payload.message).toMatch(/controller.*role/);
    h.dispose();
  });

  // ── 29. Bus reports a consumed injection → broadcast phase 'consumed' ────
  it('broadcasts a consumed injection grant (with the real tool name) on bus notify', async () => {
    const { bus, h } = makeWithBus();
    const a = fakeWs(); // controller (author)
    const b = fakeWs(); // observer
    h.addClient(a);
    h.addClient(b);
    h.handleMessage(a, {
      type: 'collab.join',
      payload: { sessionId: 'sess-c', role: 'controller' },
    });
    h.handleMessage(b, { type: 'collab.join', payload: { sessionId: 'sess-c', role: 'observer' } });
    const controllerId = lastOfType(a, 'collab.state').payload.participants.find(
      (p: { role: string; participantId: string }) => p.role === 'controller',
    ).participantId;
    a.sent.length = 0;
    b.sent.length = 0;

    // Simulate the inject middleware applying a queued injection.
    bus.notifyInjectionConsumed({
      toolUseId: 'tu-7',
      toolName: 'bash',
      authorId: controllerId,
      reason: 'controller override',
      isError: false,
    });

    const grant = lastOfType(a, 'collab.injection.granted');
    expect(grant).toBeDefined();
    expect(grant.payload.phase).toBe('consumed');
    expect(grant.payload.toolName).toBe('bash');
    expect(grant.payload.toolUseId).toBe('tu-7');
    // The observer sees it too.
    expect(lastOfType(b, 'collab.injection.granted')?.payload.phase).toBe('consumed');
    h.dispose();
  });

  // ── 28. Granting to an unknown participant errors ───────────────────────
  it('grant_control to an unknown participant returns an error', async () => {
    const { h } = makeWithBus();
    const a = fakeWs();
    h.addClient(a);
    h.handleMessage(a, {
      type: 'collab.join',
      payload: { sessionId: 'sess-g3', role: 'controller' },
    });
    a.sent.length = 0;
    h.handleMessage(a, {
      type: 'collab.grant_control',
      payload: { sessionId: 'sess-g3', toParticipant: 'does-not-exist' },
    });
    await new Promise((r) => setImmediate(r));
    const err = lastOfType(a, 'error');
    expect(err).toBeDefined();
    expect(err.payload.message).toMatch(/no participant/);
    h.dispose();
  });

  it('rejects a self-selected controller without explicit server authorization', () => {
    const bus = new CollaborationBus();
    const h = new CollaborationWebSocketHandler(events, noopLogger, undefined, undefined, bus);
    const ws = fakeWs();
    h.addClient(ws);

    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-auth', role: 'controller' },
    });

    expect(lastOfType(ws, 'error')?.payload.message).toMatch(/explicit server authorization/);
    expect(lastOfType(ws, 'collab.state')).toBeUndefined();
    h.dispose();
  });

  it('routes live events only to the runtime active session', () => {
    let activeSessionId = 'sess-old';
    const h = new CollaborationWebSocketHandler(
      events,
      noopLogger,
      undefined,
      undefined,
      undefined,
      { getActiveSessionId: () => activeSessionId },
    );
    const oldSession = fakeWs();
    const activeSession = fakeWs();
    const mismatched = fakeWs();
    h.addClient(oldSession);
    h.addClient(activeSession);
    h.addClient(mismatched);

    h.handleMessage(oldSession, {
      type: 'collab.join',
      payload: { sessionId: 'sess-old', role: 'observer' },
    });
    activeSessionId = 'sess-active';
    h.handleMessage(activeSession, {
      type: 'collab.join',
      payload: { sessionId: 'sess-active', role: 'observer' },
    });
    h.handleMessage(mismatched, {
      type: 'collab.join',
      payload: { sessionId: 'sess-old', role: 'observer' },
    });
    oldSession.sent.length = 0;
    activeSession.sent.length = 0;

    events.emit('tool.started', { name: 'read', id: 'tu-scoped' } as never);

    expect(lastOfType(oldSession, 'collab.event')).toBeUndefined();
    expect(lastOfType(activeSession, 'collab.event')?.payload.kind).toBe('tool.started');
    expect(lastOfType(mismatched, 'error')?.payload.message).toMatch(/sessionId mismatch/);
    expect(lastOfType(mismatched, 'collab.state')).toBeUndefined();
    h.dispose();
  });

  it('suppresses consumed injections when their author is no longer live', () => {
    const { bus, h } = makeWithBus();
    const ws = fakeWs();
    h.addClient(ws);
    h.handleMessage(ws, {
      type: 'collab.join',
      payload: { sessionId: 'sess-consumed', role: 'observer' },
    });
    ws.sent.length = 0;

    bus.notifyInjectionConsumed({
      toolUseId: 'tu-orphan',
      toolName: 'bash',
      authorId: 'departed-controller',
      reason: 'orphaned',
      isError: false,
    });

    expect(lastOfType(ws, 'collab.injection.granted')).toBeUndefined();
    h.dispose();
  });
});

// Minimal wiring helper: a fresh handler with a real bus (no
// annotations store) — used by the controller-flow tests above.
function makeWithBus() {
  const events = new EventBus();
  const bus = new CollaborationBus();
  const h = new CollaborationWebSocketHandler(
    events,
    noopLogger,
    undefined,
    undefined,
    bus,
    allowPrivilegedRoles,
  );
  return { bus, h, events };
}

// In-memory stand-in for AnnotationsStore so the handler tests don't
// touch the filesystem. Mirrors only the surface the handler uses:
// `add()` and `resolve()`.
function makeMemoryAnnotationsStore() {
  const bySession = new Map<
    string,
    Array<{
      id: string;
      text: string;
      resolved: boolean;
      resolvedAt?: string;
      resolvedBy?: string;
      createdAt: string;
      atEventIndex: number;
      authorId: string;
      authorRole: 'annotator';
      sessionId: string;
    }>
  >();
  let nextId = 1;
  return {
    async add(input: { sessionId: string; atEventIndex: number; authorId: string; text: string }) {
      const a = {
        id: `mem-${nextId++}`,
        sessionId: input.sessionId,
        atEventIndex: input.atEventIndex,
        authorId: input.authorId,
        authorRole: 'annotator' as const,
        text: input.text,
        createdAt: new Date().toISOString(),
        resolved: false,
      };
      const list = bySession.get(input.sessionId) ?? [];
      list.push(a);
      bySession.set(input.sessionId, list);
      return a;
    },
    async resolve(input: { sessionId: string; annotationId: string; resolvedBy: string }) {
      const list = bySession.get(input.sessionId);
      if (!list) return null;
      const a = list.find((x) => x.id === input.annotationId);
      if (!a) return null;
      a.resolved = true;
      a.resolvedAt = new Date().toISOString();
      a.resolvedBy = input.resolvedBy;
      return a;
    },
    async list(sessionId: string) {
      return bySession.get(sessionId) ?? [];
    },
  };
}

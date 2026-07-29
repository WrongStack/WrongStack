import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (msg: unknown) => void;

// ── ws-client stub ──────────────────────────────────────────────────────────
// `sendRosterMessage` calls getWSClient() per invocation, so a module-level
// mutable stub is enough; each test resets it in beforeEach.

const handlers = new Map<string, Set<Handler>>();
const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
let connectImpl: () => Promise<void> = async () => {};

const client = {
  connect: () => connectImpl(),
  send: (msg: { type: string; payload?: Record<string, unknown> }) => {
    sent.push(msg);
    return true;
  },
  on: (type: string, handler: Handler) => {
    const set = handlers.get(type) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(type, set);
    return () => {
      set.delete(handler);
    };
  },
};

vi.mock('@/lib/ws-client', () => ({ getWSClient: () => client }));

const { sendRosterMessage } = await import('../../src/lib/roster-ws');

function emit(type: string, msg: unknown) {
  for (const h of [...(handlers.get(type) ?? [])]) h(msg);
}

function listenerCount(type: string) {
  return handlers.get(type)?.size ?? 0;
}

function totalListeners() {
  let n = 0;
  for (const set of handlers.values()) n += set.size;
  return n;
}

/** Let the internal `client.connect().then(...)` microtask run. */
const flush = () => Promise.resolve().then(() => undefined);

describe('sendRosterMessage', () => {
  beforeEach(() => {
    handlers.clear();
    sent.length = 0;
    connectImpl = async () => {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects before sending, then resolves with the reply payload', async () => {
    const promise = sendRosterMessage('agent-roster.list', { scope: 'all' });
    await flush();
    expect(sent).toEqual([{ type: 'agent-roster.list', payload: { scope: 'all' } }]);
    emit('agent-roster.list', { payload: { agents: ['a', 'b'] } });
    await expect(promise).resolves.toEqual({ agents: ['a', 'b'] });
  });

  it('sends payload: undefined when the caller omits it', async () => {
    const promise = sendRosterMessage('agent-roster.list');
    await flush();
    expect(sent[0]).toEqual({ type: 'agent-roster.list', payload: undefined });
    emit('agent-roster.list', { payload: {} });
    await promise;
  });

  it('unwraps the envelope but falls back to the envelope itself when there is no payload', async () => {
    const promise = sendRosterMessage('agent-roster.list');
    await flush();
    emit('agent-roster.list', { agents: [] });
    await expect(promise).resolves.toEqual({ agents: [] });
  });

  it('passes a non-object reply straight through', async () => {
    const promise = sendRosterMessage('agent-roster.ping');
    await flush();
    emit('agent-roster.ping', 'pong');
    await expect(promise).resolves.toBe('pong');
  });

  it('accepts the unwrapped reply type for backwards compatibility', async () => {
    const promise = sendRosterMessage('agent-roster.list');
    await flush();
    // Old servers replied with `list` rather than `agent-roster.list`.
    expect(listenerCount('list')).toBe(1);
    emit('list', { payload: { agents: [] } });
    await expect(promise).resolves.toEqual({ agents: [] });
  });

  it('registers only the exact listener when the type has no agent-roster. prefix', async () => {
    const promise = sendRosterMessage('roster.custom');
    await flush();
    expect(listenerCount('roster.custom')).toBe(1);
    expect(totalListeners()).toBe(1);
    emit('roster.custom', { payload: 'ok' });
    await promise;
  });

  it('does not strip a bare "agent-roster." with nothing after it', async () => {
    const promise = sendRosterMessage('agent-roster.');
    await flush();
    // stripPrefix requires length > PREFIX.length, so no second listener.
    expect(totalListeners()).toBe(1);
    emit('agent-roster.', { payload: 'ok' });
    await promise;
  });

  it('rejects with the server-supplied error string', async () => {
    const promise = sendRosterMessage('agent-roster.list');
    await flush();
    emit('agent-roster.list', { payload: { error: 'roster unavailable' } });
    await expect(promise).rejects.toThrow('roster unavailable');
  });

  it('treats a non-string error field as a normal payload', async () => {
    const promise = sendRosterMessage('agent-roster.list');
    await flush();
    emit('agent-roster.list', { payload: { error: 500 } });
    await expect(promise).resolves.toEqual({ error: 500 });
  });

  it('detaches every listener once settled', async () => {
    const promise = sendRosterMessage('agent-roster.list');
    await flush();
    expect(totalListeners()).toBe(2); // exact + stripped
    emit('agent-roster.list', { payload: {} });
    await promise;
    expect(totalListeners()).toBe(0);
  });

  it('ignores a second reply after settling', async () => {
    const promise = sendRosterMessage('agent-roster.list');
    await flush();
    const handler = [...(handlers.get('agent-roster.list') ?? [])][0];
    emit('agent-roster.list', { payload: { first: true } });
    await expect(promise).resolves.toEqual({ first: true });
    // Re-invoking the captured handler must not throw or re-settle.
    expect(() => handler({ payload: { second: true } })).not.toThrow();
    await expect(promise).resolves.toEqual({ first: true });
  });

  it('supersedes an in-flight request of the same type (RACE guard)', async () => {
    const first = sendRosterMessage('agent-roster.list');
    await flush();
    const second = sendRosterMessage('agent-roster.list');
    await flush();

    await expect(first).rejects.toThrow(
      'Roster request "agent-roster.list" superseded by new request',
    );
    // The late reply resolves the *new* promise, not the superseded one.
    emit('agent-roster.list', { payload: { agents: ['fresh'] } });
    await expect(second).resolves.toEqual({ agents: ['fresh'] });
  });

  it('does not supersede requests of a different type', async () => {
    const list = sendRosterMessage('agent-roster.list');
    const stats = sendRosterMessage('agent-roster.stats');
    await flush();
    emit('agent-roster.list', { payload: 'L' });
    emit('agent-roster.stats', { payload: 'S' });
    await expect(list).resolves.toBe('L');
    await expect(stats).resolves.toBe('S');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = sendRosterMessage('agent-roster.list', undefined, controller.signal);
    await expect(promise).rejects.toThrow('Aborted');
    // It bails before sending.
    expect(sent).toHaveLength(0);
  });

  it('rejects and detaches when the signal aborts mid-flight (LEAK guard)', async () => {
    const controller = new AbortController();
    const promise = sendRosterMessage('agent-roster.list', undefined, controller.signal);
    await flush();
    expect(totalListeners()).toBe(2);
    controller.abort();
    await expect(promise).rejects.toThrow('Aborted');
    expect(totalListeners()).toBe(0);
  });

  it('removes the abort listener once resolved normally', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const promise = sendRosterMessage('agent-roster.list', undefined, controller.signal);
    await flush();
    emit('agent-roster.list', { payload: {} });
    await promise;
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    // A later abort must not re-settle the promise.
    controller.abort();
    await expect(promise).resolves.toEqual({});
  });

  it('rejects after the 15s timeout', async () => {
    vi.useFakeTimers();
    const promise = sendRosterMessage('agent-roster.list');
    await flush();
    const assertion = expect(promise).rejects.toThrow(
      'Roster request "agent-roster.list" timed out',
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(totalListeners()).toBe(0);
  });

  it('clears the timeout on a normal resolve', async () => {
    vi.useFakeTimers();
    const promise = sendRosterMessage('agent-roster.list');
    await flush();
    emit('agent-roster.list', { payload: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('rejects with the connect() failure and never sends', async () => {
    connectImpl = async () => {
      throw new Error('socket closed');
    };
    await expect(sendRosterMessage('agent-roster.list')).rejects.toThrow('socket closed');
    expect(sent).toHaveLength(0);
    expect(totalListeners()).toBe(0);
  });

  it('never sends when the signal aborts while connect() is still pending', async () => {
    // The abort listener is only attached after connect() resolves, so an
    // abort during the connect window is caught by the `signal.aborted`
    // check — which must fire *before* client.send().
    let release!: () => void;
    connectImpl = () => new Promise<void>((r) => (release = r));
    const controller = new AbortController();
    const promise = sendRosterMessage('agent-roster.list', undefined, controller.signal);
    controller.abort();
    release();
    await expect(promise).rejects.toThrow('Aborted');
    expect(sent).toHaveLength(0);
    expect(totalListeners()).toBe(0);
  });
});

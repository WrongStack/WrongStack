import { afterEach, describe, expect, it, vi } from 'vitest';
import { WrongStackClient } from '../src/index.js';

type Listener = (event: unknown) => void;

/** A socket driven by hand: the test decides when it opens, what it reads and when it drops. */
class HandSocket {
  static all: HandSocket[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {
    HandSocket.all.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  fire(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open(): void {
    this.readyState = 1;
    this.fire('open');
  }
  read(frame: unknown): void {
    this.fire('message', { data: JSON.stringify(frame) });
  }
  send(): void {}
  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close', { code, reason });
  }
}

const start = {
  type: 'session.start',
  payload: { sessionId: 's1', model: 'm', provider: 'p', eventEpoch: 'e1' },
};

afterEach(() => {
  vi.useRealTimers();
  HandSocket.all = [];
});

describe('long reconnect delays', () => {
  it.each([false, true])('waits the full multi-chunk delay (cancelled: %s)', async (cancel) => {
    vi.useFakeTimers();
    const connecting = WrongStackClient.connect({
      url: 'ws://127.0.0.1:1',
      WebSocket: HandSocket as never,
      reconnect: { attempts: 1, initialDelayMs: 2_147_483_652 },
    });
    const first = HandSocket.all[0]!;
    first.open();
    first.read(start);
    const client = await connecting;
    try {
      first.close(1006, 'drop');
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(HandSocket.all).toHaveLength(1);
      if (cancel) {
        client.close();
        expect(vi.getTimerCount()).toBe(0);
      }
      await vi.advanceTimersByTimeAsync(4);
      expect(HandSocket.all).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(HandSocket.all).toHaveLength(cancel ? 1 : 2);
    } finally {
      client.close();
    }
  });
});

describe('close() during a reconnect catch-up (F850)', () => {
  it.each(['reconnecting', 'open'] as const)(
    'stops notifying the earlier %s state when a listener closes',
    async (trigger) => {
      vi.useFakeTimers();
      const connecting = WrongStackClient.connect({
        url: 'ws://127.0.0.1:1',
        WebSocket: HandSocket as never,
        reconnect: { attempts: 1, initialDelayMs: 1 },
      });
      const first = HandSocket.all[0]!;
      first.open();
      first.read(start);
      const client = await connecting;
      const states: string[] = [];
      client.onStateChange((state) => {
        if (state === trigger) client.close();
      });
      client.onStateChange((state) => states.push(state));
      try {
        first.close(1006);
        if (trigger === 'open') {
          await vi.advanceTimersByTimeAsync(1);
          const next = HandSocket.all[1]!;
          next.open();
          next.read(start);
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(client.state).toBe('closed');
        expect(states).toEqual(trigger === 'open' ? ['reconnecting', 'closed'] : ['closed']);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        client.close();
      }
    },
  );

  it.each(['session.start', 'custom.first'])(
    'keeps the client closed when its %s listener closes the new socket',
    async (trigger) => {
      vi.useFakeTimers();
      const connecting = WrongStackClient.connect({
        url: 'ws://127.0.0.1:1',
        WebSocket: HandSocket as never,
        reconnect: { attempts: 1, initialDelayMs: 1 },
      });
      const first = HandSocket.all[0]!;
      first.open();
      first.read(start);
      const client = await connecting;
      const states: string[] = [];
      const trailing = vi.fn();
      client.onStateChange((state) => states.push(state));
      client.on(trigger, () => client.close());
      client.on('custom.trailing', trailing);
      try {
        first.close(1006, 'drop');
        await vi.advanceTimersByTimeAsync(1);
        const next = HandSocket.all[1]!;
        next.open();
        next.read({ type: 'custom.first' });
        next.read({ type: 'custom.trailing' });
        next.read(start);
        await vi.advanceTimersByTimeAsync(0);
        expect(next.readyState).toBe(3);
        expect(client.state).toBe('closed');
        expect(states).toEqual(['reconnecting', 'closed']);
        expect(trailing).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        client.close();
      }
    },
  );

  it('disarms the catch-up timer and never delivers its held frames to the closed client', async () => {
    vi.useFakeTimers();
    const connecting = WrongStackClient.connect({
      url: 'ws://127.0.0.1:1',
      WebSocket: HandSocket as never,
      reconnect: { attempts: 1, initialDelayMs: 1 },
    });
    const first = HandSocket.all[0] as HandSocket;
    first.open();
    first.read(start);
    const client = await connecting;
    const seen: number[] = [];
    client.on('custom.x', (payload) => seen.push((payload as { n: number }).n));
    first.read({ type: 'custom.x', seq: 1, payload: { sessionId: 's1', n: 1 } });

    first.readyState = 3;
    first.fire('close', { code: 1006, reason: 'drop' });
    await vi.advanceTimersByTimeAsync(1);
    const second = HandSocket.all[1] as HandSocket;
    second.open();
    second.read(start);
    await vi.advanceTimersByTimeAsync(0);
    // Skips ahead of the catch-up that has not arrived: held.
    second.read({ type: 'custom.x', seq: 3, payload: { sessionId: 's1', n: 3 } });

    client.close();
    expect(client.state).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toEqual([1]);
  });
});

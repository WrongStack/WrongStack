import { describe, expect, it } from 'vitest';
import { WrongStackClient } from '../src/client.js';

function makeMockWsClass(outcomes: Array<'open' | 'fail'>) {
  let index = 0;
  const sockets: MockWs[] = [];
  class MockWs {
    readyState = 1;
    private listeners = new Map<string, Array<(ev: unknown) => void>>();
    constructor(_url: string) {
      sockets.push(this);
      const outcome = outcomes[index++] ?? 'fail';
      queueMicrotask(() => {
        if (outcome === 'open') {
          this.emit('open', undefined);
          this.emit('message', {
            data: JSON.stringify({
              type: 'session.start',
              payload: { sessionId: 's1', model: 'm1', provider: 'p1', eventEpoch: 'e1' },
            }),
          });
        } else {
          this.readyState = 3;
          this.emit('close', { code: 1006, reason: 'down' });
        }
      });
    }
    send(_data: string): void {}
    close(code = 1000, reason = ''): void {
      this.readyState = 3;
      this.emit('close', { code, reason });
    }
    addEventListener(type: string, listener: (ev: unknown) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    emit(type: string, ev: unknown): void {
      for (const l of this.listeners.get(type) ?? []) l(ev);
    }
  }
  return { MockWs, sockets };
}

describe('WrongStackClient reconnect non-finite policy options (F1864)', () => {
  it('falls back to defaults when attempts or maxDelayMs are NaN while preserving explicit 0', async () => {
    const { MockWs, sockets } = makeMockWsClass(['open', 'open']);
    const client = await WrongStackClient.connect({
      url: 'ws://127.0.0.1:1',
      WebSocket: MockWs as never,
      reconnect: { attempts: Number.NaN, initialDelayMs: 5, maxDelayMs: Number.NaN },
    });
    const done = new Promise<string>((resolve) => {
      client.onStateChange((state) => {
        if (state === 'open' || state === 'closed') resolve(state);
      });
    });
    sockets[0]!.readyState = 3;
    sockets[0]!.emit('close', { code: 1006, reason: 'drop' });
    expect(await done).toBe('open');
    expect(sockets).toHaveLength(2);
    client.close();

    const { MockWs: MockWs0, sockets: sockets0 } = makeMockWsClass(['open', 'open']);
    const client0 = await WrongStackClient.connect({
      url: 'ws://127.0.0.1:1',
      WebSocket: MockWs0 as never,
      reconnect: { attempts: 0 },
    });
    const closed0 = new Promise<string>((resolve) => {
      client0.onStateChange((state) => {
        if (state === 'closed') resolve(state);
      });
    });
    sockets0[0]!.readyState = 3;
    sockets0[0]!.emit('close', { code: 1006, reason: 'drop' });
    expect(await closed0).toBe('closed');
    expect(sockets0).toHaveLength(1);
    client0.close();
  });
});

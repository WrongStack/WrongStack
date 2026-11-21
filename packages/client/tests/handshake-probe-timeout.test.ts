import { afterEach, expect, it, vi } from 'vitest';
import { WrongStackClient } from '../src/index.js';

class RefusedSocket {
  readonly readyState = 3;

  addEventListener(type: string, listener: (...args: never[]) => void): void {
    if (type === 'error') queueMicrotask(listener);
  }

  send(): void {}
  close(): void {}
}

afterEach(() => vi.restoreAllMocks());

it.each([2_000, 2_000.5, 4_294_967_296])(
  'reports the HTTP refusal after a failed handshake with timeoutMs=%s',
  async (timeoutMs) => {
    const probe = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 401 }));

    await expect(
      WrongStackClient.connect({ url: 'ws://127.0.0.1:1', WebSocket: RefusedSocket, timeoutMs }),
    ).rejects.toMatchObject({ kind: 'auth', code: '401' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0]).toEqual(new URL('http://127.0.0.1:1/ws-auth'));
    expect(probe.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  },
);

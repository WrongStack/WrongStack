import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestAuthOperation } from '@/lib/auth-operation';
import type { WrongStackWebSocketClient } from '@/lib/ws-client';

function host() {
  let listener: ((frame: unknown) => void) | undefined;
  const off = vi.fn(() => {
    listener = undefined;
  });
  const send = vi.fn((_message: { payload?: { requestId?: string } }) => true);
  const client = {
    send,
    on: vi.fn((_type: string, fn: (frame: unknown) => void) => {
      listener = fn;
      return off;
    }),
  } as unknown as WrongStackWebSocketClient;
  return {
    client,
    send,
    off,
    emit: (payload: object) => listener?.({ type: 'key.operation_result', payload }),
  };
}
afterEach(() => vi.useRealTimers());
describe('auth operation acknowledgment', () => {
  it('ignores unrelated results and accepts the matching result', async () => {
    const h = host();
    const timeout = vi.fn();
    const operation = requestAuthOperation(
      h.client,
      { type: 'key.add', payload: { providerId: 'work', label: 'main', apiKey: 'fixture' } },
      new AbortController().signal,
      timeout,
    );
    const requestId = (h.send.mock.calls[0] as unknown as [{ payload: { requestId: string } }])[0]
      .payload.requestId;
    h.emit({ requestId: 'unrelated', success: true });
    expect(h.off).not.toHaveBeenCalled();
    h.emit({ requestId, success: false });
    expect(await operation).toBe(false);
    expect(h.off).toHaveBeenCalledOnce();
    expect(timeout).not.toHaveBeenCalled();
  });
  it('cleans up on panel cancellation and timeout', async () => {
    vi.useFakeTimers();
    const h = host();
    const controller = new AbortController();
    const timeout = vi.fn();
    const canceled = requestAuthOperation(
      h.client,
      { type: 'provider.remove', payload: { providerId: 'work' } },
      controller.signal,
      timeout,
    );
    controller.abort();
    expect(await canceled).toBe(false);
    expect(h.off).toHaveBeenCalledOnce();
    const expired = requestAuthOperation(
      h.client,
      { type: 'provider.remove', payload: { providerId: 'work' } },
      new AbortController().signal,
      timeout,
    );
    // A config-write operation answers only after saving the profile config,
    // which waits up to 15 s for the file lock. The deadline must sit past
    // that wait, so it is no longer the old 8 s.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(timeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(37_000);
    expect(await expired).toBe(false);
    expect(timeout).toHaveBeenCalledOnce();
    expect(h.off).toHaveBeenCalledTimes(2);
  });
});

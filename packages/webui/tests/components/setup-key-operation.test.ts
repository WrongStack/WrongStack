import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForKeyOperationResult } from '../../src/components/SetupScreen/key-operation';

type Handler = (msg: unknown) => void;

/** Minimal `getWSClient()`-shaped stub exposing only what the helper uses. */
function fakeClient() {
  const handlers = new Map<string, Set<Handler>>();
  const client = {
    on(type: string, handler: Handler) {
      const set = handlers.get(type) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(type, set);
      return () => {
        set.delete(handler);
      };
    },
  };
  return {
    client: client as unknown as Parameters<typeof waitForKeyOperationResult>[0],
    emit(type: string, msg: unknown) {
      for (const h of [...(handlers.get(type) ?? [])]) h(msg);
    },
    listenerCount(type: string) {
      return handlers.get(type)?.size ?? 0;
    },
  };
}

describe('waitForKeyOperationResult', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the payload of the first key.operation_result message', async () => {
    const { client, emit } = fakeClient();
    const promise = waitForKeyOperationResult(client);
    emit('key.operation_result', { payload: { success: true, message: 'Saved' } });
    await expect(promise).resolves.toEqual({ success: true, message: 'Saved' });
  });

  it('resolves with failure payloads too — it does not reject on success:false', async () => {
    const { client, emit } = fakeClient();
    const promise = waitForKeyOperationResult(client);
    emit('key.operation_result', { payload: { success: false, message: 'Invalid key' } });
    await expect(promise).resolves.toEqual({ success: false, message: 'Invalid key' });
  });

  it('detaches its listener once resolved so a second reply is ignored', async () => {
    const { client, emit, listenerCount } = fakeClient();
    const promise = waitForKeyOperationResult(client);
    expect(listenerCount('key.operation_result')).toBe(1);
    emit('key.operation_result', { payload: { success: true, message: 'first' } });
    await promise;
    expect(listenerCount('key.operation_result')).toBe(0);
    // A late duplicate must not throw or re-settle.
    expect(() =>
      emit('key.operation_result', { payload: { success: false, message: 'late' } }),
    ).not.toThrow();
    await expect(promise).resolves.toEqual({ success: true, message: 'first' });
  });

  it('clears the timeout on resolve so no stray timer survives', async () => {
    vi.useFakeTimers();
    const { client, emit } = fakeClient();
    const promise = waitForKeyOperationResult(client, 5_000);
    emit('key.operation_result', { payload: { success: true, message: 'ok' } });
    await expect(promise).resolves.toEqual({ success: true, message: 'ok' });
    // If the timer were still armed it would reject an already-settled promise;
    // advancing past the deadline must be a no-op.
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual({ success: true, message: 'ok' });
  });

  it('rejects with "timeout" when no reply arrives before the deadline', async () => {
    vi.useFakeTimers();
    const { client } = fakeClient();
    const promise = waitForKeyOperationResult(client, 3_000);
    const assertion = expect(promise).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

  it('detaches its listener when it times out', async () => {
    vi.useFakeTimers();
    const { client, listenerCount } = fakeClient();
    const promise = waitForKeyOperationResult(client, 1_000);
    const assertion = expect(promise).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(listenerCount('key.operation_result')).toBe(0);
  });

  it('defaults to an 8s deadline when no timeout is supplied', async () => {
    vi.useFakeTimers();
    const { client } = fakeClient();
    const promise = waitForKeyOperationResult(client);
    const assertion = expect(promise).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(7_999);
    // Still pending one millisecond short of the default deadline.
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

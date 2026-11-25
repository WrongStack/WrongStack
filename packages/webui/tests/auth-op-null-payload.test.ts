import { describe, expect, it } from 'vitest';
import { requestAuthOperation } from '../src/lib/auth-operation';

describe('requestAuthOperation null payload guard (F2230)', () => {
  it('ignores null/non-object payloads without crashing the listener', async () => {
    let handler: ((frame: unknown) => void) | undefined;
    let sentRequestId = '';
    const client = {
      on(_type: string, fn: (frame: unknown) => void) {
        handler = fn;
        return () => {};
      },
      send(msg: { payload?: { requestId?: string } }) {
        sentRequestId = msg.payload?.requestId ?? '';
        return true;
      },
    };
    const ac = new AbortController();
    const promise = requestAuthOperation(
      client as unknown as Parameters<typeof requestAuthOperation>[0],
      { type: 'key.list', payload: {} } as unknown as Parameters<typeof requestAuthOperation>[1],
      ac.signal,
      () => {},
    );

    handler?.({ type: 'key.operation_result', payload: null });
    handler?.({
      type: 'key.operation_result',
      payload: { requestId: sentRequestId, success: true },
    });
    await expect(promise).resolves.toBe(true);
  });
});

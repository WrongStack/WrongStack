import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineOperations } from '../src/engine-operations.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EngineOperations replacement timer cleanup', () => {
  it('clears the replacement pending.timer when send() rejects after caughtUp()', async () => {
    vi.useFakeTimers();
    const sendGate = deferred<void>();
    const ops = new EngineOperations(async () => sendGate.promise, 10_000, 100);

    ops.replaying();
    const req = ops.request('test', {}, ['test.ok']).catch((e) => e as Error);
    ops.caughtUp();
    sendGate.reject(new Error('send failed after caughtUp'));

    const err = await req;
    expect(err).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });
});

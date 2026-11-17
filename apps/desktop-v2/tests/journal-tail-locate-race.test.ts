import { afterEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const locateGates: Array<ReturnType<typeof deferred<{ offset: number; tail: boolean }>>> = [];
const pollOffsets: unknown[] = [];

vi.mock('../src/platform.js', () => ({
  request: async (_type: string, payload: { tail?: boolean; offset?: number }) => {
    if (payload.tail) {
      const gate = deferred<{ offset: number; tail: boolean }>();
      locateGates.push(gate);
      return gate.promise;
    }
    pollOffsets.push(payload.offset);
    return { offset: payload.offset ?? 0, events: [], hasMore: false };
  },
}));

const { JournalTail } = await import('../src/journal-tail.js');

afterEach(() => {
  vi.useRealTimers();
  locateGates.length = 0;
  pollOffsets.length = 0;
});

describe('JournalTail locate() run guard', () => {
  it('ignores stale locate() from before stop() when a new subscriber attaches', async () => {
    vi.useFakeTimers();
    const tail = new JournalTail('proj-locate-race');

    const unsub1 = tail.listen(() => {});
    unsub1();
    const unsub2 = tail.listen(() => {});
    expect(locateGates.length).toBe(2);

    locateGates[0]!.resolve({ offset: 100, tail: true });
    await Promise.resolve();
    await Promise.resolve();

    locateGates[1]!.resolve({ offset: 500, tail: true });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(pollOffsets[0]).toBe(500);
    unsub2();
  });
});

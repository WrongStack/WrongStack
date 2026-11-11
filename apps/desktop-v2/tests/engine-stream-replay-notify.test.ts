import { afterEach, describe, expect, it, vi } from 'vitest';

const pages = vi.hoisted(() => ({ count: 0, total: 40 }));
vi.mock('../src/platform', () => ({
  native: false,
  request: vi.fn(async (_method: string, args: { offset: number }) => {
    pages.count += 1;
    // Past the end the journal has nothing new: idle polls read nothing.
    if (args.offset >= pages.total)
      return { offset: args.offset, events: [], hasMore: false, size: pages.total };
    const offset = args.offset + 1;
    return {
      offset,
      events: [{ type: 'tool.executed', payload: { name: 'read', ok: true }, at: offset }],
      hasMore: offset < pages.total,
      size: pages.total,
    };
  }),
}));

import { backendStream, REPLAY_NOTIFY_MS } from '../src/engine-stream';

afterEach(() => {
  vi.useRealTimers();
});

describe('BackendStream first read', () => {
  it('reads every page but re-renders its views only a few times a second until the end', async () => {
    vi.useFakeTimers();
    const notified: { synced: boolean; hydrating: boolean }[] = [];
    const stream = backendStream('engine', 'replay-notify');
    const stop = stream.subscribe({
      changed: () =>
        notified.push({ synced: stream.state.synced, hydrating: stream.state.hydrating }),
      onError: (error) => {
        throw error;
      },
    });
    // Pages follow each other at once (timer 0); the whole read takes well under one interval.
    await vi.advanceTimersByTimeAsync(REPLAY_NOTIFY_MS - 50);
    // Every page was read (plus the idle polls that follow the end).
    expect(pages.count).toBeGreaterThanOrEqual(pages.total);
    // The first page and the end are reported; the pages between them are not.
    expect(notified.length).toBeLessThanOrEqual(2);
    expect(notified.at(-1)).toEqual({ synced: true, hydrating: false });
    expect(stream.state.activity).toHaveLength(pages.total);
    stop();
  });
});

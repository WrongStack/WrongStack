import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/platform', () => ({
  native: false,
  request: vi.fn(async () => ({ offset: 4, events: [], hasMore: false, size: 4 })),
}));

import { backendStream } from '../src/engine-stream';
import { request } from '../src/platform';

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('BackendStream stop during notification', () => {
  it('backs off empty reads and wakes immediately when the user sends a command', async () => {
    vi.useFakeTimers();
    vi.mocked(request).mockClear();
    const stream = backendStream('engine', 'idle-and-wake');
    const stop = stream.subscribe({
      changed() {},
      onError(error) {
        throw error;
      },
    });
    const reads = () =>
      vi.mocked(request).mock.calls.filter(([method]) => method === 'engine.events').length;
    try {
      await vi.advanceTimersByTimeAsync(2_100);
      expect(reads()).toBe(5);
      const previous = reads();
      await stream.send('stats.get');
      await vi.advanceTimersByTimeAsync(1);
      expect(reads()).toBe(previous + 1);
      await vi.advanceTimersByTimeAsync(300);
      expect(reads()).toBeGreaterThanOrEqual(previous + 3);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it('does not arm a poll after the last view stops inside changed()', async () => {
    vi.useFakeTimers();
    try {
      const stream = backendStream('engine', 'stop-inside-changed');
      let unsubscribe = () => {};
      unsubscribe = stream.subscribe({
        changed() {
          unsubscribe();
        },
        onError(error) {
          throw error;
        },
      });
      await flush();
      expect(stream.open).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps polling while another view of the same reader is still open', async () => {
    vi.useFakeTimers();
    try {
      const stream = backendStream('engine', 'one-view-remains');
      let unsubscribe = () => {};
      unsubscribe = stream.subscribe({
        changed() {
          unsubscribe();
        },
        onError(error) {
          throw error;
        },
      });
      stream.subscribe({
        changed() {},
        onError(error) {
          throw error;
        },
      });
      await flush();
      expect(stream.open).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

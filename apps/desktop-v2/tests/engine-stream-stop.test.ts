import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/platform', () => ({
  native: false,
  request: vi.fn(async () => ({ offset: 4, events: [], hasMore: false, size: 4 })),
}));

import { backendStream } from '../src/engine-stream';

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('BackendStream stop during notification', () => {
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

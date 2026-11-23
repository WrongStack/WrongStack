import { afterEach, describe, expect, it, vi } from 'vitest';

const { heapLimit } = vi.hoisted(() => ({ heapLimit: { bytes: 100 } }));

vi.mock('node:v8', () => ({
  getHeapStatistics: () => ({
    heap_size_limit: heapLimit.bytes,
    malloced_memory: 0,
    peak_malloced_memory: 0,
    number_of_native_contexts: 0,
    number_of_detached_contexts: 0,
  }),
  getHeapSpaceStatistics: () => [],
}));

import { startHeapWatchdog } from '../../src/utils/heap-watchdog.js';

describe('heap watchdog log cadence', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes once per logEveryMs above the warn threshold, plus once per fired threshold', async () => {
    vi.useFakeTimers();
    let heapUsed = 70;
    vi.spyOn(process, 'memoryUsage').mockImplementation(
      () =>
        ({
          rss: 100,
          heapTotal: 80,
          heapUsed,
          external: 0,
          arrayBuffers: 0,
        }) as NodeJS.MemoryUsage,
    );

    const writes: string[] = [];
    const stop = startHeapWatchdog({
      sampleEveryMs: 1_000,
      logEveryMs: 10_000,
      warnAt: 0.6,
      criticalAt: 0.9,
      logPath: 'ignored',
      writeDiagnosticLine: async (_path, line) => {
        writes.push(line);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toHaveLength(1); // immediate first sample

      await vi.advanceTimersByTimeAsync(1_000);
      expect(writes).toHaveLength(1); // still above warn: not a new crossing

      heapUsed = 95;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(writes).toHaveLength(2); // critical crossing forces a line

      heapUsed = 50;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(writes).toHaveLength(2); // below warn: no line

      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).toHaveLength(3); // the periodic line is due
    } finally {
      await stop();
    }
  });
});

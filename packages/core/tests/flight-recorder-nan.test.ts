import { describe, expect, it } from 'vitest';
import type { HeapSample } from '../src/utils/heap-watchdog-types.js';
import { createMemoryFlightRecorder } from '../src/utils/memory-flight-recorder.js';

describe('createMemoryFlightRecorder non-finite sample and windowMs guard', () => {
  it('keeps growth diagnostics finite when windowMs or heapUsed is NaN', async () => {
    let t = 1_000_000;
    const recorder = createMemoryFlightRecorder({
      enabled: false,
      now: () => t,
      windowMs: Number.NaN,
    });

    const mkSample = (heapUsed: number): HeapSample =>
      ({
        ts: new Date(t).toISOString(),
        rss: 200 * 1024 * 1024,
        heapUsed,
        heapTotal: 150 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
        nativeResidual: 0,
        oldSpaceUsed: 0,
        newSpaceUsed: 0,
        largeObjectSpaceUsed: 0,
        codeSpaceUsed: 0,
        mallocedMemory: 0,
        peakMallocedMemory: 0,
        nativeContexts: 1,
        detachedContexts: 0,
        activeResources: 1,
        activeResourceTypes: '',
        heapLimit: 1024 * 1024 * 1024,
        load: 0.1,
      }) as HeapSample;

    recorder.observe(mkSample(100 * 1024 * 1024), {});
    t += 60_000;
    const diag = recorder.observe(mkSample(Number.NaN), {});
    await recorder.stop();

    expect(Number.isFinite(diag.heapGrowthBytesPerHour as number)).toBe(true);
  });
});

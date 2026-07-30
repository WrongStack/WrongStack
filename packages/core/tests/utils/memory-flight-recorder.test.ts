import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HeapSample } from '../../src/utils/heap-watchdog.js';
import {
  createMemoryFlightRecorder,
  type MemoryCaptureEvent,
} from '../../src/utils/memory-flight-recorder.js';

const tempDirs: string[] = [];

function sample(overrides: Partial<HeapSample> = {}): HeapSample {
  const heapUsed = overrides.heapUsed ?? 100 * 1024 * 1024;
  return {
    ts: new Date().toISOString(),
    rss: overrides.rss ?? heapUsed + 200 * 1024 * 1024,
    heapUsed,
    heapTotal: overrides.heapTotal ?? heapUsed + 32 * 1024 * 1024,
    external: overrides.external ?? 8 * 1024 * 1024,
    nativeResidual: overrides.nativeResidual ?? 160 * 1024 * 1024,
    heapLimit: overrides.heapLimit ?? 4 * 1024 * 1024 * 1024,
    load: overrides.load ?? heapUsed / (4 * 1024 * 1024 * 1024),
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('memory flight recorder', () => {
  it('classifies sustained JS growth and captures automatically after warmup', async () => {
    let now = 0;
    const captures: MemoryCaptureEvent[] = [];
    const stop = vi.fn(async () => undefined);
    const recorder = createMemoryFlightRecorder({
      enabled: true,
      now: () => now,
      warmupMs: 1,
      minimumWindowMs: 60_000,
      heapGrowthBytes: 16 * 1024 * 1024,
      heapGrowthBytesPerHour: 64 * 1024 * 1024,
      captureWriter: {
        artifactDir: 'memory-artifacts',
        capture: async (event) => {
          captures.push(event);
        },
        stop,
      },
    });

    recorder.observe(sample(), { surface: 'tui', messages: 10 });
    now = 120_000;
    const diagnosis = recorder.observe(sample({ heapUsed: 180 * 1024 * 1024 }), {
      surface: 'tui',
      messages: 20,
    });
    await recorder.stop();

    expect(diagnosis['memorySignal']).toBe('js-retention');
    expect(diagnosis['memoryCaptureReason']).toBe('heap-growth');
    expect(captures).toHaveLength(1);
    expect(captures[0]?.stats).toMatchObject({ surface: 'tui', messages: 20 });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('writes an allocation profile and evidence event without an inspector port', async () => {
    const diagnosticsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wrongstack-flight-'));
    tempDirs.push(diagnosticsRoot);
    const recorder = createMemoryFlightRecorder({
      enabled: true,
      diagnosticsRoot,
      warmupMs: 0,
      absoluteHeapBytes: 1,
    });

    const diagnosis = recorder.observe(sample(), { surface: 'webui', messages: 3 });
    await recorder.stop();

    const files = await fsp.readdir(recorder.artifactDir);
    expect(diagnosis['memoryCaptureReason']).toBe('absolute-heap');
    expect(files.some((file) => file.endsWith('.heapprofile'))).toBe(true);
    expect(files.some((file) => file.startsWith('event-') && file.endsWith('.json'))).toBe(true);
  });

  it('uses post-major-GC heap for retention growth instead of transient peaks', async () => {
    let now = 0;
    const capture = vi.fn(async () => undefined);
    const recorder = createMemoryFlightRecorder({
      enabled: true,
      now: () => now,
      warmupMs: 0,
      minimumWindowMs: 60_000,
      heapGrowthBytes: 16 * 1024 * 1024,
      heapGrowthBytesPerHour: 64 * 1024 * 1024,
      absoluteHeapBytes: 2 * 1024 * 1024 * 1024,
      captureWriter: {
        artifactDir: 'memory-artifacts',
        capture,
        stop: async () => undefined,
      },
    });

    recorder.observe(sample({ heapUsed: 500 * 1024 * 1024 }), {
      postMajorGcHeapUsed: 100 * 1024 * 1024,
      lastMajorGcAgoMs: 0,
    });
    now = 120_000;
    const diagnosis = recorder.observe(sample({ heapUsed: 700 * 1024 * 1024 }), {
      postMajorGcHeapUsed: 110 * 1024 * 1024,
      lastMajorGcAgoMs: 0,
    });
    await recorder.stop();

    expect(diagnosis['retainedHeapUsed']).toBe(110 * 1024 * 1024);
    expect(diagnosis['transientHeapBytes']).toBe(590 * 1024 * 1024);
    expect(diagnosis['memorySignal']).toBe('stable');
    expect(capture).not.toHaveBeenCalled();
  });
});

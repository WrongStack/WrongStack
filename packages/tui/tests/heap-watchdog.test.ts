import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startHeapWatchdog,
  startSharedHeapWatchdog,
  takeHeapSample,
} from '../src/heap-watchdog.js';

describe('takeHeapSample', () => {
  it('returns a coherent sample with a positive heap limit', () => {
    const s = takeHeapSample();
    expect(s.heapUsed).toBeGreaterThan(0);
    expect(s.heapLimit).toBeGreaterThan(s.heapUsed);
    expect(s.load).toBeGreaterThan(0);
    expect(s.load).toBeLessThan(1);
    expect(s.arrayBuffers ?? -1).toBeGreaterThanOrEqual(0);
    expect(s.nativeResidual ?? -1).toBeGreaterThanOrEqual(0);
    expect(s.oldSpaceUsed ?? -1).toBeGreaterThanOrEqual(0);
    expect(s.activeResources ?? -1).toBeGreaterThanOrEqual(0);
    expect(() => new Date(s.ts).toISOString()).not.toThrow();
  });
});

describe('startHeapWatchdog', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'heap-watchdog-'));
    logPath = path.join(dir, 'heap.jsonl');
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // The watchdog's append chain may still have an in-flight write —
    // let it settle, then rm with retries (Windows ENOTEMPTY race).
    await new Promise((r) => setTimeout(r, 50));
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('writes an immediate first diagnostic line including collectStats extras', async () => {
    const stop = startHeapWatchdog({
      logPath,
      sampleEveryMs: 60_000,
      collectStats: () => ({ historyEntries: 7 }),
    });
    await stop();
    let raw = '';
    for (let i = 0; i < 50; i++) {
      try {
        raw = await fsp.readFile(logPath, 'utf8');
        if (raw) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    const line = JSON.parse(raw.trim().split('\n')[0]!) as Record<string, unknown>;
    expect(line['pid']).toBe(process.pid);
    expect(line['heapUsed']).toBeGreaterThan(0);
    expect(line['historyEntries']).toBe(7);
    expect(line['memorySignal']).toBe('stable');
    expect(line['memoryArtifactDir']).toEqual(expect.any(String));
    expect(line['gcMajorCount']).toBe(0);
    expect(line['retainedHeapUsed']).toBe(line['heapUsed']);
  });

  it('fires warn then critical once per crossing', () => {
    vi.useFakeTimers();
    const calls: Array<{ level: string }> = [];
    // warnAt/criticalAt = 0 → every sample is above both thresholds; the
    // armed flags must still make each fire exactly once.
    const stop = startHeapWatchdog({
      logPath,
      sampleEveryMs: 1_000,
      warnAt: 0,
      criticalAt: 0,
      onWarn: (level) => calls.push({ level }),
    });
    vi.advanceTimersByTime(5_000);
    stop();
    expect(calls).toEqual([{ level: 'critical' }]);
  });

  it('fires warn (not critical) between the two thresholds', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const stop = startHeapWatchdog({
      logPath,
      sampleEveryMs: 1_000,
      warnAt: 0, // always above warn
      criticalAt: 1.01, // never above critical
      onWarn: (level) => calls.push(level),
    });
    vi.advanceTimersByTime(5_000);
    stop();
    expect(calls).toEqual(['warn']);
  });

  it('a throwing collectStats does not break sampling', () => {
    vi.useFakeTimers();
    const stop = startHeapWatchdog({
      logPath,
      sampleEveryMs: 1_000,
      collectStats: () => {
        throw new Error('boom');
      },
    });
    expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
    stop();
  });

  it('coalesces overdue samples while a diagnostic write is blocked', async () => {
    vi.useFakeTimers();
    let releaseFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const writtenLines: string[] = [];
    const writeDiagnosticLine = vi.fn(async (_targetPath: string, line: string) => {
      writtenLines.push(line);
      if (writtenLines.length === 1) await firstWrite;
    });
    let sample = 0;

    const stop = startHeapWatchdog({
      logPath,
      sampleEveryMs: 1_000,
      logEveryMs: 0,
      collectStats: () => ({ sample: ++sample }),
      writeDiagnosticLine,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sample).toBe(11);
    expect(writeDiagnosticLine).toHaveBeenCalledTimes(1);

    releaseFirstWrite?.();
    await vi.waitFor(() => expect(writeDiagnosticLine).toHaveBeenCalledTimes(2));
    await stop();

    expect(JSON.parse(writtenLines[1] ?? '{}') as Record<string, unknown>).toMatchObject({
      sample: 11,
    });
  });

  it('flushes a coalesced pending sample when stopped during a blocked write', async () => {
    vi.useFakeTimers();
    let releaseFirstWrite: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const writeDiagnosticLine = vi.fn(async () => {
      await blocked;
    });

    const stop = startHeapWatchdog({
      logPath,
      sampleEveryMs: 1_000,
      logEveryMs: 0,
      writeDiagnosticLine,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeDiagnosticLine).toHaveBeenCalledTimes(1);

    const stopped = stop();
    releaseFirstWrite?.();
    await stopped;

    expect(writeDiagnosticLine).toHaveBeenCalledTimes(2);
  });

  it('shares one sampler while merging surface contributors', async () => {
    vi.useFakeTimers();
    const writtenLines: string[] = [];
    const writeDiagnosticLine = vi.fn(async (_targetPath: string, line: string) => {
      writtenLines.push(line);
    });
    const stopCli = startSharedHeapWatchdog({
      logPath,
      sampleEveryMs: 1_000,
      logEveryMs: 0,
      writeDiagnosticLine,
      collectStats: () => ({ surface: 'cli', cliSamples: 1 }),
    });
    const stopTui = startSharedHeapWatchdog({
      collectStats: () => ({ surface: 'tui', historyEntries: 7 }),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(writtenLines.length).toBeGreaterThanOrEqual(2));
    expect(JSON.parse(writtenLines.at(-1) ?? '{}')).toMatchObject({
      surface: 'tui',
      cliSamples: 1,
      historyEntries: 7,
    });

    await stopCli();
    const before = writtenLines.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(writtenLines.length).toBeGreaterThan(before));
    expect(JSON.parse(writtenLines.at(-1) ?? '{}')).toMatchObject({
      surface: 'tui',
      historyEntries: 7,
    });

    await stopTui();
    const stoppedAt = writtenLines.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writtenLines).toHaveLength(stoppedAt);
  });

  it('does not start an implicit production recorder in test processes', async () => {
    vi.useFakeTimers();
    const collectStats = vi.fn(() => ({ surface: 'test' }));
    const stop = startSharedHeapWatchdog({ collectStats });

    await vi.advanceTimersByTimeAsync(120_000);
    await stop();

    expect(collectStats).not.toHaveBeenCalled();
  });
});

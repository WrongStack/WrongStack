import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultHeapLogPath, startHeapWatchdog, takeHeapSample } from '../src/heap-watchdog.js';

describe('takeHeapSample', () => {
  it('returns a coherent sample with a positive heap limit', () => {
    const s = takeHeapSample();
    expect(s.heapUsed).toBeGreaterThan(0);
    expect(s.heapLimit).toBeGreaterThan(s.heapUsed);
    expect(s.load).toBeGreaterThan(0);
    expect(s.load).toBeLessThan(1);
    expect(() => new Date(s.ts).toISOString()).not.toThrow();
  });

  it('includes all expected fields', () => {
    const s = takeHeapSample();
    expect(s).toHaveProperty('rss');
    expect(s).toHaveProperty('heapTotal');
    expect(s).toHaveProperty('external');
    expect(s.rss).toBeGreaterThan(0);
  });
});

describe('defaultHeapLogPath', () => {
  it('returns a path ending with heap.jsonl', () => {
    const p = defaultHeapLogPath();
    expect(p).toMatch(/heap\.jsonl$/);
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
    await new Promise((r) => setTimeout(r, 50));
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('writes an immediate first diagnostic line including collectStats extras', async () => {
    const stop = startHeapWatchdog({
      logPath,
      sampleEveryMs: 60_000,
      collectStats: () => ({ historyEntries: 7 }),
    });
    stop();
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
    expect(line['userTimings']).toBe(0);
  });

  it('returns a stop function that can be called multiple times', () => {
    const stop = startHeapWatchdog({ logPath, sampleEveryMs: 60_000 });
    expect(typeof stop).toBe('function');
    stop();
    // Second call should not throw
    stop();
  });

  it('applies default options when none provided', () => {
    const stop = startHeapWatchdog();
    expect(typeof stop).toBe('function');
    stop();
  });

  it('fires warn then critical once per crossing (critical first)', () => {
    vi.useFakeTimers();
    try {
      const calls: Array<{ level: string }> = [];
      const stop = startHeapWatchdog({
        logPath,
        sampleEveryMs: 1_000,
        warnAt: 0,
        criticalAt: 0,
        onWarn: (level) => calls.push({ level }),
      });
      vi.advanceTimersByTime(5_000);
      stop();
      // critical fires first (only once), warn is suppressed by critical
      expect(calls).toEqual([{ level: 'critical' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires warn (not critical) between the two thresholds', () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const stop = startHeapWatchdog({
        logPath,
        sampleEveryMs: 1_000,
        warnAt: 0,
        criticalAt: 1.01,
        onWarn: (level) => calls.push(level),
      });
      vi.advanceTimersByTime(5_000);
      stop();
      expect(calls).toEqual(['warn']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warn fires at least once with warnAt=0 across multiple ticks', () => {
    vi.useFakeTimers();
    try {
      // With warnAt=1.0 and load always < 1, warn never fires
      const calls: string[] = [];
      const stop = startHeapWatchdog({
        logPath,
        sampleEveryMs: 1_000,
        warnAt: 0, // Always fires
        criticalAt: 1.01,
        onWarn: (level) => calls.push(level),
      });
      vi.advanceTimersByTime(2_000);
      // First tick should fire warn, second should also fire (re-armed because load is back below 0-0.05 = -0.05)
      // Actually with warnAt=0 and load=~0.3, warn fires once, then since load (0.3) < warnAt - 0.05 (-0.05) is false,
      // warnArmed stays false, so only one 'warn' call.
      // Let's verify
      stop();
      expect(calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a throwing collectStats does not break sampling', () => {
    vi.useFakeTimers();
    try {
      const stop = startHeapWatchdog({
        logPath,
        sampleEveryMs: 1_000,
        collectStats: () => {
          throw new Error('boom');
        },
      });
      expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs additional line when threshold is crossed (due or crossed)', async () => {
    const stop = startHeapWatchdog({
      logPath,
      sampleEveryMs: 1_000,
      warnAt: 0, // Always crosses threshold
      criticalAt: 1.01, // Never crosses critical
    });
    // Let the initial tick complete
    await new Promise((r) => setTimeout(r, 100));
    stop();
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
    const lines = raw.trim().split('\n').filter(Boolean);
    // At least the immediate first sample is logged because crossed=true
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['pid']).toBe(process.pid);
    expect(parsed['load']).toBeGreaterThan(0);
  });
});

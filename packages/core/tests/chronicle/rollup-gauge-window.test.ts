/**
 * Periodic gauges must aggregate, and must still be collected while live.
 *
 * The rollup flushed on an idle rule: a bucket untouched for `windowMs` was
 * considered finished. That is right for bursts and useless for a gauge whose
 * cadence exceeds the window — `runtime.health` samples every 30 s against a
 * 10 s window, so each bucket went idle between samples and flushed carrying
 * one, writing `{sum,min,max,last,avg}` (one number, five times) per metric.
 * Measured: 12.7 MB and 8.4% of the journal for 5 971 rollups that aggregated
 * nothing.
 *
 * The trap in the obvious fix is why the second test exists: simply lengthening
 * the window makes it *worse*, because the idle rule reads `updatedAt`, which a
 * live gauge keeps pushing forward — the bucket would never flush and would grow
 * without bound. Gauges are flushed by age instead.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChronicleJournal,
  createChronicleContext,
  wireRollupsToChronicle,
} from '../../src/chronicle/index.js';
import { EventBus } from '../../src/kernel/events.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-gauge-'));
  dirs.push(dir);
  const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
  const events = new EventBus();
  const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
  return { journal, events, context };
}

function health(events: EventBus, utilization: number): void {
  events.emit('runtime.health.sampled', {
    sessionId: 's',
    uptimeSeconds: 1,
    eventLoop: {
      utilization,
      activeMs: 1,
      idleMs: 1,
      delayMeanMs: 1,
      delayP95Ms: 2,
      delayMaxMs: 3,
    },
    cpu: { userMicros: 1, systemMicros: 1 },
    memory: {
      rssBytes: 1,
      heapTotalBytes: 1,
      heapUsedBytes: 1,
      externalBytes: 1,
      arrayBuffersBytes: 1,
    },
  } as never);
}

describe('rollup gauge windows', () => {
  it('collects several gauge samples into one aggregate instead of one each', async () => {
    vi.useFakeTimers();
    const { journal, events, context } = await harness();
    const off = wireRollupsToChronicle({
      events,
      journal,
      context,
      windowMs: 10_000,
      gaugeWindowMs: 120_000,
    });

    // The real cadence: one sample every 30 s, i.e. never two inside the burst
    // window that used to decide when a bucket was finished.
    for (const utilization of [0.1, 0.3, 0.5, 0.7]) {
      health(events, utilization);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    // 120 s of gauge window has now elapsed, so the bucket is due.
    await vi.advanceTimersByTimeAsync(10_000);
    off();

    const recorded = await journal.readAll();
    const rollups = recorded.filter(
      (e) => (e.attributes as { signal?: string } | undefined)?.signal === 'runtime.health',
    );
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({
      attributes: {
        samples: 4,
        stats: { 'eventLoop.utilization': { min: 0.1, max: 0.7, last: 0.7 } },
      },
    });
  });

  it('flushes a still-live gauge on age, so the bucket cannot grow unbounded', async () => {
    vi.useFakeTimers();
    const { journal, events, context } = await harness();
    const off = wireRollupsToChronicle({
      events,
      journal,
      context,
      windowMs: 10_000,
      gaugeWindowMs: 60_000,
    });

    // Sampling never stops, so the bucket is never idle. Under the old idle-only
    // rule this produced no flush at all for as long as the session ran.
    for (let i = 0; i < 10; i++) {
      health(events, i / 10);
      await vi.advanceTimersByTimeAsync(20_000);
    }
    const beforeDispose = (await journal.readAll()).filter(
      (e) => (e.attributes as { signal?: string } | undefined)?.signal === 'runtime.health',
    );
    off();

    // Flushed while running — not only at shutdown.
    expect(beforeDispose.length).toBeGreaterThanOrEqual(3);
    for (const rollup of beforeDispose) {
      expect((rollup.attributes as { samples: number }).samples).toBeGreaterThan(1);
    }
  });

  it('leaves burst signals on the idle rule', async () => {
    vi.useFakeTimers();
    const { journal, events, context } = await harness();
    const off = wireRollupsToChronicle({
      events,
      journal,
      context,
      windowMs: 10_000,
      gaugeWindowMs: 120_000,
    });

    for (const bytes of [10, 30, 20]) {
      events.emit('process.output', {
        sessionId: 's',
        toolCallId: 'tc',
        toolName: 'bash',
        parentPid: 1,
        stream: 'stdout',
        bytes,
        chunkHash: String(bytes),
        at: new Date().toISOString(),
      } as never);
    }
    // Idle past the burst window: the aggregate lands without waiting out the
    // much longer gauge window.
    await vi.advanceTimersByTimeAsync(21_000);
    const recorded = await journal.readAll();
    off();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      attributes: { signal: 'process.output', samples: 3, stats: { bytes: { sum: 60 } } },
    });
  });
});

/**
 * Host health on the heartbeat: the real sample passes the server's payload
 * guard, malformed samples are refused, and the sampler keeps the heartbeat
 * synchronous by handing out the previous finished sample.
 */
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { collectHqHostHealth, HqHostHealthSampler } from '../src/host-health.js';
import { hqHostHealthProblems, hqHostHealthThresholds } from '../src/host-health-verdict.js';
import { HqHostHealthWatch } from '../src/notify-watchers.js';
import type { HqHostHealth } from '../src/protocol.js';
import { parseHqEventPayload } from '../src/protocol.js';

const SAMPLE: HqHostHealth = {
  platform: 'linux',
  arch: 'x64',
  cpuCount: 8,
  loadAvg1: 0.5,
  memTotalBytes: 16e9,
  memAvailableBytes: 8e9,
  osUptimeSec: 3600,
  diskTotalBytes: 500e9,
  diskFreeBytes: 100e9,
  processRssBytes: 2e8,
};

const beat = (host: unknown) =>
  parseHqEventPayload('client.heartbeat', { uptimeMs: 1, status: 'idle', host });

describe('collectHqHostHealth', () => {
  it('samples this machine in a shape the server accepts', async () => {
    const health = await collectHqHostHealth(os.tmpdir());
    expect(health.platform).toBe(process.platform);
    expect(health.cpuCount).toBeGreaterThan(0);
    expect(health.memTotalBytes).toBeGreaterThan(0);
    expect(health.memAvailableBytes).toBeLessThanOrEqual(health.memTotalBytes);
    expect(health.processRssBytes).toBeGreaterThan(0);
    if (health.diskTotalBytes !== undefined) {
      expect(health.diskFreeBytes).toBeLessThanOrEqual(health.diskTotalBytes);
    }
    if (process.platform === 'win32') expect(health.loadAvg1).toBeUndefined();
    expect(beat(health).ok).toBe(true);
  });

  it('leaves the disk out when the project volume cannot be read', async () => {
    const health = await collectHqHostHealth(`${os.tmpdir()}/does-not-exist-${Date.now()}`);
    expect(health.diskTotalBytes).toBeUndefined();
    expect(beat(health).ok).toBe(true);
  });
});

describe('host health payload guard', () => {
  it('accepts a heartbeat without host health (older clients)', () => {
    expect(parseHqEventPayload('client.heartbeat', { uptimeMs: 1, status: 'idle' }).ok).toBe(true);
  });

  it.each([
    ['a negative figure', { ...SAMPLE, memTotalBytes: -1 }],
    ['a non-finite figure', { ...SAMPLE, loadAvg1: Number.POSITIVE_INFINITY }],
    ['a string figure', { ...SAMPLE, cpuCount: '8' }],
    ['a missing figure', { ...SAMPLE, osUptimeSec: undefined }],
    ['a label carrying a path', { ...SAMPLE, platform: '/home/me' }],
    ['an over-long label', { ...SAMPLE, arch: 'x'.repeat(33) }],
    ['an array', [SAMPLE]],
  ])('refuses %s', (_name, host) => {
    expect(beat(host).ok).toBe(false);
  });
});

describe('HqHostHealthSampler', () => {
  it('returns the previous finished sample and runs one sample at a time', async () => {
    let calls = 0;
    let release: (value: HqHostHealth) => void = () => undefined;
    const sampler = new HqHostHealthSampler('/', () => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    expect(sampler.next()).toBeUndefined();
    expect(sampler.next()).toBeUndefined();
    expect(calls).toBe(1);
    release(SAMPLE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sampler.next()).toEqual(SAMPLE);
    expect(calls).toBe(2);
  });

  it('keeps the last good sample when a sample fails', async () => {
    let fail = false;
    const sampler = new HqHostHealthSampler('/', async () => {
      if (fail) throw new Error('statfs failed');
      return SAMPLE;
    });
    sampler.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fail = true;
    expect(sampler.next()).toEqual(SAMPLE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sampler.next()).toEqual(SAMPLE);
  });

  it('sends nothing when disabled', () => {
    const sampler = new HqHostHealthSampler('/', false);
    expect(sampler.next()).toBeUndefined();
  });
});

describe('hqHostHealthProblems', () => {
  const at = '2026-11-02T12:00:00.000Z';
  const now = Date.parse(at) + 30_000;
  it('flags a low project disk and short memory on a fresh sample only', () => {
    expect(hqHostHealthProblems({ ...SAMPLE, reportedAt: at }, now)).toEqual([]);
    expect(
      hqHostHealthProblems(
        { ...SAMPLE, diskFreeBytes: 1e9, memAvailableBytes: 1e8, reportedAt: at },
        now,
      ),
    ).toEqual(['disk', 'memory']);
    expect(
      hqHostHealthProblems({ ...SAMPLE, diskFreeBytes: 1e9, reportedAt: at }, now + 6 * 60_000),
    ).toEqual([]);
    expect(hqHostHealthProblems(undefined, now)).toEqual([]);
  });

  it('follows the operator thresholds, and 0 turns a check off', () => {
    // 20 GB free of 500 GB = 4%: low by default (under 5%).
    const sample = { ...SAMPLE, diskFreeBytes: 20e9, memAvailableBytes: 1.2e9, reportedAt: at };
    expect(hqHostHealthProblems(sample, now)).toEqual(['disk']);
    const relaxed = hqHostHealthThresholds({ hostDiskFreePct: 3, hostDiskFreeGiB: 0 });
    expect(relaxed).toEqual({ diskFreePct: 3, diskFreeGiB: 0, memAvailablePct: 5 });
    expect(hqHostHealthProblems(sample, now, relaxed)).toEqual([]);
    const strict = hqHostHealthThresholds({ hostDiskFreeGiB: 50, hostMemAvailablePct: 10 });
    expect(hqHostHealthProblems(sample, now, strict)).toEqual(['disk', 'memory']);
    const off = hqHostHealthThresholds({
      hostDiskFreePct: 0,
      hostDiskFreeGiB: 0,
      hostMemAvailablePct: 0,
    });
    expect(
      hqHostHealthProblems({ ...sample, diskFreeBytes: 0, memAvailableBytes: 0 }, now, off),
    ).toEqual([]);
  });
});

describe('HqHostHealthWatch', () => {
  const at = '2026-11-02T12:00:00.000Z';
  const now = Date.parse(at);
  const low = { ...SAMPLE, diskFreeBytes: 1e9, reportedAt: at };
  const ok = { ...SAMPLE, reportedAt: at };

  it('announces a low disk once per episode and again after recovery', () => {
    const watch = new HqHostHealthWatch();
    const lab = { key: 'host:lab-02', label: 'LAB-02' };
    const first = watch.observe([{ ...lab, health: low, problems: ['disk'] }], now);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: 'machine',
      severity: 'warn',
      title: 'LAB-02 is low on disk space',
      path: '/fleet/machines/?machine=host%3Alab-02',
    });
    expect(first[0]?.body).toContain('free of');
    // Still low: no repeat.
    expect(watch.observe([{ ...lab, health: low, problems: ['disk'] }], now + 1_000)).toEqual([]);
    // Recovers, then runs low again: a new episode.
    expect(watch.observe([{ ...lab, health: ok, problems: undefined }], now + 2_000)).toEqual([]);
    const again = watch.observe([{ ...lab, health: low, problems: ['disk'] }], now + 3_000);
    expect(again).toHaveLength(1);
    expect(again[0]?.dedupeKey).not.toBe(first[0]?.dedupeKey);
  });

  it('announces only what the server judged, not its own reading of the numbers', () => {
    const watch = new HqHostHealthWatch();
    // Numbers that look low, but the operator's thresholds say they are fine.
    expect(
      watch.observe([{ key: 'host:a', label: 'A', health: low, problems: undefined }], now),
    ).toEqual([]);
  });

  it('ignores machines without a reading', () => {
    const watch = new HqHostHealthWatch();
    expect(
      watch.observe([{ key: 'host:x', label: 'X', health: undefined, problems: ['disk'] }], now),
    ).toEqual([]);
  });
});

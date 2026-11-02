/**
 * Machine health over time: one point per machine at most every 15 minutes,
 * only from a newer sample, kept 7 days, persisted and reloaded, junk lines
 * on disk ignored.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HqHealthHistory } from '../src/persistence/health-history.js';
import type { HqHostHealth, HqSnapshot } from '../src/protocol.js';

const T0 = Date.parse('2026-11-02T00:00:00.000Z');
const MIN = 60_000;
/** The documented 7-day retention. */
const HQ_HEALTH_RETENTION_MS = 7 * 24 * 60 * MIN;
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-health-history-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

const host = (over: Partial<HqHostHealth> = {}): HqHostHealth => ({
  platform: 'linux',
  arch: 'x64',
  cpuCount: 8,
  loadAvg1: 1,
  memTotalBytes: 16e9,
  memAvailableBytes: 4e9,
  osUptimeSec: 100,
  diskTotalBytes: 500e9,
  diskFreeBytes: 100e9,
  processRssBytes: 1e8,
  ...over,
});

function snapshotAt(at: number, machines: Array<{ hostname: string; health?: HqHostHealth }>) {
  return {
    machines: machines.map((machine) => ({
      machineId: `id-${machine.hostname}`,
      hostname: machine.hostname,
      clientCount: 1,
      sessionCount: 0,
      agentCount: 0,
      projectIds: [],
      lastActivityAt: new Date(at).toISOString(),
      ...(machine.health
        ? { health: { ...machine.health, reportedAt: new Date(at).toISOString() } }
        : {}),
    })),
  } as unknown as HqSnapshot;
}

describe('HqHealthHistory', () => {
  it('keeps one point per machine at most every 15 minutes', () => {
    const history = new HqHealthHistory({ dataDir });
    for (let minute = 0; minute <= 60; minute += 5) {
      const at = T0 + minute * MIN;
      history.observe(snapshotAt(at, [{ hostname: 'LAB-02', health: host() }]), at);
    }
    const points = history.points('host:lab-02', 0);
    expect(points.map((point) => (Date.parse(point.at) - T0) / MIN)).toEqual([0, 15, 30, 45, 60]);
    expect(points[0]).toEqual({
      key: 'host:lab-02',
      at: new Date(T0).toISOString(),
      memUsedPct: 75,
      diskFreeBytes: 100e9,
      diskTotalBytes: 500e9,
      load1: 1,
      cpuCount: 8,
    });
  });

  it('ignores machines without a reading and the same sample seen twice', () => {
    const history = new HqHealthHistory({ dataDir });
    const snap = snapshotAt(T0, [{ hostname: 'A', health: host() }, { hostname: 'B' }]);
    history.observe(snap, T0);
    history.observe(snap, T0 + 30 * MIN);
    expect(history.points('host:a', 0)).toHaveLength(1);
    expect(history.points('host:b', 0)).toEqual([]);
  });

  it('drops points older than 7 days and filters by window', () => {
    const history = new HqHealthHistory({ dataDir });
    history.observe(snapshotAt(T0, [{ hostname: 'A', health: host() }]), T0);
    const later = T0 + HQ_HEALTH_RETENTION_MS + 20 * MIN;
    history.observe(snapshotAt(later, [{ hostname: 'A', health: host() }]), later);
    expect(history.points('host:a', 0).map((point) => point.at)).toEqual([
      new Date(later).toISOString(),
    ]);
    expect(history.points('host:a', later + MIN)).toEqual([]);
  });

  it('persists, reloads, skips junk lines and forgets a machine', async () => {
    const first = new HqHealthHistory({ dataDir });
    first.observe(snapshotAt(T0, [{ hostname: 'A', health: host() }]), T0);
    await first.drain();
    await fs.appendFile(
      path.join(dataDir, 'health-history.jsonl'),
      '{"key":"host:x","at":"nope","memUsedPct":1,"cpuCount":1}\nnot json\n',
    );
    const second = new HqHealthHistory({ dataDir });
    await second.load(T0 + MIN);
    expect(second.points('host:a', 0)).toHaveLength(1);
    expect(second.points('host:x', 0)).toEqual([]);
    second.forget('host:a');
    expect(second.points('host:a', 0)).toEqual([]);
  });
});

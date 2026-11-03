/**
 * Machine health over time — memory, the project disk and CPU load, so an
 * operator can see "the disk on LAB-02 has been filling for three days"
 * rather than only today's reading.
 *
 * Each snapshot folds in the newest host-health sample of every live machine;
 * one point per machine is kept at most every {@link HQ_HEALTH_POINT_EVERY_MS},
 * and only from a sample newer than the last point. Points live for
 * {@link HQ_HEALTH_RETENTION_MS} in memory and in `<dataDir>/health-history.jsonl`
 * (rotated). Numbers only, as the clients sent them.
 *
 * @module hq/persistence/health-history
 */
import type { HqSnapshot } from '../protocol.js';
import { hqMachineKey } from './machine-roster.js';
import { HqSimpleLog } from './simple-log.js';

/** One reading of one machine. */
export interface HqHealthPoint {
  /** Hostname-first machine key. */
  key: string;
  /** When the client took the sample (ISO). */
  at: string;
  /** Memory in use, 0–100. */
  memUsedPct: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  load1?: number;
  cpuCount: number;
}

const HQ_HEALTH_POINT_EVERY_MS = 15 * 60_000;
const HQ_HEALTH_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** 7 days at one point per 15 minutes, per machine. */
const MAX_POINTS_PER_MACHINE = 7 * 24 * 4;
const MAX_MACHINES = 500;

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function isPoint(value: unknown): value is HqHealthPoint {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.key === 'string' &&
    point.key.length <= 300 &&
    typeof point.at === 'string' &&
    Number.isFinite(Date.parse(point.at)) &&
    finite(point.memUsedPct) &&
    finite(point.cpuCount) &&
    (point.diskFreeBytes === undefined || finite(point.diskFreeBytes)) &&
    (point.diskTotalBytes === undefined || finite(point.diskTotalBytes)) &&
    (point.load1 === undefined || finite(point.load1))
  );
}

export class HqHealthHistory {
  private readonly log: HqSimpleLog<HqHealthPoint>;
  /** key → points, oldest first. */
  private readonly series = new Map<string, HqHealthPoint[]>();

  constructor(opts: { dataDir: string }) {
    this.log = new HqSimpleLog<HqHealthPoint>({
      dataDir: opts.dataDir,
      filename: 'health-history.jsonl',
      maxLines: 120_000,
      rotateKeep: 60_000,
      readLimit: 120_000,
    });
  }

  /** Seed memory from disk; points recorded meanwhile stay after them. */
  async load(now: number = Date.now()): Promise<void> {
    const prior = (await this.log.readAll().catch(() => [])).filter(isPoint);
    const live = this.series;
    const seeded = new Map<string, HqHealthPoint[]>();
    for (const point of prior) {
      const list = seeded.get(point.key) ?? [];
      list.push(point);
      seeded.set(point.key, list);
    }
    for (const [key, points] of live) seeded.set(key, [...(seeded.get(key) ?? []), ...points]);
    this.series.clear();
    for (const [key, points] of seeded) {
      if (this.series.size >= MAX_MACHINES) break;
      this.series.set(key, points);
    }
    this.prune(now);
  }

  /** Fold a snapshot in: one new point per machine when its sample is due. */
  observe(snapshot: HqSnapshot, now: number = Date.now()): void {
    for (const machine of snapshot.machines ?? []) {
      const health = machine.health;
      if (health === undefined) continue;
      const at = Date.parse(health.reportedAt);
      if (!Number.isFinite(at) || at > now + 60_000) continue;
      const key = hqMachineKey(machine.hostname, machine.machineId);
      const list = this.series.get(key);
      const last = list?.[list.length - 1];
      if (last !== undefined && at - Date.parse(last.at) < HQ_HEALTH_POINT_EVERY_MS) continue;
      if (list === undefined && this.series.size >= MAX_MACHINES) continue;
      const point: HqHealthPoint = {
        key,
        at: health.reportedAt,
        memUsedPct:
          health.memTotalBytes > 0
            ? Math.round(
                (1000 * Math.max(0, health.memTotalBytes - health.memAvailableBytes)) /
                  health.memTotalBytes,
              ) / 10
            : 0,
        ...(health.diskFreeBytes !== undefined ? { diskFreeBytes: health.diskFreeBytes } : {}),
        ...(health.diskTotalBytes !== undefined ? { diskTotalBytes: health.diskTotalBytes } : {}),
        ...(health.loadAvg1 !== undefined ? { load1: health.loadAvg1 } : {}),
        cpuCount: health.cpuCount,
      };
      if (list === undefined) this.series.set(key, [point]);
      else list.push(point);
      this.log.append(point);
    }
    this.prune(now);
  }

  /** One machine's points since `sinceMs`, oldest first. */
  points(key: string, sinceMs: number): HqHealthPoint[] {
    return (this.series.get(key) ?? []).filter((point) => Date.parse(point.at) >= sinceMs);
  }

  /**
   * Every machine's points since `sinceMs`, thinned so two kept points are at
   * least `everyMs` apart (the newest is always kept): enough to draw and
   * project a trend for the whole fleet in one answer, at a fixed size per
   * machine however often readings were taken.
   */
  overview(sinceMs: number, everyMs: number): { key: string; points: HqHealthPoint[] }[] {
    const machines: { key: string; points: HqHealthPoint[] }[] = [];
    for (const [key, list] of this.series) {
      const recent = list.filter((point) => Date.parse(point.at) >= sinceMs);
      if (recent.length === 0) continue;
      const kept: HqHealthPoint[] = [];
      let lastAt = Number.NEGATIVE_INFINITY;
      for (const [index, point] of recent.entries()) {
        const at = Date.parse(point.at);
        if (at - lastAt >= everyMs || index === recent.length - 1) {
          kept.push(point);
          lastAt = at;
        }
      }
      machines.push({ key, points: kept });
    }
    return machines;
  }

  /** Forget a machine (it was forgotten from the roster). */
  forget(key: string): void {
    this.series.delete(key);
  }

  async drain(): Promise<void> {
    await this.log.drain();
  }

  private prune(now: number): void {
    const cutoff = now - HQ_HEALTH_RETENTION_MS;
    for (const [key, points] of this.series) {
      let drop = 0;
      while (drop < points.length && Date.parse(points[drop]!.at) < cutoff) drop++;
      if (points.length - drop > MAX_POINTS_PER_MACHINE)
        drop = points.length - MAX_POINTS_PER_MACHINE;
      if (drop > 0) points.splice(0, drop);
      if (points.length === 0) this.series.delete(key);
    }
  }
}

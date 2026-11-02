/**
 * What a machine's health readings over time say, in words: how the project
 * disk and memory moved, and — when the disk is filling — roughly when it runs
 * out at the current rate.
 */
import type { HqHealthPoint } from '@wrongstack/hq';
import { formatBytes } from './health';

const DAY_MS = 24 * 60 * 60_000;
/** Only project a fill date from at least this much history. */
const MIN_SPAN_MS = 6 * 60 * 60_000;
/** Beyond this the projection is noise, not a warning. */
const MAX_PROJECTION_DAYS = 60;

export interface SeriesPoint {
  at: number;
  value: number;
}

export interface HealthTrend {
  disk: SeriesPoint[];
  memory: SeriesPoint[];
  /** "Free space went from 40 GB to 12 GB over 6 days." */
  diskSummary: string | undefined;
  memorySummary: string | undefined;
  /** Days until the disk is full at the current rate, when it is filling. */
  diskFullInDays: number | undefined;
}

function span(ms: number): string {
  const hours = Math.round(ms / (60 * 60_000));
  if (hours < 48) return `${Math.max(1, hours)} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(ms / DAY_MS);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Least-squares slope (value per ms) — steadier than first-vs-last when a
 * cleanup or a build briefly moved the disk.
 */
function slope(points: readonly SeriesPoint[]): number {
  const n = points.length;
  const meanX = points.reduce((sum, p) => sum + p.at, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.value, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.at - meanX) * (p.value - meanY);
    den += (p.at - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

export function healthTrend(points: readonly HqHealthPoint[]): HealthTrend {
  const sorted = [...points]
    .map((point) => ({ point, at: Date.parse(point.at) }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at);
  const disk = sorted
    .filter((entry) => entry.point.diskFreeBytes !== undefined)
    .map((entry) => ({ at: entry.at, value: entry.point.diskFreeBytes as number }));
  const memory = sorted.map((entry) => ({ at: entry.at, value: entry.point.memUsedPct }));

  let diskSummary: string | undefined;
  let diskFullInDays: number | undefined;
  if (disk.length >= 2) {
    const first = disk[0]!;
    const last = disk[disk.length - 1]!;
    const elapsed = last.at - first.at;
    diskSummary = `Free space went from ${formatBytes(first.value)} to ${formatBytes(last.value)} over ${span(elapsed)}.`;
    if (elapsed >= MIN_SPAN_MS) {
      const perMs = slope(disk);
      if (perMs < 0) {
        const days = last.value / -perMs / DAY_MS;
        if (days <= MAX_PROJECTION_DAYS) diskFullInDays = Math.max(0, Math.round(days * 10) / 10);
      }
    }
  }

  let memorySummary: string | undefined;
  if (memory.length >= 2) {
    const values = memory.map((p) => p.value);
    const peak = Math.max(...values);
    const average = values.reduce((sum, v) => sum + v, 0) / values.length;
    memorySummary = `Memory in use averaged ${Math.round(average)}% and peaked at ${Math.round(peak)}%.`;
  }

  return { disk, memory, diskSummary, memorySummary, diskFullInDays };
}

/** "in about 3 days", "within a day". */
export function fullInWords(days: number): string {
  if (days < 1) return 'within a day';
  const rounded = Math.round(days);
  return `in about ${rounded} day${rounded === 1 ? '' : 's'}`;
}

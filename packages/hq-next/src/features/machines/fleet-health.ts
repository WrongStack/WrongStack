/**
 * Every machine's health side by side: free space on the project disk now,
 * where it is heading over the last 7 days, and memory pressure. The machine
 * that runs out first leads, so the page answers "which box do I clean up
 * next?" before anything else.
 */
import type { HqHealthPoint } from '@wrongstack/hq';
import { healthProblems } from './health';
import { healthTrend, type SeriesPoint } from './health-trend';
import type { MachineSummary } from './model';

export interface FleetHealthRow {
  key: string;
  hostname: string;
  online: boolean;
  /** The server's verdict on the newest reading, in words. */
  problems: readonly string[];
  diskFreeBytes: number | undefined;
  diskTotalBytes: number | undefined;
  /** Free share of the project disk, 0–100, from the newest reading. */
  diskFreePct: number | undefined;
  /** Days until the disk is full at the 7-day rate, when it is filling. */
  diskFullInDays: number | undefined;
  disk: SeriesPoint[];
  memory: SeriesPoint[];
  memoryAveragePct: number | undefined;
  memoryPeakPct: number | undefined;
  /** Readings in the window; 0 means HQ has no history for it yet. */
  readings: number;
}

export function fleetHealthRows(
  machines: readonly MachineSummary[],
  overview: readonly { key: string; points: readonly HqHealthPoint[] }[],
): FleetHealthRow[] {
  const byKey = new Map(overview.map((entry) => [entry.key, entry.points]));
  const rows = machines.map((machine): FleetHealthRow => {
    const points = byKey.get(machine.key) ?? [];
    const trend = healthTrend(points);
    const newest = points.at(-1);
    const freeBytes = machine.health?.diskFreeBytes ?? newest?.diskFreeBytes;
    const totalBytes = machine.health?.diskTotalBytes ?? newest?.diskTotalBytes;
    const memoryValues = trend.memory.map((point) => point.value);
    return {
      key: machine.key,
      hostname: machine.hostname,
      online: machine.online,
      problems: healthProblems(machine.health, machine.healthProblems).map(
        (problem) => problem.summary,
      ),
      diskFreeBytes: freeBytes,
      diskTotalBytes: totalBytes,
      diskFreePct:
        freeBytes !== undefined && totalBytes !== undefined && totalBytes > 0
          ? Math.round((1000 * freeBytes) / totalBytes) / 10
          : undefined,
      diskFullInDays: trend.diskFullInDays,
      disk: trend.disk,
      memory: trend.memory,
      memoryAveragePct:
        memoryValues.length > 0
          ? Math.round(memoryValues.reduce((sum, value) => sum + value, 0) / memoryValues.length)
          : undefined,
      memoryPeakPct: memoryValues.length > 0 ? Math.round(Math.max(...memoryValues)) : undefined,
      readings: points.length,
    };
  });
  // Soonest full first, then anything flagged, then the least free space,
  // then machines with no reading at all, then by name.
  const rank = (row: FleetHealthRow): number => row.diskFullInDays ?? Number.POSITIVE_INFINITY;
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(b.problems.length > 0) - Number(a.problems.length > 0) ||
      (a.diskFreePct ?? Number.POSITIVE_INFINITY) - (b.diskFreePct ?? Number.POSITIVE_INFINITY) ||
      a.hostname.localeCompare(b.hostname),
  );
}

/** "2 machines fill up within a week", "No disk is filling up." */
export function fleetHealthHeadline(rows: readonly FleetHealthRow[]): string {
  const filling = rows.filter((row) => row.diskFullInDays !== undefined && row.diskFullInDays <= 7);
  if (filling.length > 0)
    return `${filling.length} machine${filling.length === 1 ? '' : 's'} ${
      filling.length === 1 ? 'fills' : 'fill'
    } up within a week`;
  const flagged = rows.filter((row) => row.problems.length > 0).length;
  if (flagged > 0)
    return `${flagged} machine${flagged === 1 ? ' is' : 's are'} low on disk or memory`;
  return 'No disk is filling up';
}

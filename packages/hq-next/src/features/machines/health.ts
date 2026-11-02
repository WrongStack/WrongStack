/**
 * Machine health in words: what the newest host-health sample a client sent
 * says about memory, the disk that holds the project, CPU load and uptime.
 * Whether any of it needs a person is the SERVER's verdict, judged against the
 * operator's thresholds; this file only puts it into words.
 */
import type { HqHostHealth } from '@wrongstack/hq';

export type MachineHealth = HqHostHealth & { reportedAt: string };

/** A reading older than this is shown as "not current". */
const HEALTH_FRESH_MS = 5 * 60_000;

/** The server's verdict on a machine's health (`HqMachineRecord.healthProblems`). */
export type HealthVerdict = readonly ('disk' | 'memory')[] | undefined;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1))} ${units[unit]}`;
}

export function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const PLATFORM: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
  freebsd: 'FreeBSD',
};

export function platformLabel(health: HqHostHealth): string {
  return `${PLATFORM[health.platform] ?? health.platform} · ${health.arch}`;
}

export interface HealthProblem {
  kind: 'disk' | 'memory';
  /** "low on disk space (1.4 GB free)". */
  summary: string;
}

/** Is the sample recent enough to act on? */
export function isFresh(health: MachineHealth, now: number): boolean {
  const at = Date.parse(health.reportedAt);
  return Number.isFinite(at) && now - at <= HEALTH_FRESH_MS;
}

/**
 * The server's verdict, in words. The server judges against the operator's
 * thresholds (and only fresh samples), so this never second-guesses it.
 */
export function healthProblems(
  health: MachineHealth | undefined,
  verdict: HealthVerdict,
): HealthProblem[] {
  if (health === undefined || verdict === undefined) return [];
  const problems: HealthProblem[] = [];
  const { diskTotalBytes: total, diskFreeBytes: free } = health;
  if (verdict.includes('disk') && total !== undefined && free !== undefined) {
    problems.push({
      kind: 'disk',
      summary: `low on disk space (${formatBytes(free)} free of ${formatBytes(total)})`,
    });
  }
  if (verdict.includes('memory')) {
    problems.push({
      kind: 'memory',
      summary: `short of memory (${formatBytes(health.memAvailableBytes)} available of ${formatBytes(health.memTotalBytes)})`,
    });
  }
  return problems;
}

export interface HealthFact {
  label: string;
  value: string;
  /** Share used, 0–1, for a meter. */
  used?: number;
  warn?: boolean;
}

export function healthFacts(health: MachineHealth, verdict: HealthVerdict): HealthFact[] {
  const problems = new Set(verdict ?? []);
  const memUsed = health.memTotalBytes - health.memAvailableBytes;
  const facts: HealthFact[] = [
    {
      label: 'Memory in use',
      value: `${formatBytes(Math.max(0, memUsed))} of ${formatBytes(health.memTotalBytes)}`,
      used: health.memTotalBytes > 0 ? Math.min(1, Math.max(0, memUsed / health.memTotalBytes)) : 0,
      warn: problems.has('memory'),
    },
  ];
  if (health.diskTotalBytes !== undefined && health.diskFreeBytes !== undefined) {
    const used = health.diskTotalBytes - health.diskFreeBytes;
    facts.push({
      label: 'Project disk',
      value: `${formatBytes(health.diskFreeBytes)} free of ${formatBytes(health.diskTotalBytes)}`,
      used: health.diskTotalBytes > 0 ? Math.min(1, Math.max(0, used / health.diskTotalBytes)) : 0,
      warn: problems.has('disk'),
    });
  }
  facts.push({
    label: 'CPU',
    value:
      health.loadAvg1 === undefined
        ? `${health.cpuCount} cores`
        : `load ${health.loadAvg1.toFixed(2)} on ${health.cpuCount} cores`,
    ...(health.loadAvg1 !== undefined
      ? { used: Math.min(1, health.loadAvg1 / Math.max(1, health.cpuCount)) }
      : {}),
  });
  facts.push({ label: 'Up for', value: formatUptime(health.osUptimeSec) });
  facts.push({ label: 'WrongStack process', value: formatBytes(health.processRssBytes) });
  return facts;
}

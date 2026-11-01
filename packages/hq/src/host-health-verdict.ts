/**
 * When a machine's health needs a person: the project disk under 5% free or
 * under 2 GiB, or memory under 5% available, judged only on a sample newer
 * than five minutes. The dashboard mirrors these numbers in
 * `hq-next/src/features/machines/health.ts` (a parity test keeps them equal).
 */
import type { HqHostHealth } from './protocol.js';

export const HQ_HOST_HEALTH_FRESH_MS = 5 * 60_000;
export const HQ_DISK_LOW_FRACTION = 0.05;
export const HQ_DISK_LOW_BYTES = 2 * 1024 ** 3;
export const HQ_MEMORY_LOW_FRACTION = 0.05;

export type HqHostHealthProblem = 'disk' | 'memory';

export function hqHostHealthProblems(
  health: (HqHostHealth & { reportedAt: string }) | undefined,
  now: number,
): HqHostHealthProblem[] {
  if (health === undefined) return [];
  const at = Date.parse(health.reportedAt);
  if (!Number.isFinite(at) || now - at > HQ_HOST_HEALTH_FRESH_MS) return [];
  const problems: HqHostHealthProblem[] = [];
  const { diskTotalBytes: total, diskFreeBytes: free } = health;
  if (
    total !== undefined &&
    free !== undefined &&
    total > 0 &&
    (free / total < HQ_DISK_LOW_FRACTION || free < HQ_DISK_LOW_BYTES)
  ) {
    problems.push('disk');
  }
  if (
    health.memTotalBytes > 0 &&
    health.memAvailableBytes / health.memTotalBytes < HQ_MEMORY_LOW_FRACTION
  ) {
    problems.push('memory');
  }
  return problems;
}

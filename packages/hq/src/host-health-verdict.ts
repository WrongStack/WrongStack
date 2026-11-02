/**
 * When a machine's health needs a person: by default the project disk under 5%
 * free or under 2 GiB, or memory under 5% available, judged only on a sample
 * newer than five minutes. The operator can change the thresholds (alert
 * settings). The server judges and puts the verdict on the snapshot
 * (`HqMachineRecord.healthProblems`), so the dashboard and the push
 * notifications cannot disagree.
 */
import type { HqAlertRuleConfig } from './alerts.js';
import type { HqHostHealth } from './protocol.js';

export const HQ_HOST_HEALTH_FRESH_MS = 5 * 60_000;

/** When a machine's health needs a person; 0 turns a check off. */
export interface HqHostHealthThresholds {
  /** Project disk free below this percent. Default 5. */
  diskFreePct: number;
  /** Project disk free below this many GiB. Default 2. */
  diskFreeGiB: number;
  /** Memory available below this percent. Default 5. */
  memAvailablePct: number;
}

export const HQ_DEFAULT_HOST_HEALTH_THRESHOLDS: HqHostHealthThresholds = {
  diskFreePct: 5,
  diskFreeGiB: 2,
  memAvailablePct: 5,
};

/** The thresholds an alert config asks for, defaults filled in. */
export function hqHostHealthThresholds(
  config: Pick<
    HqAlertRuleConfig,
    'hostDiskFreePct' | 'hostDiskFreeGiB' | 'hostMemAvailablePct'
  > = {},
): HqHostHealthThresholds {
  return {
    diskFreePct: config.hostDiskFreePct ?? HQ_DEFAULT_HOST_HEALTH_THRESHOLDS.diskFreePct,
    diskFreeGiB: config.hostDiskFreeGiB ?? HQ_DEFAULT_HOST_HEALTH_THRESHOLDS.diskFreeGiB,
    memAvailablePct:
      config.hostMemAvailablePct ?? HQ_DEFAULT_HOST_HEALTH_THRESHOLDS.memAvailablePct,
  };
}

export type HqHostHealthProblem = 'disk' | 'memory';

export function hqHostHealthProblems(
  health: (HqHostHealth & { reportedAt: string }) | undefined,
  now: number,
  thresholds: HqHostHealthThresholds = HQ_DEFAULT_HOST_HEALTH_THRESHOLDS,
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
    ((thresholds.diskFreePct > 0 && (free / total) * 100 < thresholds.diskFreePct) ||
      (thresholds.diskFreeGiB > 0 && free < thresholds.diskFreeGiB * 1024 ** 3))
  ) {
    problems.push('disk');
  }
  if (
    thresholds.memAvailablePct > 0 &&
    health.memTotalBytes > 0 &&
    (health.memAvailableBytes / health.memTotalBytes) * 100 < thresholds.memAvailablePct
  ) {
    problems.push('memory');
  }
  return problems;
}

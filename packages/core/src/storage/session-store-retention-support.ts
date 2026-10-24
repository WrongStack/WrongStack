import type { SessionStoragePolicy } from '@wrongstack/contracts/types/session';

/**
 * Finite ages only. `NaN` and negatives must not reach a cutoff: every
 * comparison with `NaN` is false, and a negative cutoff sits in the future.
 */
export function assertRetentionDays(maxAgeDays: number): number {
  if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
    throw new TypeError('Invalid prune age');
  }
  return maxAgeDays;
}

/** Equal policies share one in-flight pass. `backfill` is the opt-in flag. */
export function archivePolicyKey(policy: SessionStoragePolicy): string {
  return [
    policy.hotKeepSessions,
    policy.archiveAfterDays,
    policy.includeSubagents ? 1 : 0,
    policy.backfill === true ? 1 : 0,
  ].join(':');
}

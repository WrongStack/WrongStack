import type { KanbanAgentAssignment } from '../types.js';

export const STAMPLESS_ASSIGNMENT_STALE_MS = 10 * 60 * 1000;

/**
 * An unparseable expiry (a worker heartbeat wrote `"in 5 minutes"`) compared
 * as NaN and never expired, wedging the task in `running` for good: fail closed.
 */
export function isLeaseExpired(expiresAt: string | undefined, now: string): boolean {
  if (expiresAt === undefined) return false;
  const expiresMs = Date.parse(expiresAt);
  const parsedNow = Date.parse(now);
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  return !Number.isFinite(expiresMs) || expiresMs <= nowMs;
}

/** Shared by recovery, claiming and queue classification; timestamps are instants. */
export function isAssignmentStale(
  assignment: KanbanAgentAssignment | undefined,
  now: string,
): boolean {
  if (!assignment || (assignment.status !== 'queued' && assignment.status !== 'running'))
    return false;
  const lastSignalAt = assignment.heartbeatAt ?? assignment.claimedAt;
  const stamplessAndSilent =
    assignment.leaseExpiresAt === undefined &&
    (lastSignalAt === undefined ||
      !Number.isFinite(Date.parse(lastSignalAt)) ||
      Date.parse(now) - Date.parse(lastSignalAt) >= STAMPLESS_ASSIGNMENT_STALE_MS);
  return isLeaseExpired(assignment.leaseExpiresAt, now) || stamplessAndSilent;
}

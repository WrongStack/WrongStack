/**
 * Derived reads over the fleet state.
 *
 * Pure functions of a snapshot + the live rings, so they can be unit-tested
 * and so no component re-implements "what counts as needing attention".
 */
import type { HqAlertMessage, HqCommandAuditEntry, HqSnapshot } from '@wrongstack/core/hq';

/** Alerts an operator should act on. `info` is history, not a signal. */
export function actionableAlertCount(alerts: readonly HqAlertMessage[]): number {
  return alerts.filter((alert) => alert.severity !== 'info').length;
}

/**
 * The single number on the Attention badge.
 *
 * It deliberately sums five independent sources — an operator does not care
 * WHICH kind of thing needs them, only that something does:
 *   1. non-info alerts
 *   2. projects whose governance signal is degraded or unreadable
 *   3. agents blocked on a human, or in error
 *   4. clients the server has lost
 *   5. commands that failed or were rejected
 */
export function attentionCount(
  snapshot: HqSnapshot | null,
  alerts: readonly HqAlertMessage[],
  commandStatuses: readonly HqCommandAuditEntry[],
): number {
  const governance = (snapshot?.projects ?? []).filter(
    (project) =>
      project.governance?.signal.level === 'warning' ||
      project.governance?.signal.level === 'unavailable',
  ).length;

  const blockedAgents = (snapshot?.liveSessions ?? [])
    .flatMap((session) => session.agents ?? [])
    .filter((agent) => agent.status === 'waiting_user' || agent.status === 'error').length;

  const lostClients = (snapshot?.clients ?? []).filter((client) => !client.connected).length;

  const failedCommands = commandStatuses.filter(
    (command) => command.ackStatus === 'failed' || command.ackStatus === 'rejected',
  ).length;

  return (
    actionableAlertCount(alerts) + governance + blockedAgents + lostClients + failedCommands
  );
}

export function unreadMailboxCount(snapshot: HqSnapshot | null): number {
  return snapshot?.totals?.unreadMailboxMessages ?? 0;
}

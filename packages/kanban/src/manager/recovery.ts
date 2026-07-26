import type {
  KanbanAgentAssignment,
  KanbanRecoveryMode,
  KanbanRecoveryPolicy,
  KanbanTask,
} from '../types.js';

export function isAssignmentHeartbeatDue(
  assignment: KanbanAgentAssignment,
  checkedAt: string,
): boolean {
  if (!assignment.heartbeatAt || !assignment.leaseExpiresAt) return false;
  const lastHeartbeat = new Date(assignment.heartbeatAt).getTime();
  const expiresAt = new Date(assignment.leaseExpiresAt).getTime();
  const now = new Date(checkedAt).getTime();
  const lease = expiresAt - lastHeartbeat;
  if (lease <= 0) return true;
  return now - lastHeartbeat >= lease / 2;
}

export function selectRecoveryMode(args: {
  requested: KanbanRecoveryMode;
  task: KanbanTask;
  isHeartbeatDue: boolean;
  policy: KanbanRecoveryPolicy | undefined;
}): KanbanRecoveryMode {
  const { requested, task, isHeartbeatDue, policy } = args;
  if (requested !== 'auto') return requested;
  const assignment = task.assignment;
  if (!assignment) return 'retry';
  if (assignment.retryPolicy === 'off') return 'fail';
  const failureKind = assignment.lastFailureKind;
  if (
    policy?.releaseOnFailureKinds !== undefined &&
    failureKind !== undefined &&
    policy.releaseOnFailureKinds.includes(failureKind)
  ) {
    return 'release';
  }
  if (policy?.failWhenCostCeilingSet && assignment.costCeilingUsd !== undefined) {
    return 'fail';
  }
  if (policy?.releaseOnHeartbeatDue && isHeartbeatDue) {
    return 'release';
  }
  if (
    assignment.maxAttempts !== undefined &&
    (assignment.attempt ?? 0) + 1 > assignment.maxAttempts
  ) {
    return 'fail';
  }
  return 'retry';
}

export function msUntilExpiry(leaseExpiresAt: string, nowIso: string): number {
  return new Date(leaseExpiresAt).getTime() - new Date(nowIso).getTime();
}

export function later(a: string | undefined, b: string): string {
  if (a === undefined) return b;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

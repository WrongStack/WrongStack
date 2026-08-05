import type {
  KanbanBoard,
  KanbanLifecycleStage,
  KanbanSearchResult,
  KanbanTask,
  KanbanTaskQueueBucket,
  KanbanTaskQueueClassification,
} from '../types.js';
import { areDependenciesMet } from './task-readiness.js';

export interface ClassifyTaskForQueueOptions {
  now?: string | undefined;
  heartbeatIntervalMs?: number | undefined;
}

export function classifyTaskForQueue(
  board: KanbanBoard,
  task: KanbanTask,
  options: ClassifyTaskForQueueOptions = {},
): KanbanTaskQueueClassification {
  const reasons: string[] = [];
  const assignment = task.assignment;
  const managedStage = managedLifecycleStage(board, task);
  const now = options.now ?? new Date().toISOString();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;

  if (task.status === 'archived') {
    return classification('archived', reasons, { claimable: false, managedStage });
  }
  if (task.status === 'completed') {
    return classification('completed', reasons, { claimable: false, managedStage });
  }

  if (assignment?.status === 'running') {
    if (!assignment.leaseId || !assignment.leaseExpiresAt) {
      reasons.push('Running assignment is missing lease metadata.');
      return classification('running_no_lease', reasons, { claimable: false, managedStage });
    }
    if (assignment.leaseExpiresAt <= now) {
      reasons.push('Running assignment lease has expired.');
      return classification('running_expired', reasons, { claimable: false, managedStage });
    }
    if (msUntilExpiry(assignment.leaseExpiresAt, now) <= heartbeatIntervalMs) {
      reasons.push('Running assignment heartbeat is due before the next interval elapses.');
    }
    return classification('running_live', reasons, { claimable: false, managedStage });
  }

  if (task.status === 'in_progress') {
    reasons.push('Task status is in_progress but no running assignment is present.');
    return classification('running_no_lease', reasons, { claimable: false, managedStage });
  }

  if (assignment?.status === 'queued' || assignment?.status === 'assigned') {
    if (assignment.leaseExpiresAt && assignment.leaseExpiresAt <= now) {
      reasons.push(`${assignment.status} assignment lease has expired.`);
      return classification('queued_expired', reasons, { claimable: false, managedStage });
    }
    return classification('queued', reasons, { claimable: false, managedStage });
  }

  if (task.status === 'review') {
    return classification('review', reasons, { claimable: false, managedStage });
  }

  if (task.status === 'failed') {
    const retryable =
      assignment?.maxAttempts !== undefined && (assignment.attempt ?? 0) < assignment.maxAttempts;
    if (retryable) reasons.push('Failed task has retry attempts remaining.');
    return classification(retryable ? 'failed_retryable' : 'failed_terminal', reasons, {
      claimable: false,
      managedStage,
    });
  }

  const dependenciesMet = areDependenciesMet(board, task.id);
  if (!dependenciesMet) {
    reasons.push('Task has unmet dependencies.');
    return classification('dependency_blocked', reasons, { claimable: false, managedStage });
  }

  if (board.lifecycle?.mode === 'managed' && managedStage !== 'todo') {
    reasons.push(`Managed task is in ${managedStage ?? 'unknown'} stage, not todo.`);
    return classification('stage_blocked', reasons, { claimable: false, managedStage });
  }

  if (
    board.atomicity?.mode === 'enforce' &&
    !task.childTaskIds?.length &&
    task.atomicityAssessment?.verdict === 'needs_decomposition'
  ) {
    reasons.push('Board enforces atomicity and this task needs decomposition.');
    return classification('not_dispatchable', reasons, { claimable: false, managedStage });
  }

  if (task.status === 'pending' || task.status === 'ready') {
    if (board.lifecycle?.mode === 'managed') {
      const missing = missingManagedDispatchDetails(task);
      if (missing.length > 0) {
        reasons.push(`Managed task is missing required detail fields: ${missing.join(', ')}.`);
        return classification('detail_incomplete', reasons, { claimable: false, managedStage });
      }
    }
    return classification('claimable', reasons, { claimable: true, managedStage });
  }

  reasons.push(`Task status ${task.status} is not dispatchable.`);
  return classification('not_dispatchable', reasons, { claimable: false, managedStage });
}

export function queueClassificationSearchResult(
  result: KanbanSearchResult,
  classification: KanbanTaskQueueClassification,
): KanbanSearchResult & { classification: KanbanTaskQueueClassification } {
  return { ...result, classification };
}

function classification(
  bucket: KanbanTaskQueueBucket,
  reasons: string[],
  options: { claimable: boolean; managedStage?: KanbanLifecycleStage | undefined },
): KanbanTaskQueueClassification {
  return {
    bucket,
    claimable: options.claimable,
    reasons,
    ...(options.managedStage !== undefined ? { managedStage: options.managedStage } : {}),
  };
}

function managedLifecycleStage(
  board: KanbanBoard,
  task: KanbanTask,
): KanbanLifecycleStage | undefined {
  const policy = board.lifecycle;
  if (policy?.mode !== 'managed') return undefined;
  return (Object.entries(policy.columns).find(([, columnId]) => columnId === task.columnId)?.[0] ??
    task.lifecycle?.currentStage) as KanbanLifecycleStage | undefined;
}

function missingManagedDispatchDetails(task: KanbanTask): string[] {
  const missing: string[] = [];
  if (!hasText(task.description)) missing.push('description');
  if (![task.assignee, task.assignedAgent, task.assignment?.agentId, task.assignment?.name].some(hasText)) {
    missing.push('assignee');
  }
  if (!hasText(task.dueDate) || !Number.isFinite(Date.parse(task.dueDate))) missing.push('dueDate');
  if (!task.labels?.some(hasText)) missing.push('labels');
  if (task.atomic && !task.childTaskIds?.some(hasText)) missing.push('childTaskIds');
  if (!task.successCriteria?.length || task.successCriteria.some((check) => !hasText(check.description))) {
    missing.push('successCriteria');
  }
  return missing;
}

function msUntilExpiry(leaseExpiresAt: string, now: string): number {
  return new Date(leaseExpiresAt).getTime() - new Date(now).getTime();
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

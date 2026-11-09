import { createHash } from 'node:crypto';
import { StaleWriteError } from './manager/lifecycle-error.js';
import type { KanbanBoard, KanbanEventContext, KanbanTask } from './types.js';

/** Contract version excludes presence, renewals and synchronization timestamps. */
export function managementTaskVersion(board: KanbanBoard, task: KanbanTask): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        policy: [board.lifecycle, board.atomicity, board.completionGate, board.boundary],
        id: task.id,
        title: task.title,
        description: task.description,
        priority: task.priority,
        type: task.type,
        status: task.status,
        columnId: task.columnId,
        assignee: task.assignee,
        assignedAgent: task.assignedAgent,
        assignment: task.assignment && {
          status: task.assignment.status,
          leaseId: task.assignment.leaseId,
          agentId: task.assignment.agentId,
          subagentId: task.assignment.subagentId,
          runTaskId: task.assignment.runTaskId,
        },
        dependencies: [...(task.dependsOn ?? [])].sort(),
        parent: task.parentTaskId,
        children: [...(task.childTaskIds ?? [])].sort(),
        chain: task.chain,
        checks: task.successCriteria,
        // Metric timestamps alone do not change what the manager reviewed.
        goalMetrics: task.goalMetrics?.map((metric) => ({
          id: metric.id,
          name: metric.name,
          status: metric.status,
          target: metric.target,
          current: metric.current,
          direction: metric.direction,
          unit: metric.unit,
          notes: metric.notes,
        })),
        notes: task.notes,
        links: task.links,
        park: task.park,
        verification: task.verificationReport,
        decomposition: task.decomposition,
        atomic: task.atomic,
        expectedFiles: task.expectedFileChanges,
      }),
    )
    .digest('hex');
}

/** MUST run inside the board mutation transaction, before modifying any card. */
export function assertManagementWrite(
  board: KanbanBoard,
  tasks: readonly KanbanTask[],
  context?: KanbanEventContext | undefined,
  action: 'contract' | 'note' = 'contract',
): void {
  if (context?.expectedManagementToken === undefined) return;
  const refuse = (reason: string): never => {
    throw new StaleWriteError(`Kanban manager: ${reason}`);
  };
  const lease = board.management?.lease;
  if (!lease || lease.token !== context.expectedManagementToken || lease.expiresAt <= Date.now())
    refuse('management lease expired or changed; nothing was written.');
  if (
    board.supervisor?.enabled === false ||
    board.supervisor?.mode === 'deterministic' ||
    board.completedAt ||
    board.kind === 'archive' ||
    board.retention?.archivedAt
  )
    refuse('board management is disabled.');
  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'archived' || task.mergedIntoTaskId)
      refuse('card is no longer active.');
    if (
      action !== 'note' &&
      (task.status === 'in_progress' ||
        task.status === 'review' ||
        task.assignment ||
        task.assignee ||
        task.assignedAgent ||
        task.park)
    )
      refuse('card is worker-owned or parked; add a proposal note instead.');
    if (context.expectedManagementTaskVersions?.[task.id] !== managementTaskVersion(board, task))
      refuse(
        `card ${task.id} changed or was not read; read the live board and reassess before retrying.`,
      );
  }
}

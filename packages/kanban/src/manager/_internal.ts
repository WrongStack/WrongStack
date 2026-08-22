import { assessAtomicity, candidateFromKanbanTask } from '../atomicity/assess.js';
import { mutateBoard } from '../storage.js';
import type {
  KanbanAgentAssignment,
  KanbanBoard,
  KanbanEvent,
  KanbanTask,
  KanbanTaskPriority,
} from '../types.js';
import type {
  AssignKanbanTaskInput,
  ClaimKanbanTaskInput,
  KanbanSearchInput,
} from '../types-operations.js';
import { nowIso, statusForColumn } from './basic-helpers.js';
import { createKanbanEvent, emitKanbanEvent } from './board-events.js';
// Leaf import: task-classifier.ts pulls only types and task-readiness, so this
// direction cannot cycle back into _internal.
import { missingManagedDispatchDetails } from './task-classifier.js';
import {
  applyCompletedAtForStatus,
  normalizeColumnTaskOrders,
  syncTaskColumnForStatus,
} from './task-column-helpers.js';
import { findTask } from './task-lookup.js';
import { areDependenciesMet } from './task-readiness.js';

export {
  isoFromTimestamp,
  nowIso,
  parseIsoTimestamp,
  requireNonBlank,
  slugify,
  statusForColumn,
  uniqueIdFromSet,
  uniqueStrings,
} from './basic-helpers.js';
export {
  assignmentEventType,
  createBoardHistoryEntry,
  createKanbanEvent,
  emitBoardHistoryEvent,
  emitKanbanEvent,
} from './board-events.js';
export {
  assertNoDependencyCycles,
  hasDependencyPath,
  remapIdList,
  remapTaskReferences,
} from './dependency-helpers.js';
export {
  isAssignmentHeartbeatDue,
  later,
  msUntilExpiry,
  selectRecoveryMode,
} from './recovery.js';
export {
  addDependencyToTask,
  findGoalMetric,
  normalizeChainMetadata,
  normalizeDependencyIds,
  resolveTaskRefs,
  rewireDependents,
  setChainMetadata,
  tasksInChain,
  uniqueColumnId,
} from './task-chain-internal.js';
export {
  applyCompletedAtForStatus,
  clampOrder,
  columnIdForKanbanStatus,
  existingColumnId,
  nextTaskOrder,
  normalizeColumnTaskOrders,
  placeTaskInColumn,
  syncTaskColumnForStatus,
} from './task-column-helpers.js';

export {
  applyTaskPatch,
  cloneChecks,
  cloneGoalMetrics,
  cloneTaskForBoard,
  createTaskObject,
  highestPriority,
  mergedTaskDescription,
  normalizeColumns,
  optionalArray,
} from './task-factory.js';
export {
  applyGraphNodeToTask,
  applyTaskGraphRelationships,
  buildTaskGraphMetadata,
  columnIdForTaskGraphStatus,
  findTaskByOrigin,
  inferTaskType,
  isTaskFromGraph,
  kanbanStatusToTaskGraphStatus,
  taskGraphEdgesFromBoard,
  taskGraphStatusToKanbanStatus,
  taskInputFromGraphNode,
  taskToTaskGraphNode,
} from './task-graph-internal.js';
export { findTask } from './task-lookup.js';

export function buildAssignment(input: AssignKanbanTaskInput): KanbanAgentAssignment {
  return {
    status: input.status ?? 'assigned',
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.modelRouting !== undefined ? { modelRouting: input.modelRouting } : {}),
    ...(input.fallbackProfile !== undefined ? { fallbackProfile: input.fallbackProfile } : {}),
    ...(input.fallbackModels !== undefined ? { fallbackModels: input.fallbackModels } : {}),
    ...(input.skills !== undefined ? { skills: input.skills } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.allowedCapabilities !== undefined
      ? { allowedCapabilities: input.allowedCapabilities }
      : {}),
    ...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}),
    ...(input.claimedAt !== undefined ? { claimedAt: input.claimedAt } : {}),
    ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
    ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
    ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
    ...(input.retryPolicy !== undefined ? { retryPolicy: input.retryPolicy } : {}),
    ...(input.lastFailureKind !== undefined ? { lastFailureKind: input.lastFailureKind } : {}),
  };
}

export async function claimReadyTaskOnBoard(
  projectRoot: string,
  boardId: string,
  input: ClaimKanbanTaskInput,
): Promise<{ board: KanbanBoard; task: KanbanTask } | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    if (board.lifecycle?.mode === 'managed') {
      const candidates = input.taskId
        ? [findTask(board, input.taskId)].filter((task): task is KanbanTask => Boolean(task))
        : board.tasks.filter((task) => isTaskReadyForWork(board, task)).sort(compareTasksForWork);
      const task = candidates.find(
        (candidate) =>
          isTaskReadyForWork(board, candidate) && candidate.lifecycle?.currentStage === 'todo',
      );
      if (!task) {
        const stageBlocked = candidates.length > 0;
        if (stageBlocked) {
          process.stderr.write(
            `[kanban] claimReadyTask: ${candidates.length} ready candidate(s) on "${boardId}" ` +
              `but none in 'todo' lifecycle stage. Tasks may be stage-blocked in 'backlog'.\n`,
          );
        }
        return null;
      }
      const current = task.assignment;
      const assignment = buildAssignment({
        ...(current?.agentId !== undefined ? { agentId: current.agentId } : {}),
        ...(current?.name !== undefined ? { name: current.name } : {}),
        ...(current?.role !== undefined ? { role: current.role } : {}),
        ...(current?.provider !== undefined ? { provider: current.provider } : {}),
        ...(current?.model !== undefined ? { model: current.model } : {}),
        ...(current?.modelRouting !== undefined ? { modelRouting: current.modelRouting } : {}),
        ...(current?.fallbackProfile !== undefined
          ? { fallbackProfile: current.fallbackProfile }
          : {}),
        ...(current?.fallbackModels !== undefined
          ? { fallbackModels: current.fallbackModels }
          : {}),
        ...(current?.skills !== undefined ? { skills: current.skills } : {}),
        ...(current?.tools !== undefined ? { tools: current.tools } : {}),
        ...(current?.allowedCapabilities !== undefined
          ? { allowedCapabilities: current.allowedCapabilities }
          : {}),
        ...(current?.leaseId !== undefined ? { leaseId: current.leaseId } : {}),
        ...(current?.claimedAt !== undefined ? { claimedAt: current.claimedAt } : {}),
        ...(current?.heartbeatAt !== undefined ? { heartbeatAt: current.heartbeatAt } : {}),
        ...(current?.leaseExpiresAt !== undefined
          ? { leaseExpiresAt: current.leaseExpiresAt }
          : {}),
        ...(current?.attempt !== undefined ? { attempt: current.attempt } : {}),
        ...(current?.maxAttempts !== undefined ? { maxAttempts: current.maxAttempts } : {}),
        ...(current?.costCeilingUsd !== undefined
          ? { costCeilingUsd: current.costCeilingUsd }
          : {}),
        ...(current?.retryPolicy !== undefined ? { retryPolicy: current.retryPolicy } : {}),
        ...(current?.lastFailureKind !== undefined
          ? { lastFailureKind: current.lastFailureKind }
          : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.modelRouting !== undefined ? { modelRouting: input.modelRouting } : {}),
        ...(input.fallbackProfile !== undefined ? { fallbackProfile: input.fallbackProfile } : {}),
        ...(input.fallbackModels !== undefined ? { fallbackModels: input.fallbackModels } : {}),
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.allowedCapabilities !== undefined
          ? { allowedCapabilities: input.allowedCapabilities }
          : {}),
        ...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}),
        ...(input.claimedAt !== undefined ? { claimedAt: input.claimedAt } : {}),
        ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
        ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
        ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
        ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
        ...(input.retryPolicy !== undefined ? { retryPolicy: input.retryPolicy } : {}),
        ...(input.lastFailureKind !== undefined ? { lastFailureKind: input.lastFailureKind } : {}),
        ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
        status: 'queued',
      });
      assignment.claimedAt = assignment.claimedAt ?? nowIso();
      task.assignment = assignment;
      if (assignment.agentId ?? assignment.role ?? assignment.name) {
        task.assignedAgent = assignment.agentId ?? assignment.role ?? assignment.name;
      }
      if (input.assignee ?? assignment.name ?? assignment.agentId) {
        task.assignee = input.assignee ?? assignment.name ?? assignment.agentId;
      }
      task.updatedAt = nowIso();
      board.updatedAt = task.updatedAt;
      event = createKanbanEvent(board.id, task, 'task.claimed', {
        before: current ? { ...current } : undefined,
        after: { ...assignment },
      });
      return task;
    }
    const candidates = input.taskId
      ? [findTask(board, input.taskId)].filter((task): task is KanbanTask => Boolean(task))
      : board.tasks.filter((task) => isTaskReadyForWork(board, task)).sort(compareTasksForWork);
    const task = candidates.find((candidate) => isTaskReadyForWork(board, candidate));
    if (!task) return null;
    const previousColumnId = task.columnId;
    const current = task.assignment;
    const assignment = buildAssignment({
      ...(current?.agentId !== undefined ? { agentId: current.agentId } : {}),
      ...(current?.name !== undefined ? { name: current.name } : {}),
      ...(current?.role !== undefined ? { role: current.role } : {}),
      ...(current?.provider !== undefined ? { provider: current.provider } : {}),
      ...(current?.model !== undefined ? { model: current.model } : {}),
      ...(current?.modelRouting !== undefined ? { modelRouting: current.modelRouting } : {}),
      ...(current?.fallbackProfile !== undefined
        ? { fallbackProfile: current.fallbackProfile }
        : {}),
      ...(current?.fallbackModels !== undefined ? { fallbackModels: current.fallbackModels } : {}),
      ...(current?.skills !== undefined ? { skills: current.skills } : {}),
      ...(current?.tools !== undefined ? { tools: current.tools } : {}),
      ...(current?.allowedCapabilities !== undefined
        ? { allowedCapabilities: current.allowedCapabilities }
        : {}),
      ...(current?.leaseId !== undefined ? { leaseId: current.leaseId } : {}),
      ...(current?.claimedAt !== undefined ? { claimedAt: current.claimedAt } : {}),
      ...(current?.heartbeatAt !== undefined ? { heartbeatAt: current.heartbeatAt } : {}),
      ...(current?.leaseExpiresAt !== undefined ? { leaseExpiresAt: current.leaseExpiresAt } : {}),
      ...(current?.attempt !== undefined ? { attempt: current.attempt } : {}),
      ...(current?.maxAttempts !== undefined ? { maxAttempts: current.maxAttempts } : {}),
      ...(current?.costCeilingUsd !== undefined ? { costCeilingUsd: current.costCeilingUsd } : {}),
      ...(current?.retryPolicy !== undefined ? { retryPolicy: current.retryPolicy } : {}),
      ...(current?.lastFailureKind !== undefined
        ? { lastFailureKind: current.lastFailureKind }
        : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.modelRouting !== undefined ? { modelRouting: input.modelRouting } : {}),
      ...(input.fallbackProfile !== undefined ? { fallbackProfile: input.fallbackProfile } : {}),
      ...(input.fallbackModels !== undefined ? { fallbackModels: input.fallbackModels } : {}),
      ...(input.skills !== undefined ? { skills: input.skills } : {}),
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
      ...(input.allowedCapabilities !== undefined
        ? { allowedCapabilities: input.allowedCapabilities }
        : {}),
      ...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}),
      ...(input.claimedAt !== undefined ? { claimedAt: input.claimedAt } : {}),
      ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
      ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
      ...(input.retryPolicy !== undefined ? { retryPolicy: input.retryPolicy } : {}),
      ...(input.lastFailureKind !== undefined ? { lastFailureKind: input.lastFailureKind } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      status: input.status ?? 'queued',
    });
    assignment.claimedAt = assignment.claimedAt ?? nowIso();
    assignment.dispatchedAt = assignment.dispatchedAt ?? assignment.claimedAt;
    task.assignment = assignment;
    if (assignment.agentId ?? assignment.role ?? assignment.name) {
      task.assignedAgent = assignment.agentId ?? assignment.role ?? assignment.name;
    }
    if (input.assignee ?? assignment.name ?? assignment.agentId) {
      task.assignee = input.assignee ?? assignment.name ?? assignment.agentId;
    }
    task.status = assignment.status === 'running' ? 'in_progress' : 'ready';
    delete task.completedAt;
    syncTaskColumnForStatus(board, task, previousColumnId);
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, 'task.claimed', {
      before: current ? { ...current } : undefined,
      after: { ...assignment },
    });
    return task;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? { board: updated.board, task: updated.result } : null;
}

export function compareTasksForWork(a: KanbanTask, b: KanbanTask): number {
  const priorityRank: Record<KanbanTaskPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  const aIsChild = a.parentTaskId !== undefined;
  const bIsChild = b.parentTaskId !== undefined;
  const aIsParent = (a.childTaskIds?.length ?? 0) > 0;
  const bIsParent = (b.childTaskIds?.length ?? 0) > 0;
  if (aIsChild && bIsParent) return -1;
  if (aIsParent && bIsChild) return 1;
  return (
    priorityRank[a.priority] - priorityRank[b.priority] ||
    a.columnId.localeCompare(b.columnId) ||
    a.order - b.order ||
    a.createdAt.localeCompare(b.createdAt)
  );
}

export function matchesKanbanSearch(
  board: KanbanBoard,
  task: KanbanTask,
  input: KanbanSearchInput,
): boolean {
  const query = input.query?.trim().toLowerCase();
  if (input.assignedAgent && task.assignedAgent !== input.assignedAgent) return false;
  if (input.status && task.status !== input.status) return false;
  if (input.priority && task.priority !== input.priority) return false;
  if (input.label && !task.labels?.includes(input.label)) return false;
  if (input.chainId && task.chain?.chainId !== input.chainId) return false;
  if (input.readyOnly && !isTaskReadyForWork(board, task)) return false;
  if (!query) return true;
  return [task.title, task.description, task.assignedAgent, task.assignee, ...(task.labels ?? [])]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

export function isTaskReadyForWork(board: KanbanBoard, task: KanbanTask): boolean {
  if (!['pending', 'ready'].includes(task.status)) return false;
  if (task.assignment) {
    const status = task.assignment.status;
    if (status === 'queued' || status === 'running') return false;
    const hasExecutionOwner = Boolean(
      task.assignment.agentId || task.assignment.subagentId || task.assignment.runTaskId,
    );
    if (status === 'assigned' && hasExecutionOwner) return false;
  }
  if (task.mergedIntoTaskId) return false;
  if (!areDependenciesMet(board, task.id)) return false;
  if (board.lifecycle?.mode === 'managed' && missingManagedDispatchDetails(task).length > 0) {
    return false;
  }
  if (
    board.atomicity?.mode === 'enforce' &&
    !task.childTaskIds?.length &&
    task.atomicityAssessment?.verdict === 'needs_decomposition'
  ) {
    return false;
  }
  return true;
}

export function stampAtomicityAssessment(board: KanbanBoard, task: KanbanTask): void {
  if (board.atomicity?.mode === 'off') return;
  task.atomicityAssessment = assessAtomicity(
    candidateFromKanbanTask(task),
    board.atomicity?.config,
  );
}

export function reconcileTaskColumns(board: KanbanBoard, now: string): void {
  const fallbackColumnId = board.columns[0]?.id;
  if (!fallbackColumnId) return;
  const columnIds = new Set(board.columns.map((column) => column.id));
  for (const task of board.tasks) {
    if (!columnIds.has(task.columnId)) {
      task.columnId = fallbackColumnId;
      task.status = statusForColumn(fallbackColumnId);
      task.updatedAt = now;
      applyCompletedAtForStatus(task, now);
    }
  }
}

export function normalizeAllColumnTaskOrders(board: KanbanBoard): void {
  for (const column of board.columns) normalizeColumnTaskOrders(board, column.id);
}

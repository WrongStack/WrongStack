import { randomUUID } from 'node:crypto';
import {
  appendKanbanEvent,
  createBoardObject,
  deleteBoard,
  listBoardSummaries,
  mutateBoard,
  readBoard,
  readKanbanEvents,
  summarizeBoard,
  writeBoard,
} from './storage.js';
import {
  type AssignKanbanTaskInput,
  type AddKanbanGoalMetricInput,
  type ClaimKanbanTaskInput,
  type CopyKanbanTaskOptions,
  type CreateKanbanBoardInput,
  type CreateKanbanColumnInput,
  type CreateKanbanTaskInput,
  DEFAULT_COLUMNS,
  type DuplicateKanbanBoardInput,
  type KanbanAgentAssignment,
  type KanbanAgentRunStatus,
  type KanbanBoard,
  type KanbanCheck,
  type KanbanCheckStatus,
  type KanbanColumn,
  type KanbanEvent,
  type KanbanGenerationInput,
  type HeartbeatKanbanTaskAssignmentInput,
  type KanbanGoalMetric,
  type KanbanLink,
  type KanbanNote,
  type KanbanQueueHealth,
  type KanbanOrchestrationSnapshot,
  type KanbanSearchInput,
  type KanbanSearchResult,
  type KanbanTask,
  type KanbanTaskPriority,
  type KanbanTaskStatus,
  type MergeKanbanTasksInput,
  type RemoveKanbanColumnOptions,
  type RecoverStaleKanbanAssignmentsInput,
  type RecoverStaleKanbanAssignmentsResult,
  type KanbanRecoveryMode,
  type KanbanRecoveryPolicy,
  type ReleaseKanbanTaskClaimInput,
  type SetKanbanTaskChainInput,
  type SplitKanbanTaskInput,
  type UpdateKanbanGoalMetricInput,
  type UpdateKanbanBoardInput,
  type UpdateKanbanColumnInput,
  type UpdateKanbanTaskInput,
} from './types.js';
import type { PhaseGraph, PhaseNode } from '../autophase/types.js';
import type { TaskEdge, TaskGraph, TaskNode, TaskStatus, TaskType } from '../types/task-graph.js';

export async function createBoard(
  projectRoot: string,
  input: CreateKanbanBoardInput,
): Promise<KanbanBoard> {
  const columns = normalizeColumns(input.columns);
  const board = createBoardObject({
    title: requireNonBlank(input.title, 'Kanban board title'),
    columns,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
  });

  if (input.tasks?.length) {
    board.tasks = input.tasks.map((task, index) =>
      createTaskObject(board, {
        ...task,
        title: task.title,
        columnId: task.columnId ?? board.columns[0]?.id ?? 'backlog',
        order: task.order ?? index,
      }),
    );
  }

  await writeBoard(projectRoot, board);
  return board;
}

export async function listBoards(projectRoot: string) {
  return listBoardSummaries(projectRoot);
}

export async function getBoard(projectRoot: string, boardId: string): Promise<KanbanBoard | null> {
  return readBoard(projectRoot, boardId);
}

export async function updateBoard(
  projectRoot: string,
  boardId: string,
  input: UpdateKanbanBoardInput,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const now = nowIso();
    if (input.title !== undefined) board.title = requireNonBlank(input.title, 'Kanban board title');
    if (input.description !== undefined) board.description = input.description;
    if (input.tags !== undefined) board.tags = input.tags;
    if (input.columns !== undefined) {
      board.columns = normalizeColumns(input.columns);
      reconcileTaskColumns(board, now);
    }
    if (input.completedAt !== undefined) {
      if (input.completedAt === null) delete board.completedAt;
      else board.completedAt = input.completedAt;
    }
    normalizeAllColumnTaskOrders(board);
    board.updatedAt = now;
    return board;
  });
  return updated?.board ?? null;
}

export async function removeBoard(projectRoot: string, boardId: string): Promise<boolean> {
  return deleteBoard(projectRoot, boardId);
}

export async function duplicateBoard(
  projectRoot: string,
  boardId: string,
  input: DuplicateKanbanBoardInput = {},
): Promise<KanbanBoard | null> {
  const source = await readBoard(projectRoot, boardId);
  if (!source) return null;
  const board = createBoardObject({
    title: input.title ?? `${source.title} Copy`,
    ...(source.description !== undefined ? { description: source.description } : {}),
    ...(source.tags !== undefined ? { tags: [...source.tags] } : {}),
    columns: source.columns.map((column) => ({ ...column })),
    generatedBy: input.generatedBy ?? `duplicate:${source.id}`,
  });

  if (input.includeTasks !== false) {
    const sourceTasks = source.tasks.filter(
      (task) => input.includeCompletedTasks !== false || task.status !== 'completed',
    );
    const idMap = new Map<string, string>();
    board.tasks = sourceTasks.map((task) => {
      const cloned = cloneTaskForBoard(board, task, {
        preserveAssignment: input.preserveAssignment === true,
        preserveDependencies: true,
      });
      idMap.set(task.id, cloned.id);
      return cloned;
    });
    for (let index = 0; index < board.tasks.length; index++) {
      const original = sourceTasks[index];
      const cloned = board.tasks[index];
      if (!original || !cloned) continue;
      remapTaskReferences(cloned, original, idMap);
    }
  }

  await writeBoard(projectRoot, board);
  return board;
}

export async function addColumn(
  projectRoot: string,
  boardId: string,
  input: CreateKanbanColumnInput,
): Promise<{ board: KanbanBoard; column: KanbanColumn } | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const column: KanbanColumn = {
      id: uniqueColumnId(board, input.id ?? (slugify(input.title) || 'column')),
      title: requireNonBlank(input.title, 'Kanban column title'),
      order: input.order ?? board.columns.length,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.wipLimit !== undefined ? { wipLimit: input.wipLimit } : { wipLimit: 0 }),
    };
    board.columns.push(column);
    board.columns = normalizeColumns(board.columns);
    board.updatedAt = nowIso();
    return column;
  });
  return updated ? { board: updated.board, column: updated.result } : null;
}

export async function updateColumn(
  projectRoot: string,
  boardId: string,
  columnId: string,
  input: UpdateKanbanColumnInput,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const resolvedColumnId = existingColumnId(board, columnId);
    if (!resolvedColumnId) return null;
    const column = board.columns.find((candidate) => candidate.id === resolvedColumnId);
    if (!column) return null;
    if (input.title !== undefined)
      column.title = requireNonBlank(input.title, 'Kanban column title');
    if (input.description !== undefined) column.description = input.description;
    if (input.color !== undefined) column.color = input.color;
    if (input.order !== undefined) column.order = input.order;
    if (input.wipLimit !== undefined) column.wipLimit = input.wipLimit;
    board.columns = normalizeColumns(board.columns);
    board.updatedAt = nowIso();
    return board;
  });
  return updated?.result ? updated.board : null;
}

export async function removeColumn(
  projectRoot: string,
  boardId: string,
  columnId: string,
  options: RemoveKanbanColumnOptions = {},
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const resolvedColumnId = existingColumnId(board, columnId);
    if (!resolvedColumnId) return null;
    const index = board.columns.findIndex((column) => column.id === resolvedColumnId);
    if (index === -1) return null;
    const columnTasks = board.tasks.filter((task) => task.columnId === resolvedColumnId);
    if (columnTasks.length && !options.moveTasksToColumnId) {
      throw new Error(
        `Column "${resolvedColumnId}" has tasks. Pass moveTasksToColumnId to move them.`,
      );
    }
    if (options.moveTasksToColumnId) {
      const targetColumnId = existingColumnId(board, options.moveTasksToColumnId);
      if (!targetColumnId)
        throw new Error(`Target column not found: ${options.moveTasksToColumnId}`);
      if (targetColumnId === resolvedColumnId) {
        throw new Error(`Cannot move tasks to the column being removed: ${resolvedColumnId}`);
      }
      const now = nowIso();
      const targetStart = nextTaskOrder(board, targetColumnId);
      const orderedColumnTasks = columnTasks.sort((a, b) => a.order - b.order);
      for (let i = 0; i < orderedColumnTasks.length; i++) {
        const task = orderedColumnTasks[i];
        if (!task) continue;
        task.columnId = targetColumnId;
        task.order = targetStart + i;
        task.status = statusForColumn(targetColumnId);
        task.updatedAt = now;
        applyCompletedAtForStatus(task, now);
      }
    }
    board.columns.splice(index, 1);
    board.columns = normalizeColumns(board.columns);
    const updatedAt = nowIso();
    reconcileTaskColumns(board, updatedAt);
    if (options.moveTasksToColumnId) normalizeAllColumnTaskOrders(board);
    board.updatedAt = updatedAt;
    return board;
  });
  return updated?.result ? updated.board : null;
}

export async function addTask(
  projectRoot: string,
  boardId: string,
  input: CreateKanbanTaskInput,
): Promise<{ board: KanbanBoard; task: KanbanTask } | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = createTaskObject(board, input);
    board.tasks.push(task);
    placeTaskInColumn(board, task, task.columnId, task.order);
    board.updatedAt = nowIso();
    return task;
  });
  return updated ? { board: updated.board, task: updated.result } : null;
}

export async function copyTaskToBoard(
  projectRoot: string,
  sourceBoardId: string,
  taskId: string,
  targetBoardId: string,
  options: CopyKanbanTaskOptions = {},
): Promise<{ sourceBoard: KanbanBoard; targetBoard: KanbanBoard; task: KanbanTask } | null> {
  const sourceBoard = await readBoard(projectRoot, sourceBoardId);
  if (!sourceBoard) return null;
  const sourceTask = findTask(sourceBoard, taskId);
  if (!sourceTask) return null;

  const updated = await mutateBoard(projectRoot, targetBoardId, (targetBoard) => {
    const task = cloneTaskForBoard(targetBoard, sourceTask, {
      targetColumnId: options.targetColumnId,
      targetOrder: options.targetOrder,
      preserveAssignment: options.preserveAssignment === true,
      preserveDependencies: options.preserveDependencies === true,
    });
    targetBoard.tasks.push(task);
    placeTaskInColumn(targetBoard, task, task.columnId, task.order);
    targetBoard.updatedAt = nowIso();
    return task;
  });

  return updated ? { sourceBoard, targetBoard: updated.board, task: updated.result } : null;
}

export async function transferTaskToBoard(
  projectRoot: string,
  sourceBoardId: string,
  taskId: string,
  targetBoardId: string,
  options: CopyKanbanTaskOptions = {},
): Promise<{ sourceBoard: KanbanBoard; targetBoard: KanbanBoard; task: KanbanTask } | null> {
  const sourceBoard = await readBoard(projectRoot, sourceBoardId);
  if (!sourceBoard) return null;
  const sourceTask = findTask(sourceBoard, taskId);
  if (!sourceTask) return null;

  if (sourceBoard.id === (await readBoard(projectRoot, targetBoardId))?.id) {
    const moved = await moveTask(
      projectRoot,
      sourceBoard.id,
      sourceTask.id,
      options.targetColumnId ?? sourceTask.columnId,
      options.targetOrder,
    );
    const task = moved ? findTask(moved, sourceTask.id) : undefined;
    return moved && task ? { sourceBoard: moved, targetBoard: moved, task } : null;
  }

  const copied = await copyTaskToBoard(projectRoot, sourceBoard.id, sourceTask.id, targetBoardId, {
    ...options,
    preserveAssignment: options.preserveAssignment ?? true,
    preserveDependencies: options.preserveDependencies ?? false,
  });
  if (!copied) return null;
  const sourceAfterRemoval = await removeTask(projectRoot, sourceBoard.id, sourceTask.id);
  return {
    sourceBoard: sourceAfterRemoval ?? sourceBoard,
    targetBoard: copied.targetBoard,
    task: copied.task,
  };
}

export async function updateTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: UpdateKanbanTaskInput,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    applyTaskPatch(board, task, input);
    return task;
  });
  return updated?.result ? updated.board : null;
}

export async function moveTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  targetColumnId: string,
  targetOrder?: number,
): Promise<KanbanBoard | null> {
  return updateTask(projectRoot, boardId, taskId, {
    columnId: targetColumnId,
    ...(targetOrder !== undefined ? { order: targetOrder } : {}),
  });
}

export async function removeTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const taskToRemove = findTask(board, taskId);
    if (!taskToRemove) return false;
    const index = board.tasks.findIndex((task) => task.id === taskToRemove.id);
    if (index === -1) return false;
    board.tasks.splice(index, 1);
    for (const task of board.tasks) {
      if (task.dependsOn?.includes(taskToRemove.id)) {
        task.dependsOn = task.dependsOn.filter((depId) => depId !== taskToRemove.id);
        if (task.dependsOn.length === 0) delete task.dependsOn;
      }
      if (task.childTaskIds?.includes(taskToRemove.id)) {
        task.childTaskIds = task.childTaskIds.filter((childId) => childId !== taskToRemove.id);
        if (task.childTaskIds.length === 0) delete task.childTaskIds;
      }
      if (task.parentTaskId === taskToRemove.id) delete task.parentTaskId;
      if (task.mergedIntoTaskId === taskToRemove.id) delete task.mergedIntoTaskId;
      if (task.mergedFromTaskIds?.includes(taskToRemove.id)) {
        task.mergedFromTaskIds = task.mergedFromTaskIds.filter(
          (sourceId) => sourceId !== taskToRemove.id,
        );
        if (task.mergedFromTaskIds.length === 0) delete task.mergedFromTaskIds;
      }
      if (task.chain?.previousTaskId === taskToRemove.id) delete task.chain.previousTaskId;
      if (task.chain?.nextTaskId === taskToRemove.id) delete task.chain.nextTaskId;
    }
    if (taskToRemove.chain?.chainId) normalizeChainMetadata(board, taskToRemove.chain.chainId);
    normalizeColumnTaskOrders(board, taskToRemove.columnId);
    board.updatedAt = nowIso();
    return true;
  });
  return updated?.result ? updated.board : null;
}

export async function getTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
): Promise<KanbanTask | null> {
  const board = await readBoard(projectRoot, boardId);
  return board ? (findTask(board, taskId) ?? null) : null;
}

export async function listKanbanEvents(
  projectRoot: string,
  boardId: string,
): Promise<KanbanEvent[]> {
  return readKanbanEvents(projectRoot, boardId);
}

export async function assignTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: AssignKanbanTaskInput,
): Promise<KanbanBoard | null> {
  return mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const assignment = buildAssignment(input);
    task.assignment = assignment;
    task.assignedAgent = assignment.agentId ?? assignment.role ?? assignment.name;
    task.assignee = input.assignee ?? assignment.name ?? assignment.agentId;
    // Sprint 3: mirror policy fields from assignment to durable task level.
    if (input.retryPolicy !== undefined) task.retryPolicy = input.retryPolicy;
    if (input.costCeilingUsd !== undefined) task.costCeilingUsd = input.costCeilingUsd;
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    return task;
  }).then((updated) => (updated?.result ? updated.board : null));
}

export async function updateTaskAssignment(
  projectRoot: string,
  boardId: string,
  taskId: string,
  patch: Partial<KanbanAgentAssignment> & { status?: KanbanAgentRunStatus | undefined },
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const previousColumnId = task.columnId;
    const beforeAssignment = task.assignment ? { ...task.assignment } : undefined;
    const nextAssignment: KanbanAgentAssignment = {
      ...(task.assignment ?? { status: 'assigned' as const }),
    };
    for (const [key, value] of Object.entries(patch) as Array<
      [keyof KanbanAgentAssignment, KanbanAgentAssignment[keyof KanbanAgentAssignment]]
    >) {
      if (value !== undefined) {
        (nextAssignment as unknown as Record<string, unknown>)[key] = value;
      }
    }
    task.assignment = nextAssignment;
    if (task.assignment.agentId) task.assignedAgent = task.assignment.agentId;
    if (task.assignment.status === 'completed') {
      task.assignment.completedAt = task.assignment.completedAt ?? nowIso();
      task.status = 'completed';
      task.completedAt = task.assignment.completedAt;
      if (patch.error === undefined) delete task.assignment.error;
    } else if (task.assignment.status === 'running') {
      delete task.assignment.completedAt;
      if (patch.error === undefined) delete task.assignment.error;
      task.status = 'in_progress';
      delete task.completedAt;
    } else if (task.assignment.status === 'failed') {
      delete task.assignment.completedAt;
      task.status = 'failed';
      delete task.completedAt;
    } else if (task.assignment.status === 'cancelled') {
      delete task.assignment.completedAt;
      if (patch.error === undefined) delete task.assignment.error;
      task.status = 'blocked';
      delete task.completedAt;
    } else if (task.assignment.status === 'queued' || task.assignment.status === 'assigned') {
      delete task.assignment.completedAt;
      if (patch.error === undefined) delete task.assignment.error;
      if (task.status === 'completed' || task.status === 'failed') {
        task.status = task.assignment.status === 'queued' ? 'ready' : 'pending';
      }
      delete task.completedAt;
    }
    syncTaskColumnForStatus(board, task, previousColumnId);
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, assignmentEventType(task.assignment.status), {
      before: beforeAssignment,
      after: { ...task.assignment },
      note: patch.error ?? patch.lastResult,
    });
    return task;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function heartbeatTaskAssignment(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: HeartbeatKanbanTaskAssignmentInput = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task?.assignment) return null;
    const beforeAssignment = { ...task.assignment };
    const now = nowIso();
    task.assignment.heartbeatAt = input.heartbeatAt ?? now;
    if (input.leaseExpiresAt !== undefined) {
      task.assignment.leaseExpiresAt = input.leaseExpiresAt;
    }
    task.updatedAt = now;
    board.updatedAt = now;
    event = createKanbanEvent(board.id, task, 'task.assignment.heartbeat', {
      before: beforeAssignment,
      after: { ...task.assignment },
    });
    return task;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

function isAssignmentHeartbeatDue(
  assignment: KanbanAgentAssignment,
  checkedAt: string,
): boolean {
  if (!assignment.heartbeatAt || !assignment.leaseExpiresAt) return false;
  const lastHeartbeat = new Date(assignment.heartbeatAt).getTime();
  const expiresAt = new Date(assignment.leaseExpiresAt).getTime();
  const now = new Date(checkedAt).getTime();
  // Roughly: the worker has not refreshed its heartbeat in at least half the
  // lease window, signalling a probable lapse before the lease expires.
  const lease = expiresAt - lastHeartbeat;
  if (lease <= 0) return true;
  return now - lastHeartbeat >= lease / 2;
}

/**
 * Select a per-task recovery mode for the recovery loop.
 *
 * Rules (in this order; first match wins):
 *   1. `assignment.retryPolicy === 'off'` -> `fail` (worker opted out).
 *   2. `policy.releaseOnFailureKinds` includes `assignment.lastFailureKind` -> `release`.
 *   3. `policy.failWhenCostCeilingSet && assignment.costCeilingUsd !== undefined` -> `fail`.
 *   4. `policy.releaseOnHeartbeatDue && isHeartbeatDue` -> `release`.
 *   5. `assignment.maxAttempts !== undefined && (attempt + 1) > maxAttempts` -> `fail`.
 *   6. Default -> `retry`.
 *
 * Explicit `requested` modes short-circuit the policy entirely, preserving the
 * historical `recover_stale` semantics.
 */
function selectRecoveryMode(args: {
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

export async function recoverStaleTaskAssignments(
  projectRoot: string,
  boardId: string,
  input: RecoverStaleKanbanAssignmentsInput = {},
): Promise<RecoverStaleKanbanAssignmentsResult | null> {
  const recoveredTasks: KanbanTask[] = [];
  const events: KanbanEvent[] = [];
  const requestedMode = input.mode ?? 'retry';
  const checkedAt = input.now ?? nowIso();
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    for (const task of board.tasks) {
      const assignment = task.assignment;
      if (!assignment || (assignment.status !== 'queued' && assignment.status !== 'running')) {
        continue;
      }
      if (!assignment.leaseExpiresAt || assignment.leaseExpiresAt > checkedAt) continue;
      const previousColumnId = task.columnId;
      const beforeAssignment = { ...assignment };
      const isHeartbeatDueNow = isAssignmentHeartbeatDue(assignment, checkedAt);
      const mode = selectRecoveryMode({
        requested: requestedMode,
        task,
        isHeartbeatDue: isHeartbeatDueNow,
        policy: input.policy,
      });
      const reason = input.reason ?? `Stale assignment recovered at ${checkedAt}`;
      const now = nowIso();
      task.notes = [
        ...(task.notes ?? []),
        {
          id: randomUUID(),
          author: 'system',
          content: `Stale assignment recovered (${mode}): ${reason}`,
          createdAt: now,
        },
      ];

      if (mode === 'fail') {
        assignment.status = 'failed';
        assignment.error = reason;
        delete assignment.completedAt;
        task.status = 'failed';
        delete task.completedAt;
      } else if (mode === 'release') {
        delete task.assignment;
        if (input.clearAssignee !== false) {
          delete task.assignedAgent;
          delete task.assignee;
        }
        task.status = areDependenciesMet(board, task.id) ? 'ready' : 'blocked';
        delete task.completedAt;
      } else {
        const nextAttempt = (assignment.attempt ?? 0) + 1;
        if (assignment.maxAttempts !== undefined && nextAttempt > assignment.maxAttempts) {
          assignment.status = 'failed';
          assignment.error = `${reason}; max attempts exceeded (${assignment.maxAttempts})`;
          delete assignment.completedAt;
          task.status = 'failed';
          delete task.completedAt;
        } else {
          task.assignment = {
            ...assignment,
            status: 'assigned',
            attempt: nextAttempt,
          };
          delete task.assignment.subagentId;
          delete task.assignment.runTaskId;
          delete task.assignment.completedAt;
          delete task.assignment.lastResult;
          delete task.assignment.error;
          delete task.assignment.leaseId;
          delete task.assignment.heartbeatAt;
          delete task.assignment.leaseExpiresAt;
          if (input.clearAssignee !== false) {
            delete task.assignedAgent;
            delete task.assignee;
          }
          task.status = areDependenciesMet(board, task.id) ? 'ready' : 'blocked';
          delete task.completedAt;
        }
      }

      syncTaskColumnForStatus(board, task, previousColumnId);
      task.updatedAt = now;
      board.updatedAt = now;
      recoveredTasks.push({ ...task, assignment: task.assignment ? { ...task.assignment } : undefined });
      events.push(
        createKanbanEvent(board.id, task, 'task.stale_recovered', {
          before: beforeAssignment,
          after: task.assignment ? { ...task.assignment } : undefined,
          note: reason,
        }),
      );
    }
    return recoveredTasks.length ? recoveredTasks : null;
  });
  if (updated) {
    for (const staleEvent of events) await emitKanbanEvent(projectRoot, staleEvent);
  }
  return updated?.result ? { board: updated.board, tasks: updated.result } : null;
}

export async function claimReadyTask(
  projectRoot: string,
  input: ClaimKanbanTaskInput = {},
): Promise<{ board: KanbanBoard; task: KanbanTask } | null> {
  if (input.boardId) return claimReadyTaskOnBoard(projectRoot, input.boardId, input);
  for (const board of await listBoards(projectRoot)) {
    const claimed = await claimReadyTaskOnBoard(projectRoot, board.id, input);
    if (claimed) return claimed;
  }
  return null;
}

export async function releaseTaskClaim(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: ReleaseKanbanTaskClaimInput = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const previousColumnId = task.columnId;
    const beforeAssignment = task.assignment ? { ...task.assignment } : undefined;
    delete task.assignment;
    if (input.clearAssignee !== false) {
      delete task.assignedAgent;
      delete task.assignee;
    }
    task.status = input.status ?? (areDependenciesMet(board, task.id) ? 'ready' : 'blocked');
    delete task.completedAt;
    const now = nowIso();
    if (input.reason) {
      task.notes = [
        ...(task.notes ?? []),
        {
          id: randomUUID(),
          author: 'system',
          content: `Claim released: ${input.reason}`,
          createdAt: now,
        },
      ];
    }
    syncTaskColumnForStatus(board, task, previousColumnId);
    task.updatedAt = now;
    board.updatedAt = now;
    event = createKanbanEvent(board.id, task, 'task.released', {
      before: beforeAssignment,
      after: undefined,
      note: input.reason,
    });
    return task;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function getKanbanOrchestrationSnapshot(
  projectRoot: string,
  input: KanbanSearchInput = {},
): Promise<KanbanOrchestrationSnapshot> {
  const boards = input.boardId
    ? [await getBoard(projectRoot, input.boardId)].filter((board): board is KanbanBoard =>
        Boolean(board),
      )
    : await Promise.all(
        (await listBoards(projectRoot)).map((board) => getBoard(projectRoot, board.id)),
      ).then((items) => items.filter((board): board is KanbanBoard => Boolean(board)));
  const snapshot: KanbanOrchestrationSnapshot = {
    generatedAt: nowIso(),
    boards: boards.map((board) => summarizeBoard(board)),
    ready: [],
    queued: [],
    running: [],
    blocked: [],
    review: [],
    failed: [],
    completed: [],
  };
  for (const board of boards) {
    const summary = summarizeBoard(board);
    for (const task of board.tasks) {
      if (!matchesKanbanSearch(board, task, input)) continue;
      const result = { board: summary, task };
      if (isTaskReadyForWork(board, task)) snapshot.ready.push(result);
      if (task.assignment?.status === 'queued' || task.assignment?.status === 'assigned') {
        snapshot.queued.push(result);
      }
      if (task.assignment?.status === 'running' || task.status === 'in_progress') {
        snapshot.running.push(result);
      }
      if (task.status === 'blocked' || !areDependenciesMet(board, task.id)) {
        snapshot.blocked.push(result);
      }
      if (task.status === 'review') snapshot.review.push(result);
      if (task.status === 'failed' || task.assignment?.status === 'failed')
        snapshot.failed.push(result);
      if (task.status === 'completed') snapshot.completed.push(result);
    }
  }
  return snapshot;
}

/**
 * Operational health summary. See `KanbanQueueHealth` for the full contract.
 *
 * Implementation notes:
 *   * Per-status counts are computed against the current state of every
 *     queried board (the same source `getKanbanOrchestrationSnapshot`
 *     consumes).
 *   * `dependencyBlocked` deduplicates `counts.ready` — a task ready but
 *     blocked by dependencies only appears in the blocked bucket.
 *   * `staleAssignments` and `heartbeatDue` use `now ?? real-wall-clock`;
 *     callers (notably the recovery loop) should pass an explicit
 *     timestamp so time is deterministic.
 *   * `lastDispatchedAt` / `lastStaleRecoveredAt` come from the append-only
 *     event log so dashboards do not need to rescan tasks.
 */
export async function getKanbanQueueHealth(
  projectRoot: string,
  input: { boardId?: string; now?: string; heartbeatIntervalMs?: number } = {},
): Promise<KanbanQueueHealth> {
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 60_000;
  const now = input.now ?? nowIso();
  const boards = await collectBoardsForHealth(projectRoot, input.boardId);
  const boardIds = boards.map((board) => board.id);

  const counts = {
    ready: 0,
    queued: 0,
    running: 0,
    review: 0,
    failed: 0,
    completed: 0,
    pending: 0,
    archived: 0,
    blocked: 0,
  };
  const dependencyBlocked: KanbanSearchResult[] = [];
  const staleAssignments: KanbanSearchResult[] = [];
  const failedRetryable: KanbanSearchResult[] = [];
  const heartbeatDue: KanbanSearchResult[] = [];

  for (const board of boards) {
    const summary = summarizeBoard(board);
    for (const task of board.tasks) {
      const assignment = task.assignment;
      const dependencyUnmet = !areDependenciesMet(board, task.id);
      const isRunning =
        task.status === 'in_progress' ||
        (assignment !== undefined && assignment.status === 'running');
      const isQueued =
        assignment !== undefined &&
        (assignment.status === 'queued' || assignment.status === 'assigned');
      if (task.status === 'ready' && !isRunning) {
        counts.ready += 1;
      } else {
        counts[task.status as keyof typeof counts] += 1;
      }
      if (isRunning) counts.running += 1;
      if (isQueued) counts.queued += 1;
      const readyButBlocked = task.status === 'ready' && dependencyUnmet;
      const pendingButBlocked = task.status === 'pending' && dependencyUnmet;
      if (readyButBlocked || pendingButBlocked) {
        dependencyBlocked.push({ board: summary, task });
      }
      const expiredLease =
        assignment !== undefined &&
        (assignment.status === 'queued' || assignment.status === 'running') &&
        assignment.leaseExpiresAt !== undefined &&
        assignment.leaseExpiresAt <= now;
      if (expiredLease) {
        staleAssignments.push({ board: summary, task });
      }
      if (
        assignment &&
        assignment.status === 'running' &&
        assignment.leaseExpiresAt !== undefined &&
        msUntilExpiry(assignment.leaseExpiresAt, now) <= heartbeatIntervalMs
      ) {
        heartbeatDue.push({ board: summary, task });
      }
      if (
        task.status === 'failed' &&
        assignment &&
        assignment.maxAttempts !== undefined &&
        (assignment.attempt ?? 0) < assignment.maxAttempts
      ) {
        failedRetryable.push({ board: summary, task });
      }
    }
  }

  let lastDispatchedAt: string | undefined;
  let lastStaleRecoveredAt: string | undefined;
  for (const boardId of boardIds) {
    const events = await readKanbanEvents(projectRoot, boardId);
    for (const event of events) {
      if (event.type === 'task.assignment.running') {
        lastDispatchedAt = later(lastDispatchedAt, event.ts);
      } else if (event.type === 'task.stale_recovered') {
        lastStaleRecoveredAt = later(lastStaleRecoveredAt, event.ts);
      }
    }
  }

  return {
    generatedAt: now,
    boardIds,
    counts,
    dependencyBlocked: { count: dependencyBlocked.length, tasks: dependencyBlocked },
    staleAssignments: { count: staleAssignments.length, tasks: staleAssignments },
    failedRetryable: { count: failedRetryable.length, tasks: failedRetryable },
    heartbeatDue: { count: heartbeatDue.length, tasks: heartbeatDue },
    ...(lastDispatchedAt !== undefined ? { lastDispatchedAt } : {}),
    ...(lastStaleRecoveredAt !== undefined ? { lastStaleRecoveredAt } : {}),
  };
}

function msUntilExpiry(leaseExpiresAt: string, nowIso: string): number {
  return new Date(leaseExpiresAt).getTime() - new Date(nowIso).getTime();
}

function later(a: string | undefined, b: string): string {
  if (a === undefined) return b;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

async function collectBoardsForHealth(
  projectRoot: string,
  boardId: string | undefined,
): Promise<KanbanBoard[]> {
  if (boardId !== undefined) {
    const board = await getBoard(projectRoot, boardId);
    return board ? [board] : [];
  }
  const summaries = await listBoardSummaries(projectRoot);
  const out: KanbanBoard[] = [];
  for (const summary of summaries) {
    const board = await getBoard(projectRoot, summary.id);
    if (board) out.push(board);
  }
  return out;
}

export async function addDependency(
  projectRoot: string,
  boardId: string,
  taskId: string,
  dependencyTaskId: string,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    const dependency = findTask(board, dependencyTaskId);
    if (!task || !dependency) return null;
    addDependencyToTask(board, task, dependency);
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    return task;
  });
  return updated?.result ? updated.board : null;
}

export async function splitTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: SplitKanbanTaskInput,
): Promise<{ board: KanbanBoard; parent: KanbanTask; children: KanbanTask[] } | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const parent = findTask(board, taskId);
    if (!parent) return null;
    const titles = input.titles.map((title) => requireNonBlank(title, 'Kanban split task title'));
    if (!titles.length) throw new Error('splitTask requires at least one child title.');
    const columnId = existingColumnId(board, input.columnId ?? parent.columnId);
    if (!columnId) throw new Error(`Column not found: ${input.columnId ?? parent.columnId}`);
    const children: KanbanTask[] = [];
    const startOrder = nextTaskOrder(board, columnId);
    for (let index = 0; index < titles.length; index++) {
      const title = titles[index];
      if (!title) continue;
      const child = createTaskObject(board, {
        title,
        columnId,
        order: startOrder + index,
        priority: parent.priority,
        parentTaskId: parent.id,
        ...(parent.description !== undefined ? { description: parent.description } : {}),
        ...(input.inheritAssignment === true && parent.assignedAgent !== undefined
          ? { assignedAgent: parent.assignedAgent }
          : {}),
        ...(input.inheritAssignment === true && parent.assignee !== undefined
          ? { assignee: parent.assignee }
          : {}),
        ...(input.inheritAssignment === true && parent.assignment !== undefined
          ? { assignment: { ...parent.assignment } }
          : {}),
        ...(input.inheritLabels !== false && parent.labels !== undefined
          ? { labels: [...parent.labels] }
          : {}),
        ...(input.inheritDependencies !== false && parent.dependsOn?.length
          ? { dependsOn: [...parent.dependsOn] }
          : {}),
        ...(input.inheritSuccessCriteria === true && parent.successCriteria !== undefined
          ? { successCriteria: cloneChecks(parent.successCriteria) }
          : {}),
        ...(input.inheritGoalMetrics === true && parent.goalMetrics !== undefined
          ? { goalMetrics: cloneGoalMetrics(parent.goalMetrics) }
          : {}),
      });
      children.push(child);
      board.tasks.push(child);
    }
    if (!children.length) throw new Error('splitTask requires at least one child title.');
    parent.childTaskIds = uniqueStrings([
      ...(parent.childTaskIds ?? []),
      ...children.map((t) => t.id),
    ]);
    const now = nowIso();
    parent.updatedAt = now;
    if (input.rewireDependents !== false) {
      rewireDependents(
        board,
        parent.id,
        children.map((child) => child.id),
      );
    }
    if (input.chainChildren === true) {
      setChainMetadata(board, children, randomUUID(), input.inheritDependencies !== false);
    }
    normalizeColumnTaskOrders(board, columnId);
    board.updatedAt = now;
    return { parent, children };
  });
  return updated?.result ? { board: updated.board, ...updated.result } : null;
}

export async function mergeTasks(
  projectRoot: string,
  boardId: string,
  input: MergeKanbanTasksInput,
): Promise<{ board: KanbanBoard; task: KanbanTask; sourceTasks: KanbanTask[] } | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const sourceTasks = resolveTaskRefs(board, input.taskIds);
    if (sourceTasks.length < 2) throw new Error('mergeTasks requires at least two tasks.');
    const sourceIds = new Set(sourceTasks.map((task) => task.id));
    const columnId = existingColumnId(board, input.targetColumnId ?? sourceTasks[0]?.columnId);
    if (!columnId) throw new Error(`Column not found: ${input.targetColumnId ?? ''}`);
    const dependencies = uniqueStrings(
      sourceTasks.flatMap((task) => task.dependsOn ?? []).filter((depId) => !sourceIds.has(depId)),
    );
    const merged = createTaskObject(board, {
      title: input.title,
      description: input.description ?? mergedTaskDescription(sourceTasks),
      columnId,
      priority: highestPriority(sourceTasks),
      labels: uniqueStrings(sourceTasks.flatMap((task) => task.labels ?? [])),
      ...(dependencies.length ? { dependsOn: dependencies } : {}),
      ...(input.preserveAssignment === true && sourceTasks[0]?.assignedAgent !== undefined
        ? { assignedAgent: sourceTasks[0].assignedAgent }
        : {}),
      ...(input.preserveAssignment === true && sourceTasks[0]?.assignee !== undefined
        ? { assignee: sourceTasks[0].assignee }
        : {}),
      ...(input.preserveAssignment === true && sourceTasks[0]?.assignment !== undefined
        ? { assignment: { ...sourceTasks[0].assignment } }
        : {}),
      successCriteria: sourceTasks.flatMap((task) => cloneChecks(task.successCriteria ?? [])),
      goalMetrics: sourceTasks.flatMap((task) => cloneGoalMetrics(task.goalMetrics ?? [])),
    });
    merged.mergedFromTaskIds = [...sourceIds];
    board.tasks.push(merged);
    placeTaskInColumn(board, merged, merged.columnId, merged.order);

    const now = nowIso();
    for (const source of sourceTasks) {
      source.mergedIntoTaskId = merged.id;
      if (input.closeSourceTasks !== false) {
        source.status = 'archived';
        delete source.completedAt;
      }
      source.updatedAt = now;
    }
    rewireDependents(board, [...sourceIds], [merged.id], [merged.id, ...sourceIds]);
    board.updatedAt = now;
    return { task: merged, sourceTasks };
  });
  return updated?.result ? { board: updated.board, ...updated.result } : null;
}

export async function setTaskChain(
  projectRoot: string,
  boardId: string,
  input: SetKanbanTaskChainInput,
): Promise<{ board: KanbanBoard; chainId: string; tasks: KanbanTask[] } | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const tasks = resolveTaskRefs(board, input.taskIds);
    if (!tasks.length) throw new Error('setTaskChain requires at least one task.');
    const chainId = input.chainId ?? randomUUID();
    const previousChainIds = uniqueStrings(
      tasks.map((task) => task.chain?.chainId).filter((id): id is string => Boolean(id)),
    );
    setChainMetadata(board, tasks, chainId, input.enforceDependencies !== false);
    for (const previousChainId of previousChainIds) {
      if (previousChainId !== chainId) normalizeChainMetadata(board, previousChainId);
    }
    const now = nowIso();
    for (const task of tasks) task.updatedAt = now;
    board.updatedAt = now;
    return { chainId, tasks };
  });
  return updated?.result ? { board: updated.board, ...updated.result } : null;
}

export async function getTaskChain(
  projectRoot: string,
  boardId: string,
  taskOrChainId: string,
): Promise<{ board: KanbanBoard; chainId: string; tasks: KanbanTask[] } | null> {
  const board = await readBoard(projectRoot, boardId);
  if (!board) return null;
  const directChainTasks = tasksInChain(board, taskOrChainId);
  if (directChainTasks.length) return { board, chainId: taskOrChainId, tasks: directChainTasks };
  const task = findTask(board, taskOrChainId);
  const chainId = task?.chain?.chainId ?? taskOrChainId;
  const tasks = tasksInChain(board, chainId);
  return tasks.length ? { board, chainId, tasks } : null;
}

export async function addGoalMetricToTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  metric: AddKanbanGoalMetricInput,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const now = nowIso();
    const nextMetric: KanbanGoalMetric = {
      id: randomUUID(),
      name: requireNonBlank(metric.name, 'Kanban goal metric name'),
      status: metric.status ?? 'pending',
      updatedAt: now,
      ...(metric.target !== undefined ? { target: metric.target } : {}),
      ...(metric.current !== undefined ? { current: metric.current } : {}),
      ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
      ...(metric.notes !== undefined ? { notes: metric.notes } : {}),
    };
    task.goalMetrics = [...(task.goalMetrics ?? []), nextMetric];
    task.updatedAt = now;
    board.updatedAt = now;
    return nextMetric;
  });
  return updated?.result ? updated.board : null;
}

export async function updateGoalMetricOnTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  metricId: string,
  patch: UpdateKanbanGoalMetricInput,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    const metric = task ? findGoalMetric(task.goalMetrics ?? [], metricId) : undefined;
    if (!task || !metric) return null;
    if (patch.name !== undefined)
      metric.name = requireNonBlank(patch.name, 'Kanban goal metric name');
    if (patch.status !== undefined) metric.status = patch.status;
    if (patch.target !== undefined) metric.target = patch.target;
    if (patch.current !== undefined) metric.current = patch.current;
    if (patch.unit !== undefined) metric.unit = patch.unit;
    if (patch.notes !== undefined) metric.notes = patch.notes;
    const now = nowIso();
    metric.updatedAt = now;
    task.updatedAt = now;
    board.updatedAt = now;
    return metric;
  });
  return updated?.result ? updated.board : null;
}

export async function addCheckToTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  check: Omit<KanbanCheck, 'id' | 'status'> & { status?: KanbanCheckStatus | undefined },
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const newCheck: KanbanCheck = {
      id: randomUUID(),
      description: check.description,
      type: check.type,
      status: check.status ?? 'pending',
      ...(check.checkedBy !== undefined ? { checkedBy: check.checkedBy } : {}),
      ...(check.checkedAt !== undefined ? { checkedAt: check.checkedAt } : {}),
      ...(check.notes !== undefined ? { notes: check.notes } : {}),
    };
    task.successCriteria = [...(task.successCriteria ?? []), newCheck];
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    return newCheck;
  });
  return updated?.result ? updated.board : null;
}

export async function updateCheckOnTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  checkId: string,
  patch: Partial<Omit<KanbanCheck, 'id'>>,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    const check = task?.successCriteria?.find((candidate) => candidate.id === checkId);
    if (!task || !check) return null;
    Object.assign(check, patch);
    if (patch.status && patch.status !== 'pending' && !check.checkedAt) {
      check.checkedAt = nowIso();
    }
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    return check;
  });
  return updated?.result ? updated.board : null;
}

export async function addNoteToTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  note: { author: string; content: string },
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const newNote: KanbanNote = {
      id: randomUUID(),
      author: note.author,
      content: note.content,
      createdAt: nowIso(),
    };
    task.notes = [...(task.notes ?? []), newNote];
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    return newNote;
  });
  return updated?.result ? updated.board : null;
}

export async function addLinkToTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  link: KanbanLink,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    task.links = [...(task.links ?? []), link];
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    return link;
  });
  return updated?.result ? updated.board : null;
}

export function generateBoardFromDescription(input: KanbanGenerationInput): CreateKanbanBoardInput {
  const title =
    input.title ??
    `Kanban: ${input.description.slice(0, 60)}${input.description.length > 60 ? '...' : ''}`;
  const columnTitles = input.columns?.length
    ? input.columns
    : DEFAULT_COLUMNS.slice(0, input.columnCount ?? 4).map((column) => column.title);
  return {
    title,
    description: input.context
      ? `${input.description}\n\nContext: ${input.context}`
      : input.description,
    columns: columnTitles.map((columnTitle, index) => ({
      id: slugify(columnTitle) || `column-${index + 1}`,
      title: columnTitle,
      order: index,
      wipLimit: 0,
    })),
    tasks: [],
  };
}

export interface CreateKanbanBoardFromTaskGraphOptions {
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  generatedBy?: string | undefined;
  sourceSystem?: string | undefined;
  phaseId?: string | undefined;
  includeCompletedTasks?: boolean | undefined;
}

export async function createBoardFromTaskGraph(
  projectRoot: string,
  graph: TaskGraph,
  options: CreateKanbanBoardFromTaskGraphOptions = {},
): Promise<{ board: KanbanBoard; taskIdMap: Map<string, string> }> {
  const board = createBoardObject({
    title: requireNonBlank(options.title ?? graph.title, 'Kanban board title'),
    description: options.description ?? `Imported from task graph ${graph.id}`,
    tags: uniqueStrings([...(options.tags ?? []), options.sourceSystem ?? 'task-graph', graph.id]),
    generatedBy: options.generatedBy ?? `${options.sourceSystem ?? 'task-graph'}:${graph.id}`,
    columns: DEFAULT_COLUMNS.map((column) => ({ ...column })),
  });
  const taskIdMap = new Map<string, string>();
  const nodes = Array.from(graph.nodes.values())
    .filter((node) => options.includeCompletedTasks !== false || node.status !== 'completed')
    .sort((a, b) => a.createdAt - b.createdAt || a.title.localeCompare(b.title));
  for (const node of nodes) {
    const task = createTaskObject(board, {
      title: node.title,
      description: node.description,
      columnId: columnIdForTaskGraphStatus(board, node.status),
      priority: node.priority,
      status: taskGraphStatusToKanbanStatus(node.status),
      assignee: node.assignee,
      estimatedHours: node.estimateHours,
      actualHours: node.actualHours,
      labels: node.tags,
      parentTaskId: node.parentId,
      childTaskIds: node.children,
      origin: {
        system: options.sourceSystem ?? 'task-graph',
        graphId: graph.id,
        taskId: node.id,
        specId: graph.specId,
        ...(options.phaseId !== undefined ? { phaseId: options.phaseId } : {}),
      },
    });
    board.tasks.push(task);
    taskIdMap.set(node.id, task.id);
  }
  for (const task of board.tasks) {
    if (task.parentTaskId)
      task.parentTaskId = taskIdMap.get(task.parentTaskId) ?? task.parentTaskId;
    if (task.childTaskIds?.length) {
      task.childTaskIds = task.childTaskIds
        .map((childId) => taskIdMap.get(childId))
        .filter((childId): childId is string => Boolean(childId));
      if (!task.childTaskIds.length) delete task.childTaskIds;
    }
  }
  for (const edge of graph.edges) {
    if (edge.type !== 'depends_on' && edge.type !== 'blocks') continue;
    const dependencyId = taskIdMap.get(edge.from);
    const taskId = taskIdMap.get(edge.to);
    const task = taskId ? board.tasks.find((candidate) => candidate.id === taskId) : undefined;
    if (!dependencyId || !task) continue;
    task.dependsOn = uniqueStrings([...(task.dependsOn ?? []), dependencyId]);
  }
  normalizeAllColumnTaskOrders(board);
  await writeBoard(projectRoot, board);
  return { board, taskIdMap };
}

export interface SyncKanbanBoardFromTaskGraphOptions extends CreateKanbanBoardFromTaskGraphOptions {
  archiveMissingTasks?: boolean | undefined;
  preserveManualDependencies?: boolean | undefined;
}

export async function syncBoardFromTaskGraph(
  projectRoot: string,
  boardId: string,
  graph: TaskGraph,
  options: SyncKanbanBoardFromTaskGraphOptions = {},
): Promise<{
  board: KanbanBoard;
  taskIdMap: Map<string, string>;
  createdTaskIds: string[];
  updatedTaskIds: string[];
  archivedTaskIds: string[];
} | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const now = nowIso();
    const sourceSystem = options.sourceSystem ?? 'task-graph';
    const nodes = Array.from(graph.nodes.values())
      .filter((node) => options.includeCompletedTasks !== false || node.status !== 'completed')
      .sort((a, b) => a.createdAt - b.createdAt || a.title.localeCompare(b.title));
    const taskIdMap = new Map<string, string>();
    const createdTaskIds: string[] = [];
    const updatedTaskIds: string[] = [];
    const syncedTaskIds = new Set<string>();

    if (options.title !== undefined)
      board.title = requireNonBlank(options.title, 'Kanban board title');
    if (options.description !== undefined) board.description = options.description;
    if (options.tags !== undefined) board.tags = options.tags;
    board.generatedBy = options.generatedBy ?? `${sourceSystem}:${graph.id}`;

    for (const node of nodes) {
      let task = findTaskByOrigin(board, graph.id, node.id, options.phaseId);
      if (!task) {
        task = createTaskObject(board, taskInputFromGraphNode(board, graph, node, options));
        board.tasks.push(task);
        placeTaskInColumn(board, task, task.columnId, task.order);
        createdTaskIds.push(task.id);
      } else {
        applyGraphNodeToTask(board, graph, task, node, options, now);
        updatedTaskIds.push(task.id);
      }
      syncedTaskIds.add(task.id);
      taskIdMap.set(node.id, task.id);
    }

    applyTaskGraphRelationships(board, graph, taskIdMap, {
      preserveManualDependencies: options.preserveManualDependencies !== false,
    });

    const archivedTaskIds: string[] = [];
    if (options.archiveMissingTasks !== false) {
      const syncedSourceTaskIds = new Set(nodes.map((node) => node.id));
      for (const task of board.tasks) {
        if (!isTaskFromGraph(task, graph.id, options.phaseId)) continue;
        if (syncedSourceTaskIds.has(task.origin?.taskId ?? '')) continue;
        if (task.status === 'archived') continue;
        task.status = 'archived';
        delete task.assignment;
        delete task.completedAt;
        task.updatedAt = now;
        archivedTaskIds.push(task.id);
      }
    }

    assertNoDependencyCycles(board);
    normalizeAllColumnTaskOrders(board);
    board.updatedAt = now;
    return { taskIdMap, createdTaskIds, updatedTaskIds, archivedTaskIds };
  });

  return updated ? { board: updated.board, ...updated.result } : null;
}

export interface ExportKanbanBoardToTaskGraphOptions {
  graphId?: string | undefined;
  specId?: string | undefined;
  title?: string | undefined;
  preserveOriginTaskIds?: boolean | undefined;
  includeArchived?: boolean | undefined;
}

export async function exportBoardToTaskGraph(
  projectRoot: string,
  boardId: string,
  options: ExportKanbanBoardToTaskGraphOptions = {},
): Promise<{ board: KanbanBoard; graph: TaskGraph; taskIdMap: Map<string, string> } | null> {
  const board = await readBoard(projectRoot, boardId);
  if (!board) return null;
  const exported = buildTaskGraphFromKanbanBoard(board, options);
  return { board, ...exported };
}

export function buildTaskGraphFromKanbanBoard(
  board: KanbanBoard,
  options: ExportKanbanBoardToTaskGraphOptions = {},
): { graph: TaskGraph; taskIdMap: Map<string, string> } {
  const includedTasks = board.tasks.filter(
    (task) => options.includeArchived === true || task.status !== 'archived',
  );
  const firstOrigin = includedTasks.find(
    (task) => task.origin?.graphId || task.origin?.specId,
  )?.origin;
  const graphId = options.graphId ?? firstOrigin?.graphId ?? `kanban:${board.id}`;
  const specId = options.specId ?? firstOrigin?.specId ?? board.id;
  const createdAt = parseIsoTimestamp(board.createdAt, Date.now());
  const updatedAt = parseIsoTimestamp(board.updatedAt, createdAt);
  const taskIdMap = new Map<string, string>();
  const usedNodeIds = new Set<string>();

  for (const task of includedTasks) {
    const preferred =
      options.preserveOriginTaskIds !== false && task.origin?.taskId
        ? task.origin.taskId
        : `kanban-${task.id}`;
    taskIdMap.set(task.id, uniqueIdFromSet(usedNodeIds, preferred));
  }

  const graph: TaskGraph = {
    id: graphId,
    specId,
    title: options.title ?? board.title,
    nodes: new Map<string, TaskNode>(),
    edges: [],
    rootNodes: [],
    createdAt,
    updatedAt,
  };

  for (const task of includedTasks) {
    const nodeId = taskIdMap.get(task.id);
    if (!nodeId) continue;
    const node = taskToTaskGraphNode(board, task, nodeId, taskIdMap, {
      graphId,
      specId,
      createdAt,
    });
    graph.nodes.set(nodeId, node);
  }

  graph.edges = taskGraphEdgesFromBoard(includedTasks, taskIdMap);
  const hasIncoming = new Set(graph.edges.map((edge) => edge.to));
  graph.rootNodes = Array.from(graph.nodes.keys()).filter((nodeId) => !hasIncoming.has(nodeId));
  if (!graph.rootNodes.length) graph.rootNodes = Array.from(graph.nodes.keys()).slice(0, 1);
  return { graph, taskIdMap };
}

export interface CreateKanbanBoardsFromPhaseGraphOptions {
  includeCompletedTasks?: boolean | undefined;
}

export async function createBoardsFromPhaseGraph(
  projectRoot: string,
  graph: PhaseGraph,
  options: CreateKanbanBoardsFromPhaseGraphOptions = {},
): Promise<Array<{ phase: PhaseNode; board: KanbanBoard; taskIdMap: Map<string, string> }>> {
  const phases = Array.from(graph.phases.values()).sort(
    (a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name),
  );
  const boards: Array<{ phase: PhaseNode; board: KanbanBoard; taskIdMap: Map<string, string> }> =
    [];
  for (const phase of phases) {
    const imported = await createBoardFromTaskGraph(projectRoot, phase.taskGraph, {
      title: `${graph.title}: ${phase.name}`,
      description: phase.description,
      tags: uniqueStrings(['autophase', graph.id, phase.id]),
      generatedBy: `autophase:${graph.id}:${phase.id}`,
      sourceSystem: 'autophase',
      phaseId: phase.id,
      includeCompletedTasks: options.includeCompletedTasks,
    });
    boards.push({ phase, ...imported });
  }
  return boards;
}

export function parseLinesIntoTasks(
  description: string,
  targetColumnId = 'backlog',
): CreateKanbanTaskInput[] {
  return description
    .split('\n')
    .map((line) => line.replace(/^\s*[-*#]\s*/, '').trim())
    .filter(Boolean)
    .map((title) => ({
      title,
      columnId: targetColumnId,
      priority: 'medium' as KanbanTaskPriority,
    }));
}

export async function searchKanban(
  projectRoot: string,
  input: KanbanSearchInput = {},
): Promise<KanbanSearchResult[]> {
  const boardIds = input.boardId
    ? [input.boardId]
    : (await listBoards(projectRoot)).map((b) => b.id);
  const results: KanbanSearchResult[] = [];
  for (const boardId of boardIds) {
    const board = await readBoard(projectRoot, boardId);
    if (!board) continue;
    for (const task of board.tasks) {
      if (!matchesKanbanSearch(board, task, input)) continue;
      results.push({ board: summarizeBoard(board), task });
    }
  }
  return results;
}

export async function listReadyTasks(
  projectRoot: string,
  input: KanbanSearchInput & { limit?: number | undefined } = {},
): Promise<KanbanSearchResult[]> {
  const results = await searchKanban(projectRoot, { ...input, readyOnly: true });
  return input.limit && input.limit > 0 ? results.slice(0, input.limit) : results;
}

export function areDependenciesMet(board: KanbanBoard, taskId: string): boolean {
  const task = findTask(board, taskId);
  if (!task?.dependsOn?.length) return true;
  return task.dependsOn.every((depId) => {
    const depTask = board.tasks.find((candidate) => candidate.id === depId);
    return depTask?.status === 'completed';
  });
}

export function findBlockedTasks(board: KanbanBoard, taskId: string): KanbanTask[] {
  const sourceTask = findTask(board, taskId);
  if (!sourceTask) return [];
  return board.tasks.filter(
    (task) => task.dependsOn?.includes(sourceTask.id) && task.status !== 'completed',
  );
}

export function exportBoardAsMarkdown(board: KanbanBoard): string {
  const lines: string[] = [`# ${board.title}`];
  if (board.description) lines.push('', board.description);
  if (board.tags?.length) lines.push('', `Tags: ${board.tags.map((tag) => `#${tag}`).join(' ')}`);
  for (const column of [...board.columns].sort((a, b) => a.order - b.order)) {
    lines.push('', `## ${column.title}`, '');
    const tasks = board.tasks
      .filter((task) => task.columnId === column.id)
      .sort((a, b) => a.order - b.order);
    if (!tasks.length) {
      lines.push('_Empty_');
      continue;
    }
    for (const task of tasks) {
      const checked = task.status === 'completed' ? 'x' : ' ';
      const assignee = task.assignedAgent ? ` @${task.assignedAgent}` : '';
      const priority = task.priority !== 'medium' ? ` !${task.priority}` : '';
      lines.push(`- [${checked}] ${task.title}${assignee}${priority}`);
      if (task.description) lines.push(`  ${task.description}`);
      if (task.assignment?.provider || task.assignment?.model || task.assignment?.fallbackProfile) {
        lines.push(
          `  agent: ${[
            task.assignment.provider,
            task.assignment.model,
            task.assignment.fallbackProfile ? `fallback=${task.assignment.fallbackProfile}` : '',
          ]
            .filter(Boolean)
            .join(' / ')}`,
        );
      }
      for (const check of task.successCriteria ?? []) {
        lines.push(`  - [${check.status === 'passed' ? 'x' : ' '}] ${check.description}`);
      }
    }
  }
  lines.push('', `---`, `Exported from WrongStack Kanban: ${board.id}`);
  return lines.join('\n');
}

function normalizeColumns(columns: KanbanColumn[] | undefined): KanbanColumn[] {
  const source = columns?.length ? columns : DEFAULT_COLUMNS;
  const usedIds = new Set<string>();
  return source
    .map((column, index) => ({
      ...column,
      id: uniqueIdFromSet(usedIds, slugify(column.id || column.title) || `column-${index + 1}`),
      title: requireNonBlank(column.title, 'Kanban column title'),
      order: column.order ?? index,
    }))
    .sort((a, b) => a.order - b.order)
    .map((column, index) => ({ ...column, order: index }));
}

function createTaskObject(board: KanbanBoard, input: CreateKanbanTaskInput): KanbanTask {
  const now = nowIso();
  const columnId = existingColumnId(board, input.columnId) ?? board.columns[0]?.id ?? 'backlog';
  const order =
    input.order ??
    board.tasks
      .filter((task) => task.columnId === columnId)
      .reduce((max, task) => Math.max(max, task.order), -1) + 1;
  const task: KanbanTask = {
    id: randomUUID(),
    title: requireNonBlank(input.title, 'Kanban task title'),
    columnId,
    order,
    priority: input.priority ?? 'medium',
    status: input.status ?? statusForColumn(columnId),
    createdAt: now,
    updatedAt: now,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.assignedAgent !== undefined ? { assignedAgent: input.assignedAgent } : {}),
    ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
    ...(input.assignment !== undefined ? { assignment: input.assignment } : {}),
    ...(input.dependsOn !== undefined
      ? optionalArray('dependsOn', normalizeDependencyIds(board, '', input.dependsOn))
      : {}),
    ...(input.chain !== undefined ? { chain: { ...input.chain } } : {}),
    ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.childTaskIds !== undefined ? optionalArray('childTaskIds', input.childTaskIds) : {}),
    ...(input.mergedIntoTaskId !== undefined ? { mergedIntoTaskId: input.mergedIntoTaskId } : {}),
    ...(input.mergedFromTaskIds !== undefined
      ? optionalArray('mergedFromTaskIds', input.mergedFromTaskIds)
      : {}),
    ...(input.origin !== undefined ? { origin: { ...input.origin } } : {}),
    ...(input.labels !== undefined ? { labels: input.labels } : {}),
    ...(input.estimatedHours !== undefined ? { estimatedHours: input.estimatedHours } : {}),
    ...(input.actualHours !== undefined ? { actualHours: input.actualHours } : {}),
    ...(input.successCriteria !== undefined ? { successCriteria: input.successCriteria } : {}),
    ...(input.goalMetrics !== undefined ? { goalMetrics: input.goalMetrics } : {}),
    ...(input.links !== undefined ? { links: input.links } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    // Sprint 3: mirror policy fields from assignment to durable task level.
    ...(input.assignment?.retryPolicy !== undefined
      ? { retryPolicy: input.assignment.retryPolicy }
      : {}),
    ...(input.assignment?.costCeilingUsd !== undefined
      ? { costCeilingUsd: input.assignment.costCeilingUsd }
      : {}),
  };
  applyCompletedAtForStatus(task, now);
  return task;
}

function cloneTaskForBoard(
  board: KanbanBoard,
  source: KanbanTask,
  options: CopyKanbanTaskOptions,
): KanbanTask {
  const now = nowIso();
  const columnId =
    existingColumnId(board, options.targetColumnId ?? source.columnId) ??
    board.columns[0]?.id ??
    'backlog';
  const order =
    options.targetOrder ??
    board.tasks
      .filter((task) => task.columnId === columnId)
      .reduce((max, task) => Math.max(max, task.order), -1) + 1;
  const task: KanbanTask = {
    id: randomUUID(),
    title: source.title,
    columnId,
    order,
    priority: source.priority,
    status: source.status,
    createdAt: now,
    updatedAt: now,
    ...(source.description !== undefined ? { description: source.description } : {}),
    ...(source.assignedAgent !== undefined && options.preserveAssignment === true
      ? { assignedAgent: source.assignedAgent }
      : {}),
    ...(source.assignee !== undefined && options.preserveAssignment === true
      ? { assignee: source.assignee }
      : {}),
    ...(source.assignment !== undefined && options.preserveAssignment === true
      ? { assignment: { ...source.assignment } }
      : {}),
    ...(source.dependsOn !== undefined && options.preserveDependencies === true
      ? { dependsOn: [...source.dependsOn] }
      : {}),
    ...(source.chain !== undefined && options.preserveDependencies === true
      ? { chain: { ...source.chain } }
      : {}),
    ...(source.parentTaskId !== undefined && options.preserveDependencies === true
      ? { parentTaskId: source.parentTaskId }
      : {}),
    ...(source.childTaskIds !== undefined && options.preserveDependencies === true
      ? { childTaskIds: [...source.childTaskIds] }
      : {}),
    ...(source.mergedIntoTaskId !== undefined && options.preserveDependencies === true
      ? { mergedIntoTaskId: source.mergedIntoTaskId }
      : {}),
    ...(source.mergedFromTaskIds !== undefined && options.preserveDependencies === true
      ? { mergedFromTaskIds: [...source.mergedFromTaskIds] }
      : {}),
    ...(source.origin !== undefined ? { origin: { ...source.origin } } : {}),
    ...(source.labels !== undefined ? { labels: [...source.labels] } : {}),
    ...(source.estimatedHours !== undefined ? { estimatedHours: source.estimatedHours } : {}),
    ...(source.actualHours !== undefined ? { actualHours: source.actualHours } : {}),
    ...(source.successCriteria !== undefined
      ? { successCriteria: source.successCriteria.map((check) => ({ ...check, id: randomUUID() })) }
      : {}),
    ...(source.goalMetrics !== undefined
      ? { goalMetrics: cloneGoalMetrics(source.goalMetrics) }
      : {}),
    ...(source.links !== undefined ? { links: source.links.map((link) => ({ ...link })) } : {}),
    ...(source.notes !== undefined
      ? { notes: source.notes.map((note) => ({ ...note, id: randomUUID(), createdAt: now })) }
      : {}),
  };
  if (source.completedAt !== undefined && task.status === 'completed') {
    task.completedAt = source.completedAt;
  } else {
    applyCompletedAtForStatus(task, now);
  }
  return task;
}

function applyTaskPatch(board: KanbanBoard, task: KanbanTask, input: UpdateKanbanTaskInput): void {
  const now = nowIso();
  const previousColumnId = task.columnId;
  let shouldReorder = false;
  if (input.title !== undefined) task.title = requireNonBlank(input.title, 'Kanban task title');
  if (input.description !== undefined) task.description = input.description;
  if (input.columnId !== undefined) {
    const columnId = existingColumnId(board, input.columnId);
    if (!columnId) throw new Error(`Column not found: ${input.columnId}`);
    task.columnId = columnId;
    if (input.status === undefined) task.status = statusForColumn(columnId);
    if (previousColumnId !== columnId) shouldReorder = true;
  }
  if (input.order !== undefined) {
    task.order = input.order;
    shouldReorder = true;
  } else if (shouldReorder) {
    task.order = nextTaskOrder(board, task.columnId, task.id);
  }
  if (input.priority !== undefined) task.priority = input.priority;
  if (input.status !== undefined) {
    task.status = input.status;
  }
  applyCompletedAtForStatus(task, now);
  if (input.assignedAgent !== undefined) {
    if (input.assignedAgent === null) delete task.assignedAgent;
    else task.assignedAgent = input.assignedAgent;
  }
  if (input.assignee !== undefined) {
    if (input.assignee === null) delete task.assignee;
    else task.assignee = input.assignee;
  }
  if (input.assignment !== undefined) {
    if (input.assignment === null) delete task.assignment;
    else task.assignment = input.assignment;
  }
  if (input.dependsOn !== undefined) {
    const dependsOn = normalizeDependencyIds(board, task.id, input.dependsOn);
    if (dependsOn.length) task.dependsOn = dependsOn;
    else delete task.dependsOn;
  }
  if (input.chain !== undefined) {
    if (input.chain === null) delete task.chain;
    else task.chain = { ...input.chain };
  }
  if (input.parentTaskId !== undefined) {
    if (input.parentTaskId === null) delete task.parentTaskId;
    else task.parentTaskId = input.parentTaskId;
  }
  if (input.childTaskIds !== undefined) {
    task.childTaskIds = uniqueStrings(input.childTaskIds);
    if (task.childTaskIds.length === 0) delete task.childTaskIds;
  }
  if (input.mergedIntoTaskId !== undefined) {
    if (input.mergedIntoTaskId === null) delete task.mergedIntoTaskId;
    else task.mergedIntoTaskId = input.mergedIntoTaskId;
  }
  if (input.mergedFromTaskIds !== undefined) {
    task.mergedFromTaskIds = uniqueStrings(input.mergedFromTaskIds);
    if (task.mergedFromTaskIds.length === 0) delete task.mergedFromTaskIds;
  }
  if (input.origin !== undefined) {
    if (input.origin === null) delete task.origin;
    else task.origin = { ...input.origin };
  }
  if (input.labels !== undefined) task.labels = input.labels;
  if (input.estimatedHours !== undefined) task.estimatedHours = input.estimatedHours;
  if (input.actualHours !== undefined) task.actualHours = input.actualHours;
  if (input.successCriteria !== undefined) task.successCriteria = input.successCriteria;
  if (input.goalMetrics !== undefined) task.goalMetrics = input.goalMetrics;
  if (input.links !== undefined) task.links = input.links;
  if (shouldReorder) {
    if (previousColumnId !== task.columnId) normalizeColumnTaskOrders(board, previousColumnId);
    placeTaskInColumn(board, task, task.columnId, task.order);
  }
  task.updatedAt = now;
  board.updatedAt = now;
}

function buildAssignment(input: AssignKanbanTaskInput): KanbanAgentAssignment {
  return {
    status: input.status ?? 'assigned',
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.fallbackProfile !== undefined ? { fallbackProfile: input.fallbackProfile } : {}),
    ...(input.fallbackModels !== undefined ? { fallbackModels: input.fallbackModels } : {}),
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
    ...(input.lastFailureKind !== undefined
      ? { lastFailureKind: input.lastFailureKind }
      : {}),
  };
}

async function claimReadyTaskOnBoard(
  projectRoot: string,
  boardId: string,
  input: ClaimKanbanTaskInput,
): Promise<{ board: KanbanBoard; task: KanbanTask } | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
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
      ...(current?.fallbackProfile !== undefined
        ? { fallbackProfile: current.fallbackProfile }
        : {}),
      ...(current?.fallbackModels !== undefined ? { fallbackModels: current.fallbackModels } : {}),
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
      ...(input.fallbackProfile !== undefined ? { fallbackProfile: input.fallbackProfile } : {}),
      ...(input.fallbackModels !== undefined ? { fallbackModels: input.fallbackModels } : {}),
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
      ...(input.costCeilingUsd !== undefined
        ? { costCeilingUsd: input.costCeilingUsd }
        : {}),
      ...(input.retryPolicy !== undefined ? { retryPolicy: input.retryPolicy } : {}),
      ...(input.lastFailureKind !== undefined
        ? { lastFailureKind: input.lastFailureKind }
        : {}),
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

function compareTasksForWork(a: KanbanTask, b: KanbanTask): number {
  const priorityRank: Record<KanbanTaskPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  return (
    priorityRank[a.priority] - priorityRank[b.priority] ||
    a.columnId.localeCompare(b.columnId) ||
    a.order - b.order ||
    a.createdAt.localeCompare(b.createdAt)
  );
}

function matchesKanbanSearch(
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

function findTask(board: KanbanBoard, taskId: string): KanbanTask | undefined {
  const exact = board.tasks.find((task) => task.id === taskId);
  if (exact) return exact;
  const matches = board.tasks.filter((task) => task.id.startsWith(taskId));
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous kanban task id "${taskId}": ${matches
        .slice(0, 5)
        .map((task) => task.id)
        .join(', ')}`,
    );
  }
  return matches[0];
}

function resolveTaskRefs(board: KanbanBoard, taskRefs: readonly string[]): KanbanTask[] {
  const tasks: KanbanTask[] = [];
  const seen = new Set<string>();
  for (const ref of taskRefs) {
    const task = findTask(board, ref);
    if (!task) throw new Error(`Kanban task not found: ${ref}`);
    if (seen.has(task.id)) throw new Error(`Duplicate kanban task id: ${task.id}`);
    seen.add(task.id);
    tasks.push(task);
  }
  return tasks;
}

function findGoalMetric(
  metrics: readonly KanbanGoalMetric[],
  metricId: string,
): KanbanGoalMetric | undefined {
  const exact = metrics.find((metric) => metric.id === metricId);
  if (exact) return exact;
  const matches = metrics.filter((metric) => metric.id.startsWith(metricId));
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous kanban goal metric id "${metricId}": ${matches
        .slice(0, 5)
        .map((metric) => metric.id)
        .join(', ')}`,
    );
  }
  return matches[0];
}

function addDependencyToTask(board: KanbanBoard, task: KanbanTask, dependency: KanbanTask): void {
  if (task.id === dependency.id) throw new Error('A kanban task cannot depend on itself.');
  if (hasDependencyPath(board, dependency.id, task.id)) {
    throw new Error(`Adding dependency ${dependency.id} would create a dependency cycle.`);
  }
  task.dependsOn = uniqueStrings([...(task.dependsOn ?? []), dependency.id]);
}

function setChainMetadata(
  board: KanbanBoard,
  tasks: KanbanTask[],
  chainId: string,
  enforceDependencies: boolean,
): void {
  const uniqueTasks = resolveTaskRefs(
    board,
    tasks.map((task) => task.id),
  );
  for (let index = 0; index < uniqueTasks.length; index++) {
    const task = uniqueTasks[index];
    const previous = uniqueTasks[index - 1];
    const next = uniqueTasks[index + 1];
    if (!task) continue;
    task.chain = {
      chainId,
      order: index,
      ...(previous ? { previousTaskId: previous.id } : {}),
      ...(next ? { nextTaskId: next.id } : {}),
    };
    if (enforceDependencies && previous) addDependencyToTask(board, task, previous);
  }
}

function normalizeChainMetadata(board: KanbanBoard, chainId: string): void {
  const tasks = tasksInChain(board, chainId);
  if (tasks.length) setChainMetadata(board, tasks, chainId, false);
}

function tasksInChain(board: KanbanBoard, chainId: string): KanbanTask[] {
  return board.tasks
    .filter((task) => task.chain?.chainId === chainId)
    .sort(
      (a, b) =>
        (a.chain?.order ?? 0) - (b.chain?.order ?? 0) || a.createdAt.localeCompare(b.createdAt),
    );
}

function rewireDependents(
  board: KanbanBoard,
  fromTaskIds: string | string[],
  toTaskIds: string[],
  excludeTaskIds?: string | string[] | undefined,
): void {
  const fromSet = new Set(Array.isArray(fromTaskIds) ? fromTaskIds : [fromTaskIds]);
  const excludeSet = new Set(
    excludeTaskIds === undefined
      ? []
      : Array.isArray(excludeTaskIds)
        ? excludeTaskIds
        : [excludeTaskIds],
  );
  for (const task of board.tasks) {
    if (excludeSet.has(task.id) || !task.dependsOn?.some((depId) => fromSet.has(depId))) {
      continue;
    }
    const nextDependsOn = [
      ...task.dependsOn.filter((depId) => !fromSet.has(depId)),
      ...toTaskIds.filter((depId) => depId !== task.id),
    ];
    task.dependsOn = normalizeDependencyIds(board, task.id, uniqueStrings(nextDependsOn));
    if (task.dependsOn.length === 0) delete task.dependsOn;
    task.updatedAt = nowIso();
  }
}

function remapTaskReferences(
  cloned: KanbanTask,
  original: KanbanTask,
  idMap: Map<string, string>,
): void {
  cloned.dependsOn = remapIdList(original.dependsOn, idMap);
  if (!cloned.dependsOn?.length) delete cloned.dependsOn;
  if (original.parentTaskId !== undefined) {
    const parentTaskId = idMap.get(original.parentTaskId);
    if (parentTaskId) cloned.parentTaskId = parentTaskId;
    else delete cloned.parentTaskId;
  }
  cloned.childTaskIds = remapIdList(original.childTaskIds, idMap);
  if (!cloned.childTaskIds?.length) delete cloned.childTaskIds;
  if (original.mergedIntoTaskId !== undefined) {
    const mergedIntoTaskId = idMap.get(original.mergedIntoTaskId);
    if (mergedIntoTaskId) cloned.mergedIntoTaskId = mergedIntoTaskId;
    else delete cloned.mergedIntoTaskId;
  }
  cloned.mergedFromTaskIds = remapIdList(original.mergedFromTaskIds, idMap);
  if (!cloned.mergedFromTaskIds?.length) delete cloned.mergedFromTaskIds;
  if (original.chain !== undefined) {
    cloned.chain = {
      chainId: original.chain.chainId,
      order: original.chain.order,
      ...(original.chain.previousTaskId && idMap.get(original.chain.previousTaskId)
        ? { previousTaskId: idMap.get(original.chain.previousTaskId) }
        : {}),
      ...(original.chain.nextTaskId && idMap.get(original.chain.nextTaskId)
        ? { nextTaskId: idMap.get(original.chain.nextTaskId) }
        : {}),
    };
  }
}

function remapIdList(ids: string[] | undefined, idMap: Map<string, string>): string[] | undefined {
  const remapped = (ids ?? []).map((id) => idMap.get(id)).filter((id): id is string => Boolean(id));
  return remapped.length ? remapped : undefined;
}

function hasDependencyPath(
  board: KanbanBoard,
  fromTaskId: string,
  toTaskId: string,
  seen = new Set<string>(),
): boolean {
  if (fromTaskId === toTaskId) return true;
  if (seen.has(fromTaskId)) return false;
  seen.add(fromTaskId);
  const task = board.tasks.find((candidate) => candidate.id === fromTaskId);
  if (!task?.dependsOn?.length) return false;
  return task.dependsOn.some((depId) => hasDependencyPath(board, depId, toTaskId, seen));
}

function assertNoDependencyCycles(board: KanbanBoard): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new Error(`Kanban dependency cycle detected at ${taskId}.`);
    visiting.add(taskId);
    const task = board.tasks.find((candidate) => candidate.id === taskId);
    for (const depId of task?.dependsOn ?? []) {
      if (depId === taskId) throw new Error('A kanban task cannot depend on itself.');
      visit(depId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of board.tasks) visit(task.id);
}

function existingColumnId(board: KanbanBoard, columnId: string | undefined): string | undefined {
  if (!columnId) return undefined;
  const exact = board.columns.find((column) => column.id === columnId);
  if (exact) return exact.id;
  const matches = board.columns.filter((column) => column.id.startsWith(columnId));
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous kanban column id "${columnId}": ${matches
        .slice(0, 5)
        .map((column) => column.id)
        .join(', ')}`,
    );
  }
  return matches[0]?.id;
}

function uniqueColumnId(board: KanbanBoard, requested: string): string {
  const base = slugify(requested) || 'column';
  let candidate = base;
  let suffix = 2;
  while (board.columns.some((column) => column.id === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function uniqueIdFromSet(usedIds: Set<string>, requested: string): string {
  const base = requested || 'item';
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function normalizeDependencyIds(
  board: KanbanBoard,
  taskId: string,
  refs: readonly string[],
): string[] {
  const normalized: string[] = [];
  for (const ref of refs) {
    const dependency = findTask(board, ref);
    if (!dependency) throw new Error(`Dependency task not found: ${ref}`);
    if (taskId && dependency.id === taskId) {
      throw new Error('A kanban task cannot depend on itself.');
    }
    if (taskId && hasDependencyPath(board, dependency.id, taskId)) {
      throw new Error(`Adding dependency ${dependency.id} would create a dependency cycle.`);
    }
    if (!normalized.includes(dependency.id)) normalized.push(dependency.id);
  }
  return normalized;
}

function cloneChecks(checks: readonly KanbanCheck[]): KanbanCheck[] {
  return checks.map((check) => ({ ...check, id: randomUUID() }));
}

function cloneGoalMetrics(metrics: readonly KanbanGoalMetric[]): KanbanGoalMetric[] {
  const now = nowIso();
  return metrics.map((metric) => ({ ...metric, id: randomUUID(), updatedAt: now }));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function optionalArray<K extends string, T>(
  key: K,
  values: readonly T[],
): Record<K, T[]> | Record<string, never> {
  return values.length ? ({ [key]: [...values] } as Record<K, T[]>) : {};
}

function mergedTaskDescription(tasks: readonly KanbanTask[]): string {
  return tasks
    .map((task) =>
      [`## ${task.title}`, task.description, task.notes?.map((note) => note.content).join('\n')]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

function highestPriority(tasks: readonly KanbanTask[]): KanbanTaskPriority {
  const weight: Record<KanbanTaskPriority, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return tasks.reduce<KanbanTaskPriority>(
    (highest, task) => (weight[task.priority] > weight[highest] ? task.priority : highest),
    'low',
  );
}

function isTaskReadyForWork(board: KanbanBoard, task: KanbanTask): boolean {
  if (!['pending', 'ready'].includes(task.status)) return false;
  if (task.assignment && ['queued', 'running'].includes(task.assignment.status)) return false;
  if (task.mergedIntoTaskId) return false;
  if (!areDependenciesMet(board, task.id)) return false;
  return true;
}

function taskGraphStatusToKanbanStatus(status: TaskStatus): KanbanTaskStatus {
  if (status === 'in_progress') return 'in_progress';
  if (status === 'completed') return 'completed';
  if (status === 'review') return 'review';
  if (status === 'blocked') return 'blocked';
  if (status === 'failed') return 'failed';
  return 'pending';
}

function kanbanStatusToTaskGraphStatus(task: KanbanTask): TaskStatus {
  if (task.assignment?.status === 'running') return 'in_progress';
  if (task.assignment?.status === 'failed') return 'failed';
  if (task.status === 'ready' || task.status === 'archived') return 'pending';
  if (task.status === 'in_progress') return 'in_progress';
  if (task.status === 'completed') return 'completed';
  if (task.status === 'review') return 'review';
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'failed') return 'failed';
  return 'pending';
}

function taskInputFromGraphNode(
  board: KanbanBoard,
  graph: TaskGraph,
  node: TaskNode,
  options: CreateKanbanBoardFromTaskGraphOptions,
): CreateKanbanTaskInput {
  return {
    title: node.title,
    description: node.description,
    columnId: columnIdForTaskGraphStatus(board, node.status),
    priority: node.priority,
    status: taskGraphStatusToKanbanStatus(node.status),
    ...(node.assignee !== undefined
      ? { assignee: node.assignee, assignedAgent: node.assignee }
      : {}),
    ...(node.estimateHours !== undefined ? { estimatedHours: node.estimateHours } : {}),
    ...(node.actualHours !== undefined ? { actualHours: node.actualHours } : {}),
    ...(node.tags !== undefined ? { labels: node.tags } : {}),
    ...(node.parentId !== undefined ? { parentTaskId: node.parentId } : {}),
    ...(node.children !== undefined ? { childTaskIds: node.children } : {}),
    origin: {
      system: options.sourceSystem ?? 'task-graph',
      graphId: graph.id,
      taskId: node.id,
      specId: graph.specId,
      ...(options.phaseId !== undefined ? { phaseId: options.phaseId } : {}),
    },
  };
}

function applyGraphNodeToTask(
  board: KanbanBoard,
  graph: TaskGraph,
  task: KanbanTask,
  node: TaskNode,
  options: CreateKanbanBoardFromTaskGraphOptions,
  now: string,
): void {
  const previousColumnId = task.columnId;
  task.title = requireNonBlank(node.title, 'Kanban task title');
  task.description = node.description;
  task.priority = node.priority;
  task.status = taskGraphStatusToKanbanStatus(node.status);
  task.columnId = columnIdForTaskGraphStatus(board, node.status);
  if (node.assignee !== undefined) {
    task.assignee = node.assignee;
    task.assignedAgent = node.assignee;
  }
  if (node.estimateHours !== undefined) task.estimatedHours = node.estimateHours;
  else delete task.estimatedHours;
  if (node.actualHours !== undefined) task.actualHours = node.actualHours;
  else delete task.actualHours;
  if (node.tags?.length) task.labels = uniqueStrings(node.tags);
  else delete task.labels;
  task.origin = {
    system: options.sourceSystem ?? task.origin?.system ?? 'task-graph',
    graphId: graph.id,
    taskId: node.id,
    specId: graph.specId,
    ...(options.phaseId !== undefined ? { phaseId: options.phaseId } : {}),
  };
  task.updatedAt = isoFromTimestamp(node.updatedAt, now);
  if (node.completedAt !== undefined && task.status === 'completed') {
    task.completedAt = isoFromTimestamp(node.completedAt, now);
  } else {
    applyCompletedAtForStatus(task, now);
  }
  if (previousColumnId !== task.columnId) {
    normalizeColumnTaskOrders(board, previousColumnId);
    placeTaskInColumn(board, task, task.columnId, undefined);
  }
}

function applyTaskGraphRelationships(
  board: KanbanBoard,
  graph: TaskGraph,
  taskIdMap: Map<string, string>,
  options: { preserveManualDependencies: boolean },
): void {
  const syncedTaskIds = new Set(taskIdMap.values());
  const graphDepsByTaskId = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.type !== 'depends_on' && edge.type !== 'blocks') continue;
    const dependencyId = taskIdMap.get(edge.from);
    const taskId = taskIdMap.get(edge.to);
    if (!dependencyId || !taskId || dependencyId === taskId) continue;
    const deps = graphDepsByTaskId.get(taskId) ?? [];
    deps.push(dependencyId);
    graphDepsByTaskId.set(taskId, deps);
  }

  for (const [nodeId, taskId] of taskIdMap.entries()) {
    const task = board.tasks.find((candidate) => candidate.id === taskId);
    const node = graph.nodes.get(nodeId);
    if (!task || !node) continue;

    const parentTaskId = node.parentId ? taskIdMap.get(node.parentId) : undefined;
    if (parentTaskId) task.parentTaskId = parentTaskId;
    else delete task.parentTaskId;

    const childTaskIds = (node.children ?? [])
      .map((childId) => taskIdMap.get(childId))
      .filter((childId): childId is string => Boolean(childId));
    if (childTaskIds.length) task.childTaskIds = uniqueStrings(childTaskIds);
    else delete task.childTaskIds;

    const graphDeps = uniqueStrings(graphDepsByTaskId.get(taskId) ?? []);
    const manualDeps = options.preserveManualDependencies
      ? (task.dependsOn ?? []).filter((depId) => !syncedTaskIds.has(depId))
      : [];
    const nextDeps = uniqueStrings([...graphDeps, ...manualDeps]);
    if (nextDeps.length) task.dependsOn = nextDeps;
    else delete task.dependsOn;
  }
}

function buildTaskGraphMetadata(board: KanbanBoard, task: KanbanTask): Record<string, unknown> {
  const kanban: Record<string, unknown> = {
    boardId: board.id,
    taskId: task.id,
    columnId: task.columnId,
    status: task.status,
  };
  if (task.assignment !== undefined) kanban.assignment = { ...task.assignment };
  if (task.chain !== undefined) kanban.chain = { ...task.chain };
  if (task.successCriteria !== undefined)
    kanban.successCriteria = task.successCriteria.map((check) => ({ ...check }));
  if (task.goalMetrics !== undefined)
    kanban.goalMetrics = task.goalMetrics.map((metric) => ({ ...metric }));
  if (task.links !== undefined) kanban.links = task.links.map((link) => ({ ...link }));
  if (task.notes !== undefined) kanban.notes = task.notes.map((note) => ({ ...note }));
  if (task.origin !== undefined) kanban.origin = { ...task.origin };
  return { kanban };
}

function taskToTaskGraphNode(
  board: KanbanBoard,
  task: KanbanTask,
  nodeId: string,
  taskIdMap: Map<string, string>,
  fallback: { graphId: string; specId: string; createdAt: number },
): TaskNode {
  const createdAt = parseIsoTimestamp(task.createdAt, fallback.createdAt);
  const updatedAt = parseIsoTimestamp(task.updatedAt, createdAt);
  const parentId = task.parentTaskId ? taskIdMap.get(task.parentTaskId) : undefined;
  const children = (task.childTaskIds ?? [])
    .map((childId) => taskIdMap.get(childId))
    .filter((childId): childId is string => Boolean(childId));
  const assignee = task.assignee ?? task.assignedAgent ?? task.assignment?.agentId;
  return {
    id: nodeId,
    title: task.title,
    description: task.description ?? '',
    type: inferTaskType(task),
    priority: task.priority,
    status: kanbanStatusToTaskGraphStatus(task),
    createdAt,
    updatedAt,
    ...(assignee !== undefined ? { assignee } : {}),
    ...(task.estimatedHours !== undefined ? { estimateHours: task.estimatedHours } : {}),
    ...(task.actualHours !== undefined ? { actualHours: task.actualHours } : {}),
    ...(task.labels !== undefined ? { tags: task.labels } : {}),
    ...(task.origin?.specId !== undefined ? { specRequirementId: task.origin.specId } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(children.length ? { children } : {}),
    ...(task.completedAt !== undefined
      ? { completedAt: parseIsoTimestamp(task.completedAt, updatedAt) }
      : {}),
    metadata: {
      ...buildTaskGraphMetadata(board, task),
      graphId: fallback.graphId,
      specId: fallback.specId,
    },
  };
}

function taskGraphEdgesFromBoard(
  tasks: readonly KanbanTask[],
  taskIdMap: Map<string, string>,
): TaskEdge[] {
  const edges: TaskEdge[] = [];
  const usedEdgeIds = new Set<string>();
  const addEdge = (fromTaskId: string | undefined, toTaskId: string | undefined): void => {
    if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) return;
    const from = taskIdMap.get(fromTaskId);
    const to = taskIdMap.get(toTaskId);
    if (!from || !to || from === to) return;
    const duplicate = edges.some((edge) => edge.from === from && edge.to === to);
    if (duplicate) return;
    edges.push({
      id: uniqueIdFromSet(usedEdgeIds, `depends_on:${from}->${to}`),
      from,
      to,
      type: 'depends_on',
    });
  };
  for (const task of tasks) {
    for (const depId of task.dependsOn ?? []) addEdge(depId, task.id);
    addEdge(task.chain?.previousTaskId, task.id);
  }
  return edges;
}

function inferTaskType(task: KanbanTask): TaskType {
  const signals = [task.title, task.description, ...(task.labels ?? [])].join(' ').toLowerCase();
  if (/\bbug|fix|defect|regression\b/.test(signals)) return 'bugfix';
  if (/\brefactor|cleanup|cleanup\b/.test(signals)) return 'refactor';
  if (/\bdoc|docs|readme|documentation\b/.test(signals)) return 'docs';
  if (/\btest|spec|coverage|verify\b/.test(signals)) return 'test';
  if (/\bchore|maintenance|deps|dependency\b/.test(signals)) return 'chore';
  return 'feature';
}

function findTaskByOrigin(
  board: KanbanBoard,
  graphId: string,
  nodeId: string,
  phaseId: string | undefined,
): KanbanTask | undefined {
  return board.tasks.find(
    (task) =>
      task.origin?.graphId === graphId &&
      task.origin?.taskId === nodeId &&
      (phaseId === undefined || task.origin.phaseId === phaseId),
  );
}

function isTaskFromGraph(task: KanbanTask, graphId: string, phaseId: string | undefined): boolean {
  return (
    task.origin?.graphId === graphId && (phaseId === undefined || task.origin.phaseId === phaseId)
  );
}

function columnIdForTaskGraphStatus(board: KanbanBoard, status: TaskStatus): string {
  const preferred =
    status === 'completed'
      ? ['done', 'completed']
      : status === 'in_progress'
        ? ['in-progress', 'progress', 'doing']
        : status === 'review' || status === 'failed'
          ? ['review']
          : status === 'blocked'
            ? ['blocked', 'backlog']
            : ['backlog', 'todo'];
  for (const columnRef of preferred) {
    const columnId = existingColumnId(board, columnRef);
    if (columnId) return columnId;
  }
  return board.columns[0]?.id ?? 'backlog';
}

function reconcileTaskColumns(board: KanbanBoard, now: string): void {
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

function normalizeAllColumnTaskOrders(board: KanbanBoard): void {
  for (const column of board.columns) normalizeColumnTaskOrders(board, column.id);
}

function createKanbanEvent(
  boardId: string,
  task: KanbanTask,
  type: string,
  details: Partial<Omit<KanbanEvent, 'id' | 'boardId' | 'taskId' | 'type' | 'ts'>> = {},
): KanbanEvent {
  return {
    id: randomUUID(),
    boardId,
    taskId: task.id,
    type,
    ts: nowIso(),
    ...(task.assignment?.agentId !== undefined ? { actor: task.assignment.agentId } : {}),
    ...(task.assignment?.subagentId !== undefined ? { subagentId: task.assignment.subagentId } : {}),
    ...(task.assignment?.runTaskId !== undefined ? { runTaskId: task.assignment.runTaskId } : {}),
    ...details,
  };
}

async function emitKanbanEvent(projectRoot: string, event: KanbanEvent): Promise<void> {
  try {
    await appendKanbanEvent(projectRoot, event.boardId, event);
  } catch {
    // Event logging is observability-only; current board state must remain authoritative.
  }
}

function assignmentEventType(status: KanbanAgentRunStatus): string {
  return status === 'completed'
    ? 'task.assignment.completed'
    : status === 'failed'
      ? 'task.assignment.failed'
      : status === 'running'
        ? 'task.assignment.running'
        : status === 'cancelled'
          ? 'task.assignment.cancelled'
          : 'task.assignment.updated';
}

function columnIdForKanbanStatus(
  board: KanbanBoard,
  status: KanbanTaskStatus,
): string | undefined {
  const preferred =
    status === 'completed'
      ? ['done', 'completed']
      : status === 'in_progress'
        ? ['in-progress', 'progress', 'doing']
        : status === 'review' || status === 'failed'
          ? ['review']
          : status === 'blocked'
            ? ['blocked', 'backlog']
            : status === 'ready'
              ? ['todo', 'ready', 'backlog']
              : status === 'archived'
                ? ['done', 'archive', 'backlog']
                : ['todo', 'backlog'];
  for (const columnRef of preferred) {
    const columnId = existingColumnId(board, columnRef);
    if (columnId) return columnId;
  }
  return board.columns[0]?.id;
}

function normalizeColumnTaskOrders(board: KanbanBoard, columnId: string): void {
  board.tasks
    .filter((task) => task.columnId === columnId)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    .forEach((task, index) => {
      task.order = index;
    });
}

function syncTaskColumnForStatus(
  board: KanbanBoard,
  task: KanbanTask,
  previousColumnId: string,
): void {
  const nextColumnId = columnIdForKanbanStatus(board, task.status);
  if (!nextColumnId || nextColumnId === task.columnId) return;
  task.columnId = nextColumnId;
  normalizeColumnTaskOrders(board, previousColumnId);
  placeTaskInColumn(board, task, nextColumnId, undefined);
}

function placeTaskInColumn(
  board: KanbanBoard,
  task: KanbanTask,
  columnId: string,
  targetOrder: number | undefined,
): void {
  const tasks = board.tasks
    .filter((candidate) => candidate.columnId === columnId && candidate.id !== task.id)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
  const index = clampOrder(targetOrder, tasks.length);
  tasks.splice(index, 0, task);
  tasks.forEach((candidate, order) => {
    candidate.order = order;
  });
}

function nextTaskOrder(
  board: KanbanBoard,
  columnId: string,
  excludeTaskId?: string | undefined,
): number {
  return (
    board.tasks
      .filter((task) => task.columnId === columnId && task.id !== excludeTaskId)
      .reduce((max, task) => Math.max(max, task.order), -1) + 1
  );
}

function clampOrder(order: number | undefined, max: number): number {
  if (!Number.isFinite(order)) return max;
  return Math.max(0, Math.min(Math.trunc(order as number), max));
}

function applyCompletedAtForStatus(task: KanbanTask, timestamp: string): void {
  if (task.status === 'completed') task.completedAt = task.completedAt ?? timestamp;
  else delete task.completedAt;
}

function statusForColumn(columnId: string): KanbanTaskStatus {
  const normalized = columnId.toLowerCase();
  if (normalized.includes('done') || normalized.includes('complete')) return 'completed';
  if (normalized.includes('progress') || normalized.includes('doing')) return 'in_progress';
  if (normalized.includes('review')) return 'review';
  if (normalized.includes('block')) return 'blocked';
  if (normalized.includes('ready')) return 'ready';
  return 'pending';
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty.`);
  return trimmed;
}

function parseIsoTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isoFromTimestamp(value: number | undefined, fallback: string): string {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return new Date(value).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

import { randomUUID } from 'node:crypto';
import { EVENT_LOG_TRIM_TO, mutateBoard, readBoard, readKanbanEvents } from '../storage.js';
import type {
  KanbanBoard,
  KanbanCheck,
  KanbanCheckStatus,
  KanbanEvent,
  KanbanEventContext,
  KanbanGoalMetric,
  KanbanLink,
  KanbanNote,
  KanbanTask,
  KanbanTaskFileActivityInput,
  RecordKanbanTaskActivityInput,
} from '../types.js';
import type {
  AddKanbanGoalMetricInput,
  CopyKanbanTaskOptions,
  CreateKanbanTaskInput,
  UpdateKanbanGoalMetricInput,
  UpdateKanbanTaskInput,
} from '../types-operations.js';
import {
  applyTaskPatch,
  cloneTaskForBoard,
  createKanbanEvent,
  createTaskObject,
  emitKanbanEvent,
  findGoalMetric,
  findTask,
  normalizeChainMetadata,
  normalizeColumnTaskOrders,
  nowIso,
  placeTaskInColumn,
  requireNonBlank,
  stampAtomicityAssessment,
} from './_internal.js';
import { cloneContractGraphForBoard, removeTaskContractGraphState } from './contract-graph.js';
import {
  assertManagedTaskPatchAllowed,
  initializeAndValidateManagedTask,
  KanbanLifecycleError,
} from './lifecycle.js';

function taskEventSnapshot(task: KanbanTask): Record<string, unknown> {
  return {
    title: task.title,
    description: task.description ?? null,
    dueDate: task.dueDate ?? null,
    columnId: task.columnId,
    order: task.order,
    priority: task.priority,
    type: task.type ?? null,
    status: task.status,
    assignedAgent: task.assignedAgent ?? null,
    assignee: task.assignee ?? null,
    assignment: task.assignment ? { ...task.assignment } : null,
    dependsOn: task.dependsOn ? [...task.dependsOn] : null,
    chain: task.chain ? { ...task.chain } : null,
    parentTaskId: task.parentTaskId ?? null,
    childTaskIds: task.childTaskIds ? [...task.childTaskIds] : null,
    mergedIntoTaskId: task.mergedIntoTaskId ?? null,
    mergedFromTaskIds: task.mergedFromTaskIds ? [...task.mergedFromTaskIds] : null,
    origin: task.origin ? { ...task.origin } : null,
    labels: task.labels ? [...task.labels] : null,
    estimatedHours: task.estimatedHours ?? null,
    actualHours: task.actualHours ?? null,
    retryPolicy: task.retryPolicy ?? null,
    costCeilingUsd: task.costCeilingUsd ?? null,
    successCriteria: task.successCriteria?.map((check) => ({ ...check })) ?? null,
    goalMetrics: task.goalMetrics?.map((metric) => ({ ...metric })) ?? null,
    links: task.links?.map((link) => ({ ...link })) ?? null,
    lifecycle: task.lifecycle
      ? {
          ...task.lifecycle,
          history: task.lifecycle.history.map((transition) => ({ ...transition })),
        }
      : null,
  };
}

function changedTaskState(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changed = Object.keys(after).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  return {
    before: Object.fromEntries(changed.map((key) => [key, before[key]])),
    after: Object.fromEntries(changed.map((key) => [key, after[key]])),
  };
}

export async function addTask(
  projectRoot: string,
  boardId: string,
  input: CreateKanbanTaskInput,
  eventContext: KanbanEventContext = {},
): Promise<{ board: KanbanBoard; task: KanbanTask } | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = createTaskObject(board, input);
    initializeAndValidateManagedTask(board, task);
    if (input.atomicityAssessment === undefined) stampAtomicityAssessment(board, task);
    board.tasks.push(task);
    placeTaskInColumn(board, task, task.columnId, task.order);
    board.updatedAt = nowIso();
    event = createKanbanEvent(board.id, task, 'task.created', {
      ...eventContext,
      after: {
        title: task.title,
        columnId: task.columnId,
        priority: task.priority,
        status: task.status,
      },
    });
    return task;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
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

  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, targetBoardId, (targetBoard) => {
    const task = cloneTaskForBoard(targetBoard, sourceTask, {
      // Managed copies are new work and must restart at Backlog with a fresh
      // lifecycle ledger; carrying a mid-stream stage would fake progression.
      targetColumnId:
        targetBoard.lifecycle?.mode === 'managed'
          ? targetBoard.lifecycle.columns.backlog
          : options.targetColumnId,
      targetOrder: options.targetOrder,
      preserveAssignment: options.preserveAssignment === true,
      preserveDependencies: options.preserveDependencies === true,
    });
    if (targetBoard.lifecycle?.mode === 'managed') {
      delete task.lifecycle;
      task.status = 'pending';
      delete task.completedAt;
      initializeAndValidateManagedTask(targetBoard, task);
    }
    targetBoard.tasks.push(task);
    cloneContractGraphForBoard(sourceBoard, targetBoard, new Map([[sourceTask.id, task.id]]));
    placeTaskInColumn(targetBoard, task, task.columnId, task.order);
    targetBoard.updatedAt = nowIso();
    event = createKanbanEvent(targetBoard.id, task, 'task.copied', {
      note: `from board ${sourceBoard.id}`,
    });
    return task;
  });

  if (updated && event) await emitKanbanEvent(projectRoot, event);
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
  eventContext: KanbanEventContext = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const before = taskEventSnapshot(task);
    assertManagedTaskPatchAllowed(board, task, input);
    applyTaskPatch(board, task, input);
    const after = taskEventSnapshot(task);
    const changes = changedTaskState(before, after);
    const moved = before['columnId'] !== after['columnId'];
    event = moved
      ? createKanbanEvent(board.id, task, 'task.moved', {
          ...eventContext,
          ...changes,
        })
      : createKanbanEvent(board.id, task, 'task.updated', {
          ...eventContext,
          ...changes,
        });
    return task;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function moveTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  targetColumnId: string,
  targetOrder?: number,
  eventContext: KanbanEventContext = {},
): Promise<KanbanBoard | null> {
  return updateTask(
    projectRoot,
    boardId,
    taskId,
    {
      columnId: targetColumnId,
      ...(targetOrder !== undefined ? { order: targetOrder } : {}),
    },
    eventContext,
  );
}

export async function removeTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const taskToRemove = findTask(board, taskId);
    if (!taskToRemove) return false;
    const requirementId = taskToRemove.origin?.specRequirementId;
    const graphId = taskToRemove.origin?.graphId;
    const declaredByScope = Boolean(
      graphId &&
        board.requirementScopes?.some(
          (scope) =>
            scope.graphId === graphId && scope.requirementIds.includes(requirementId ?? ''),
        ),
    );
    const declaredByLegacyFlatList = Boolean(
      requirementId && board.requiredRequirementIds?.includes(requirementId),
    );
    if (
      requirementId &&
      (declaredByScope || declaredByLegacyFlatList) &&
      !board.tasks.some(
        (task) =>
          task.id !== taskToRemove.id &&
          task.origin?.specRequirementId === requirementId &&
          (!declaredByScope || task.origin?.graphId === graphId),
      )
    ) {
      throw new KanbanLifecycleError(
        `Cannot remove the last task covering required requirement ${requirementId}.`,
        [
          {
            code: 'requirement-coverage-incomplete',
            field: 'origin.specRequirementId',
            message: `Cannot remove the last task covering required requirement ${requirementId}.`,
          },
        ],
      );
    }
    const index = board.tasks.findIndex((task) => task.id === taskToRemove.id);
    if (index === -1) return false;
    event = createKanbanEvent(board.id, taskToRemove, 'task.removed');
    board.tasks.splice(index, 1);
    removeTaskContractGraphState(board, taskToRemove.id);
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
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
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

export async function listTaskActivity(
  projectRoot: string,
  boardId: string,
  taskId: string,
  options: { limit?: number | undefined } = {},
): Promise<KanbanEvent[]> {
  const limit = Math.max(1, Math.min(EVENT_LOG_TRIM_TO, Math.trunc(options.limit ?? 100)));
  return (await readKanbanEvents(projectRoot, boardId))
    .filter((event) => event.taskId === taskId)
    .reverse()
    .slice(0, limit);
}

export async function recordTaskActivity(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: RecordKanbanTaskActivityInput,
  eventContext: KanbanEventContext = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const summary = requireNonBlank(input.summary, 'Kanban task activity summary');
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, `task.activity.${input.kind}`, {
      ...eventContext,
      note: summary,
      after: {
        kind: input.kind,
        outcome: input.outcome ?? 'unknown',
        ...(input.details?.trim() ? { details: input.details.trim() } : {}),
      },
    });
    return task;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

/**
 * Append a tool-initiated file operation to a task's durable activity stream.
 * This intentionally does not mutate the card: reads should not make a task
 * look edited or churn the board JSON while an agent is exploring the codebase.
 */
export async function recordTaskFileActivity(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: KanbanTaskFileActivityInput,
): Promise<boolean> {
  const board = await readBoard(projectRoot, boardId);
  const task = board ? findTask(board, taskId) : undefined;
  if (!board || !task) return false;
  const event = createKanbanEvent(board.id, task, `task.file.${input.operation}`, {
    actor: input.agentName || input.agentId,
    sessionId: input.sessionId,
    correlationId: input.toolUseId,
    note: `${input.operation} ${input.filePath}`,
    after: {
      operation: input.operation,
      filePath: input.filePath,
      toolName: input.toolName,
      provider: input.provider,
      model: input.model,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.fileSize !== undefined ? { fileSize: input.fileSize } : {}),
      ...(input.lines !== undefined ? { lines: input.lines } : {}),
      ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
    },
  });
  await emitKanbanEvent(projectRoot, event);
  return true;
}

export async function addGoalMetricToTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  metric: AddKanbanGoalMetricInput,
  eventContext: KanbanEventContext = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
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
      ...(metric.direction !== undefined ? { direction: metric.direction } : {}),
      ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
      ...(metric.notes !== undefined ? { notes: metric.notes } : {}),
    };
    task.goalMetrics = [...(task.goalMetrics ?? []), nextMetric];
    task.updatedAt = now;
    board.updatedAt = now;
    event = createKanbanEvent(board.id, task, 'task.metric.added', {
      ...eventContext,
      after: { ...nextMetric },
    });
    return nextMetric;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function updateGoalMetricOnTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  metricId: string,
  patch: UpdateKanbanGoalMetricInput,
  eventContext: KanbanEventContext = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    const metric = task ? findGoalMetric(task.goalMetrics ?? [], metricId) : undefined;
    if (!task || !metric) return null;
    const before = { ...metric };
    if (patch.name !== undefined)
      metric.name = requireNonBlank(patch.name, 'Kanban goal metric name');
    if (patch.status !== undefined) metric.status = patch.status;
    if (patch.target !== undefined) metric.target = patch.target;
    if (patch.current !== undefined) metric.current = patch.current;
    if (patch.direction !== undefined) metric.direction = patch.direction;
    if (patch.unit !== undefined) metric.unit = patch.unit;
    if (patch.notes !== undefined) metric.notes = patch.notes;
    const now = nowIso();
    metric.updatedAt = now;
    task.updatedAt = now;
    board.updatedAt = now;
    event = createKanbanEvent(board.id, task, 'task.metric.updated', {
      ...eventContext,
      before,
      after: { ...metric },
    });
    return metric;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function addCheckToTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  check: Omit<KanbanCheck, 'id' | 'status'> & { status?: KanbanCheckStatus | undefined },
  eventContext: KanbanEventContext = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
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
    event = createKanbanEvent(board.id, task, 'task.check.added', {
      ...eventContext,
      after: { ...newCheck },
    });
    return newCheck;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function updateCheckOnTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  checkId: string,
  patch: Partial<Omit<KanbanCheck, 'id'>>,
  eventContext: KanbanEventContext = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    const check = task?.successCriteria?.find((candidate) => candidate.id === checkId);
    if (!task || !check) return null;
    const before = { ...check };
    Object.assign(check, patch);
    if (patch.status && patch.status !== 'pending' && !check.checkedAt) {
      check.checkedAt = nowIso();
    }
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, 'task.check.updated', {
      ...eventContext,
      before,
      after: { ...check },
    });
    return check;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

/**
 * Drop an acceptance criterion.
 *
 * The counterpart to `addCheckToTask` was missing, and its absence was a dead
 * end rather than an inconvenience: `validateDefinitionOfDone` refuses Done
 * while ANY criterion is not `passed`, so a criterion that turned out to be
 * irrelevant — or one recorded as `skipped` — held its card out of Done
 * permanently, and the only way past was to mark it `passed`, which is a lie.
 * Removing the criterion is the truthful escape.
 *
 * The contract map may bind a verification node to a criterion, so clear that
 * binding too rather than leaving a node pointing at an id that no longer
 * exists.
 */
export async function removeCheckFromTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  checkId: string,
  eventContext: KanbanEventContext = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    const index = task?.successCriteria?.findIndex((candidate) => candidate.id === checkId) ?? -1;
    if (!task || index === -1) return null;
    const [removed] = task.successCriteria!.splice(index, 1);
    if (task.successCriteria!.length === 0) delete task.successCriteria;
    for (const node of board.contractGraph?.nodes ?? []) {
      if (node.checkId === checkId) delete node.checkId;
    }
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, 'task.check.removed', {
      ...eventContext,
      before: removed,
    });
    return removed;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function addNoteToTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  note: { author: string; content: string },
  eventContext: KanbanEventContext = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
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
    event = createKanbanEvent(board.id, task, 'task.note.added', {
      ...eventContext,
      note: newNote.content,
    });
    return newNote;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function addLinkToTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  link: KanbanLink,
  eventContext: KanbanEventContext = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    task.links = [...(task.links ?? []), link];
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, 'task.link.added', {
      ...eventContext,
      after: { ...link },
    });
    return link;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

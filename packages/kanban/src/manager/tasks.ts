import { randomUUID } from 'node:crypto';
import { assertManagementWrite } from '../management-fence.js';
import { EVENT_LOG_TRIM_TO, mutateBoard, readBoard, readKanbanEvents } from '../storage.js';
import type {
  KanbanBoard,
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
  areDependenciesMet,
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
  syncTaskColumnForStatus,
} from './_internal.js';
import { cloneContractGraphForBoard, removeTaskContractGraphState } from './contract-graph.js';
import { assertAcceptedContractUnchanged } from './lifecycle/accepted-contract.js';
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
  eventContext: KanbanEventContext,
): Promise<{ board: KanbanBoard; task: KanbanTask } | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    assertManagementWrite(board, [], eventContext);
    if (input.id?.trim() && board.tasks.some((t) => t.id === input.id!.trim())) {
      throw new Error(`Duplicate kanban task id: ${input.id.trim()}`);
    }
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
  options: CopyKanbanTaskOptions,
): Promise<{ sourceBoard: KanbanBoard; targetBoard: KanbanBoard; task: KanbanTask } | null> {
  const sourceBoard = await readBoard(projectRoot, sourceBoardId);
  if (!sourceBoard) return null;
  const sourceTask = findTask(sourceBoard, taskId);
  if (!sourceTask) return null;

  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, targetBoardId, (targetBoard) => {
    assertManagementWrite(targetBoard, [], options.eventContext);
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
    if (targetBoard.atomicity?.mode === 'off') {
      delete task.atomicityAssessment;
    } else {
      stampAtomicityAssessment(targetBoard, task);
    }
    targetBoard.tasks.push(task);
    cloneContractGraphForBoard(sourceBoard, targetBoard, new Map([[sourceTask.id, task.id]]));
    placeTaskInColumn(targetBoard, task, task.columnId, task.order);
    targetBoard.updatedAt = nowIso();
    event = createKanbanEvent(targetBoard.id, task, 'task.copied', {
      ...options.eventContext,
      note: `from board ${sourceBoard.id}`,
    });
    return task;
  });

  if (updated && event) await emitKanbanEvent(projectRoot, event);
  return updated ? { sourceBoard, targetBoard: updated.board, task: updated.result } : null;
}

function assertTaskRemovable(
  board: KanbanBoard,
  taskToRemove: KanbanTask,
  eventContext: KanbanEventContext,
): void {
  assertManagementWrite(board, [taskToRemove], eventContext);
  const requirementId = taskToRemove.origin?.specRequirementId;
  const graphId = taskToRemove.origin?.graphId;
  const declaredByScope = Boolean(
    graphId &&
      board.requirementScopes?.some(
        (scope) => scope.graphId === graphId && scope.requirementIds.includes(requirementId ?? ''),
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
}

export async function transferTaskToBoard(
  projectRoot: string,
  sourceBoardId: string,
  taskId: string,
  targetBoardId: string,
  options: CopyKanbanTaskOptions,
): Promise<{ sourceBoard: KanbanBoard; targetBoard: KanbanBoard; task: KanbanTask } | null> {
  const sourceBoard = await readBoard(projectRoot, sourceBoardId);
  if (!sourceBoard) return null;
  const sourceTask = findTask(sourceBoard, taskId);
  if (!sourceTask) return null;

  const targetBoard = await readBoard(projectRoot, targetBoardId);
  if (!targetBoard) return null;

  if (sourceBoard.id === targetBoard.id) {
    const moved = await moveTask(
      projectRoot,
      sourceBoard.id,
      sourceTask.id,
      options.targetColumnId ?? sourceTask.columnId,
      options.targetOrder,
      options.eventContext,
    );
    const task = moved ? findTask(moved, sourceTask.id) : undefined;
    return moved && task ? { sourceBoard: moved, targetBoard: moved, task } : null;
  }

  assertTaskRemovable(sourceBoard, sourceTask, options.eventContext);

  const copied = await copyTaskToBoard(projectRoot, sourceBoard.id, sourceTask.id, targetBoardId, {
    ...options,
    preserveAssignment: options.preserveAssignment ?? true,
    preserveDependencies: options.preserveDependencies ?? false,
  });
  if (!copied) return null;
  const sourceAfterRemoval = await removeTask(
    projectRoot,
    sourceBoard.id,
    sourceTask.id,
    options.eventContext,
  );
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
  eventContext: KanbanEventContext,
  /**
   * `expectedUpdatedAt`: the task version the caller edited. Checked inside the board write,
   * so an edit based on an older read is refused instead of overwriting a newer save.
   */
  options: { expectedUpdatedAt?: string | undefined } = {},
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    if (options.expectedUpdatedAt !== undefined && task.updatedAt !== options.expectedUpdatedAt)
      throw new Error(
        'KANBAN_TASK_CONFLICT: The task changed since it was read. Reload it before saving.',
      );
    assertManagementWrite(board, [task], eventContext);
    if (
      eventContext.expectedManagementToken !== undefined &&
      Object.keys(input).some(
        (key) =>
          key !== 'description' &&
          key !== 'priority' &&
          input[key as keyof UpdateKanbanTaskInput] !== undefined,
      )
    ) {
      throw new Error('Kanban manager may change only description and priority.');
    }
    const before = taskEventSnapshot(task);
    assertManagedTaskPatchAllowed(board, task, input);
    const acceptedTask = structuredClone(task);
    applyTaskPatch(board, task, input);
    assertAcceptedContractUnchanged(board, acceptedTask, task);
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
  targetOrder: number | undefined,
  eventContext: KanbanEventContext,
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
  eventContext: KanbanEventContext,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const taskToRemove = findTask(board, taskId);
    if (!taskToRemove) return false;
    assertTaskRemovable(board, taskToRemove, eventContext);
    const index = board.tasks.findIndex((task) => task.id === taskToRemove.id);
    if (index === -1) return false;
    event = createKanbanEvent(board.id, taskToRemove, 'task.removed', eventContext);
    board.tasks.splice(index, 1);
    removeTaskContractGraphState(board, taskToRemove.id);
    const affectedTasks = new Set<KanbanTask>();
    for (const task of board.tasks) {
      let taskChanged = false;
      if (task.dependsOn?.includes(taskToRemove.id)) {
        task.dependsOn = task.dependsOn.filter((depId) => depId !== taskToRemove.id);
        if (task.dependsOn.length === 0) delete task.dependsOn;
        taskChanged = true;
      }
      if (task.childTaskIds?.includes(taskToRemove.id)) {
        task.childTaskIds = task.childTaskIds.filter((childId) => childId !== taskToRemove.id);
        if (task.childTaskIds.length === 0) delete task.childTaskIds;
        taskChanged = true;
      }
      if (task.parentTaskId === taskToRemove.id) {
        delete task.parentTaskId;
        taskChanged = true;
      }
      if (task.mergedIntoTaskId === taskToRemove.id) {
        delete task.mergedIntoTaskId;
        taskChanged = true;
      }
      if (task.mergedFromTaskIds?.includes(taskToRemove.id)) {
        task.mergedFromTaskIds = task.mergedFromTaskIds.filter(
          (sourceId) => sourceId !== taskToRemove.id,
        );
        if (task.mergedFromTaskIds.length === 0) delete task.mergedFromTaskIds;
        taskChanged = true;
      }
      if (task.chain?.previousTaskId === taskToRemove.id) {
        delete task.chain.previousTaskId;
        taskChanged = true;
      }
      if (task.chain?.nextTaskId === taskToRemove.id) {
        delete task.chain.nextTaskId;
        taskChanged = true;
      }
      if (taskChanged) affectedTasks.add(task);
    }
    const isManaged = board.lifecycle?.mode === 'managed';
    const now = nowIso();
    for (const task of affectedTasks) {
      stampAtomicityAssessment(board, task);
      if (!isManaged && task.status === 'blocked' && areDependenciesMet(board, task.id)) {
        task.status = 'ready';
        const previousColumnId = task.columnId;
        syncTaskColumnForStatus(board, task, previousColumnId);
        if (previousColumnId !== task.columnId) normalizeColumnTaskOrders(board, previousColumnId);
      }
      task.updatedAt = now;
    }
    if (taskToRemove.chain?.chainId) normalizeChainMetadata(board, taskToRemove.chain.chainId);
    normalizeColumnTaskOrders(board, taskToRemove.columnId);
    board.updatedAt = now;
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
  eventContext: KanbanEventContext,
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
  eventContext: KanbanEventContext,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    assertManagementWrite(board, [task], eventContext);
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
  eventContext: KanbanEventContext,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    const metric = task ? findGoalMetric(task.goalMetrics ?? [], metricId) : undefined;
    if (!task || !metric) return null;
    assertManagementWrite(board, [task], eventContext);
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

export { addCheckToTask, removeCheckFromTask, updateCheckOnTask } from './task-checks.js';

export async function addNoteToTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  note: { author: string; content: string },
  eventContext: KanbanEventContext,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    assertManagementWrite(board, [task], eventContext, 'note');
    if (eventContext.expectedManagementToken !== undefined) {
      const existing = task.notes?.find(
        (item) => item.author === 'kanban-manager' && item.content.trim() === note.content.trim(),
      );
      if (existing) return existing;
    }
    const newNote: KanbanNote = {
      id: randomUUID(),
      author: eventContext.expectedManagementToken !== undefined ? 'kanban-manager' : note.author,
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
  eventContext: KanbanEventContext,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    assertManagementWrite(board, [task], eventContext);
    if (eventContext.expectedManagementToken !== undefined) {
      const existing = task.links?.find((item) => item.url === link.url && item.type === link.type);
      if (existing) return existing;
    }
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

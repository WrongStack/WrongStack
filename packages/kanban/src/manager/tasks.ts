import { randomUUID } from 'node:crypto';
import { mutateBoard, readBoard, readKanbanEvents } from '../storage.js';
import type {
  AddKanbanGoalMetricInput,
  CopyKanbanTaskOptions,
  CreateKanbanTaskInput,
  KanbanBoard,
  KanbanCheck,
  KanbanCheckStatus,
  KanbanEvent,
  KanbanGoalMetric,
  KanbanLink,
  KanbanNote,
  KanbanTask,
  UpdateKanbanGoalMetricInput,
  UpdateKanbanTaskInput,
} from '../types.js';
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
} from './_internal.js';

export async function addTask(
  projectRoot: string,
  boardId: string,
  input: CreateKanbanTaskInput,
): Promise<{ board: KanbanBoard; task: KanbanTask } | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = createTaskObject(board, input);
    board.tasks.push(task);
    placeTaskInColumn(board, task, task.columnId, task.order);
    board.updatedAt = nowIso();
    event = createKanbanEvent(board.id, task, 'task.created', {
      after: { title: task.title, columnId: task.columnId, priority: task.priority, status: task.status },
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
      targetColumnId: options.targetColumnId,
      targetOrder: options.targetOrder,
      preserveAssignment: options.preserveAssignment === true,
      preserveDependencies: options.preserveDependencies === true,
    });
    targetBoard.tasks.push(task);
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
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    const beforeColumnId = task.columnId;
    const beforeStatus = task.status;
    applyTaskPatch(board, task, input);
    const moved = task.columnId !== beforeColumnId;
    event = moved
      ? createKanbanEvent(board.id, task, 'task.moved', {
          before: { columnId: beforeColumnId },
          after: { columnId: task.columnId },
        })
      : createKanbanEvent(board.id, task, 'task.updated', {
          before: { status: beforeStatus },
          after: { status: task.status },
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
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const taskToRemove = findTask(board, taskId);
    if (!taskToRemove) return false;
    const index = board.tasks.findIndex((task) => task.id === taskToRemove.id);
    if (index === -1) return false;
    event = createKanbanEvent(board.id, taskToRemove, 'task.removed');
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

export async function addGoalMetricToTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  metric: AddKanbanGoalMetricInput,
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
      ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
      ...(metric.notes !== undefined ? { notes: metric.notes } : {}),
    };
    task.goalMetrics = [...(task.goalMetrics ?? []), nextMetric];
    task.updatedAt = now;
    board.updatedAt = now;
    event = createKanbanEvent(board.id, task, 'task.metric.added', {
      after: { name: nextMetric.name, status: nextMetric.status },
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
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
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
    event = createKanbanEvent(board.id, task, 'task.metric.updated', {
      after: { name: metric.name, status: metric.status },
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
      after: { description: newCheck.description, status: newCheck.status },
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
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
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
    event = createKanbanEvent(board.id, task, 'task.check.updated', {
      after: { description: check.description, status: check.status },
    });
    return check;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function addNoteToTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  note: { author: string; content: string },
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
    event = createKanbanEvent(board.id, task, 'task.note.added', { note: newNote.content });
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
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    task.links = [...(task.links ?? []), link];
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, 'task.link.added', {
      after: { url: link.url, type: link.type },
    });
    return link;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

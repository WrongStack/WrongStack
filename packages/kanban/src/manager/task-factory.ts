import { randomUUID } from 'node:crypto';
import { normalizeKanbanBoundaryPolicy } from '../boundary.js';
import type {
  KanbanBoard,
  KanbanCheck,
  KanbanColumn,
  KanbanGoalMetric,
  KanbanTask,
  KanbanTaskPriority,
} from '../types.js';
import {
  type CloneTaskForBoardOptions,
  type CreateKanbanTaskInput,
  DEFAULT_COLUMNS,
  type UpdateKanbanTaskInput,
} from '../types-operations.js';
import { nowIso, requireNonBlank, statusForColumn, uniqueStrings } from './basic-helpers.js';
import { normalizeChainMetadata, normalizeDependencyIds } from './task-chain-internal.js';
import {
  applyCompletedAtForStatus,
  existingColumnId,
  nextTaskOrder,
  normalizeColumnTaskOrders,
  placeTaskInColumn,
  syncTaskColumnForStatus,
} from './task-column-helpers.js';

export function normalizeColumns(_columns: KanbanColumn[] | undefined): KanbanColumn[] {
  return DEFAULT_COLUMNS.map((column) => ({ ...column }));
}

export function createTaskObject(board: KanbanBoard, input: CreateKanbanTaskInput): KanbanTask {
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
    ...(input.type !== undefined ? { type: input.type } : {}),
    status: input.status ?? statusForColumn(columnId),
    createdAt: now,
    updatedAt: now,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
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
    ...(input.retryPolicy !== undefined ? { retryPolicy: input.retryPolicy } : {}),
    ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
    ...(input.successCriteria !== undefined ? { successCriteria: input.successCriteria } : {}),
    ...(input.goalMetrics !== undefined ? { goalMetrics: input.goalMetrics } : {}),
    ...(input.links !== undefined ? { links: input.links } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.boundary !== undefined
      ? { boundary: normalizeKanbanBoundaryPolicy(input.boundary) }
      : {}),
    ...(input.atomic !== undefined ? { atomic: input.atomic } : {}),
    ...(input.expectedFileChanges !== undefined
      ? { expectedFileChanges: input.expectedFileChanges }
      : {}),
    ...(input.verificationReport !== undefined
      ? { verificationReport: input.verificationReport }
      : {}),
    ...(input.atomicityAssessment !== undefined
      ? { atomicityAssessment: input.atomicityAssessment }
      : {}),
    ...(input.decomposition !== undefined ? { decomposition: input.decomposition } : {}),
    ...(input.retryPolicy === undefined && input.assignment?.retryPolicy !== undefined
      ? { retryPolicy: input.assignment.retryPolicy }
      : {}),
    ...(input.costCeilingUsd === undefined && input.assignment?.costCeilingUsd !== undefined
      ? { costCeilingUsd: input.assignment.costCeilingUsd }
      : {}),
  };
  applyCompletedAtForStatus(task, now);
  return task;
}

export function cloneTaskForBoard(
  board: KanbanBoard,
  source: KanbanTask,
  options: CloneTaskForBoardOptions,
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
    ...(source.dueDate !== undefined ? { dueDate: source.dueDate } : {}),
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
    ...(source.retryPolicy !== undefined ? { retryPolicy: source.retryPolicy } : {}),
    ...(source.costCeilingUsd !== undefined ? { costCeilingUsd: source.costCeilingUsd } : {}),
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
    ...(source.lifecycle !== undefined
      ? {
          lifecycle: {
            ...source.lifecycle,
            history: source.lifecycle.history.map((entry) => ({
              ...entry,
              ...(entry.attachment ? { attachment: { ...entry.attachment } } : {}),
            })),
          },
        }
      : {}),
    ...(source.boundary !== undefined
      ? { boundary: normalizeKanbanBoundaryPolicy(source.boundary) }
      : {}),
    ...(source.atomic !== undefined ? { atomic: source.atomic } : {}),
    ...(source.expectedFileChanges !== undefined
      ? { expectedFileChanges: [...source.expectedFileChanges] }
      : {}),
    ...(source.verificationReport !== undefined
      ? { verificationReport: { ...source.verificationReport } }
      : {}),
    ...(source.atomicityAssessment !== undefined
      ? { atomicityAssessment: { ...source.atomicityAssessment } }
      : {}),
    ...(source.decomposition !== undefined ? { decomposition: { ...source.decomposition } } : {}),
  };
  if (source.completedAt !== undefined && task.status === 'completed') {
    task.completedAt = source.completedAt;
  } else {
    applyCompletedAtForStatus(task, now);
  }
  return task;
}

export function applyTaskPatch(
  board: KanbanBoard,
  task: KanbanTask,
  input: UpdateKanbanTaskInput,
): void {
  const now = nowIso();
  const previousColumnId = task.columnId;
  const previousChainId = task.chain?.chainId;
  let shouldReorder = false;
  if (input.title !== undefined) task.title = requireNonBlank(input.title, 'Kanban task title');
  if (input.description !== undefined) task.description = input.description;
  if (input.dueDate !== undefined) {
    if (input.dueDate === null) delete task.dueDate;
    else task.dueDate = input.dueDate;
  }
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
  if (input.type !== undefined) task.type = input.type;
  if (input.status !== undefined) {
    task.status = input.status;
    if (input.columnId === undefined) {
      syncTaskColumnForStatus(board, task, previousColumnId);
      shouldReorder = false;
    }
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
    if (previousChainId && previousChainId !== task.chain?.chainId) {
      normalizeChainMetadata(board, previousChainId);
    }
    if (task.chain?.chainId) normalizeChainMetadata(board, task.chain.chainId);
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
  if (input.retryPolicy !== undefined) {
    if (input.retryPolicy === null) delete task.retryPolicy;
    else task.retryPolicy = input.retryPolicy;
  }
  if (input.costCeilingUsd !== undefined) {
    if (input.costCeilingUsd === null) delete task.costCeilingUsd;
    else task.costCeilingUsd = input.costCeilingUsd;
  }
  if (input.successCriteria !== undefined) task.successCriteria = input.successCriteria;
  if (input.goalMetrics !== undefined) task.goalMetrics = input.goalMetrics;
  if (input.links !== undefined) task.links = input.links;
  if (input.lifecycle !== undefined) {
    if (input.lifecycle === null) delete task.lifecycle;
    else {
      task.lifecycle = {
        ...input.lifecycle,
        history: input.lifecycle.history.map((entry) => ({
          ...entry,
          ...(entry.attachment ? { attachment: { ...entry.attachment } } : {}),
        })),
      };
    }
  }
  if (input.boundary !== undefined) {
    if (input.boundary === null) delete task.boundary;
    else task.boundary = normalizeKanbanBoundaryPolicy(input.boundary);
  }
  if (input.atomic !== undefined) {
    if (input.atomic === null) delete task.atomic;
    else task.atomic = input.atomic;
  }
  if (input.expectedFileChanges !== undefined) {
    if (input.expectedFileChanges === null) delete task.expectedFileChanges;
    else task.expectedFileChanges = input.expectedFileChanges;
  }
  if (input.verificationReport !== undefined) {
    if (input.verificationReport === null) {
      if (board.lifecycle?.mode !== 'managed') delete task.verificationReport;
    } else {
      task.verificationReport = { ...input.verificationReport };
    }
  }
  if (input.atomicityAssessment !== undefined) {
    if (input.atomicityAssessment === null) delete task.atomicityAssessment;
    else task.atomicityAssessment = { ...input.atomicityAssessment };
  }
  if (input.decomposition !== undefined) {
    if (input.decomposition === null) delete task.decomposition;
    else task.decomposition = { ...input.decomposition };
  }
  if (shouldReorder) {
    if (previousColumnId !== task.columnId) normalizeColumnTaskOrders(board, previousColumnId);
    placeTaskInColumn(board, task, task.columnId, task.order);
  }
  task.updatedAt = now;
  board.updatedAt = now;
}

export function cloneChecks(checks: readonly KanbanCheck[]): KanbanCheck[] {
  return checks.map((check) => ({ ...check, id: randomUUID() }));
}

export function cloneGoalMetrics(metrics: readonly KanbanGoalMetric[]): KanbanGoalMetric[] {
  const now = nowIso();
  return metrics.map((metric) => ({ ...metric, id: randomUUID(), updatedAt: now }));
}

export function optionalArray<K extends string, T>(
  key: K,
  values: readonly T[],
): Record<K, T[]> | Record<string, never> {
  return values.length ? ({ [key]: [...values] } as Record<K, T[]>) : {};
}

export function mergedTaskDescription(tasks: readonly KanbanTask[]): string {
  return tasks
    .map((task) =>
      [`## ${task.title}`, task.description, task.notes?.map((note) => note.content).join('\n')]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

export function highestPriority(tasks: readonly KanbanTask[]): KanbanTaskPriority {
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

import { randomUUID } from 'node:crypto';
import { assessAtomicity, candidateFromKanbanTask } from '../atomicity/assess.js';
import { normalizeKanbanBoundaryPolicy } from '../boundary.js';
import { appendKanbanEvent, mutateBoard } from '../storage.js';
import {
  type AssignKanbanTaskInput,
  type ClaimKanbanTaskInput,
  type CopyKanbanTaskOptions,
  type CreateKanbanTaskInput,
  DEFAULT_COLUMNS,
  type KanbanAgentAssignment,
  type KanbanAgentRunStatus,
  type KanbanBoard,
  type KanbanCheck,
  type KanbanColumn,
  type KanbanEvent,
  type KanbanGoalMetric,
  type KanbanSearchInput,
  type KanbanTask,
  type KanbanTaskPriority,
  type UpdateKanbanTaskInput,
} from '../types.js';
import { areDependenciesMet } from './task-readiness.js';
import { findTask } from './task-lookup.js';
export { findTask } from './task-lookup.js';
import { hasDependencyPath } from './dependency-helpers.js';
export {
  assertNoDependencyCycles,
  hasDependencyPath,
  remapIdList,
  remapTaskReferences,
} from './dependency-helpers.js';
import {
  nowIso,
  requireNonBlank,
  slugify,
  statusForColumn,
  uniqueIdFromSet,
  uniqueStrings,
} from './basic-helpers.js';
import {
  applyCompletedAtForStatus,
  existingColumnId,
  normalizeColumnTaskOrders,
  nextTaskOrder,
  placeTaskInColumn,
  syncTaskColumnForStatus,
} from './task-column-helpers.js';
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
  isAssignmentHeartbeatDue,
  later,
  msUntilExpiry,
  selectRecoveryMode,
} from './recovery.js';
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

export function normalizeColumns(columns: KanbanColumn[] | undefined): KanbanColumn[] {
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
    // Sprint 3: mirror policy fields from assignment to durable task level.
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
    if (input.verificationReport === null) delete task.verificationReport;
    else task.verificationReport = { ...input.verificationReport };
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
    // Managed lifecycle: only dispatch tasks that are in the 'todo'
    // lifecycle stage (ready for work). Create a queued assignment with
    // lease metadata (reserve phase) but do NOT advance the lifecycle or
    // change column/status — those belong to transitionTask.
    if (board.lifecycle?.mode === 'managed') {
      const candidates = input.taskId
        ? [findTask(board, input.taskId)].filter((task): task is KanbanTask => Boolean(task))
        : board.tasks.filter((task) => isTaskReadyForWork(board, task)).sort(compareTasksForWork);
      const task = candidates.find(
        (candidate) => isTaskReadyForWork(board, candidate) && candidate.lifecycle?.currentStage === 'todo',
      );
      if (!task) {
        // No task is in the 'todo' lifecycle stage. The board may have ready
        // tasks that are still in 'backlog' (not yet transitioned to the work
        // queue). Return null — the caller sees no claimable work — but log
        // the distinction so operators can diagnose stage-blocked tasks.
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
      // Preserve lifecycle ownership of column/status: do NOT call
      // syncTaskColumnForStatus. The card stays in its current lifecycle
      // stage (todo) with the correct managed column and status.
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
  // Child-before-parent: tasks with a parentTaskId are preferred over tasks
  // that have childTaskIds (i.e., composite/parent tasks). This ensures
  // constituent work is dispatched before the parent, matching the atomic
  // gate semantics that prevent a parent from reaching Done until children
  // are complete. Only applies when both tasks are at the same priority.
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

export function resolveTaskRefs(board: KanbanBoard, taskRefs: readonly string[]): KanbanTask[] {
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

export function findGoalMetric(
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

export function addDependencyToTask(
  board: KanbanBoard,
  task: KanbanTask,
  dependency: KanbanTask,
): void {
  if (task.id === dependency.id) throw new Error('A kanban task cannot depend on itself.');
  if (hasDependencyPath(board, dependency.id, task.id)) {
    throw new Error(`Adding dependency ${dependency.id} would create a dependency cycle.`);
  }
  task.dependsOn = uniqueStrings([...(task.dependsOn ?? []), dependency.id]);
}

export function setChainMetadata(
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

export function normalizeChainMetadata(board: KanbanBoard, chainId: string): void {
  const tasks = tasksInChain(board, chainId);
  if (tasks.length) setChainMetadata(board, tasks, chainId, false);
}

export function tasksInChain(board: KanbanBoard, chainId: string): KanbanTask[] {
  return board.tasks
    .filter((task) => task.chain?.chainId === chainId)
    .sort(
      (a, b) =>
        (a.chain?.order ?? 0) - (b.chain?.order ?? 0) || a.createdAt.localeCompare(b.createdAt),
    );
}

export function rewireDependents(
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

export function uniqueColumnId(board: KanbanBoard, requested: string): string {
  const base = slugify(requested) || 'column';
  let candidate = base;
  let suffix = 2;
  while (board.columns.some((column) => column.id === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function normalizeDependencyIds(
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

export function isTaskReadyForWork(board: KanbanBoard, task: KanbanTask): boolean {
  if (!['pending', 'ready'].includes(task.status)) return false;
  // An OWNED 'assigned' assignment blocks claiming too: buildAssignment's
  // DEFAULT status is 'assigned', so omitting it left every assignTask'd
  // task open to claimReadyTaskOnBoard, which overwrote the assignment and
  // inherited the previous agentId/leaseId — a double claim. An OWNERLESS
  // 'assigned' record (assignTask with routing/skills but no agentId) is a
  // configuration template awaiting a claimer and stays claimable — the
  // claim fills in the agent identity, inheriting only the configuration
  // (pinned by the "configured task" claim test in manager.test.ts).
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
  // Enforced atomicity: a childless leaf judged too large must be split
  // before it can be claimed or dispatched.
  if (
    board.atomicity?.mode === 'enforce' &&
    !task.childTaskIds?.length &&
    task.atomicityAssessment?.verdict === 'needs_decomposition'
  ) {
    return false;
  }
  return true;
}

/**
 * Stamp (or refresh) the deterministic atomicity assessment on a task.
 * No-op when the board policy mode is 'off'. Mutates in place — callers run
 * inside a `mutateBoard` closure.
 */
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

export function createKanbanEvent(
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
    ...(task.assignment?.subagentId !== undefined
      ? { subagentId: task.assignment.subagentId }
      : {}),
    ...(task.assignment?.runTaskId !== undefined ? { runTaskId: task.assignment.runTaskId } : {}),
    ...details,
  };
}

export async function emitKanbanEvent(projectRoot: string, event: KanbanEvent): Promise<void> {
  try {
    await appendKanbanEvent(projectRoot, event.boardId, event);
  } catch (error) {
    // Event logging is observability-only; current board state must remain
    // authoritative. Log the failure so operators can detect audit gaps.
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[kanban] emitKanbanEvent: failed to append event ${event.type} ` +
      `for board ${event.boardId}: ${msg}\n`,
    );
  }
}

export function assignmentEventType(status: KanbanAgentRunStatus): string {
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

import { randomUUID } from 'node:crypto';
import { appendKanbanEvent, listBoardSummaries, mutateBoard } from '../storage.js';
import type { TaskEdge, TaskGraph, TaskNode, TaskStatus, TaskType } from '../types/task-graph.js';
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
  type KanbanRecoveryMode,
  type KanbanRecoveryPolicy,
  type KanbanSearchInput,
  type KanbanTask,
  type KanbanTaskPriority,
  type KanbanTaskStatus,
  type UpdateKanbanTaskInput,
} from '../types.js';
import { getBoard } from './boards.js';
import { areDependenciesMet } from './dependencies.js';
import type { CreateKanbanBoardFromTaskGraphOptions } from './task-graph-bridge.js';

export function isAssignmentHeartbeatDue(
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

export async function collectBoardsForHealth(
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

export function findTask(board: KanbanBoard, taskId: string): KanbanTask | undefined {
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

export function remapTaskReferences(
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

export function remapIdList(
  ids: string[] | undefined,
  idMap: Map<string, string>,
): string[] | undefined {
  const remapped = (ids ?? []).map((id) => idMap.get(id)).filter((id): id is string => Boolean(id));
  return remapped.length ? remapped : undefined;
}

export function hasDependencyPath(
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

export function assertNoDependencyCycles(board: KanbanBoard): void {
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

export function existingColumnId(
  board: KanbanBoard,
  columnId: string | undefined,
): string | undefined {
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

export function uniqueIdFromSet(usedIds: Set<string>, requested: string): string {
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

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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
  if (task.assignment && ['queued', 'running'].includes(task.assignment.status)) return false;
  if (task.mergedIntoTaskId) return false;
  if (!areDependenciesMet(board, task.id)) return false;
  return true;
}

export function taskGraphStatusToKanbanStatus(status: TaskStatus): KanbanTaskStatus {
  if (status === 'in_progress') return 'in_progress';
  if (status === 'completed') return 'completed';
  if (status === 'review') return 'review';
  if (status === 'blocked') return 'blocked';
  if (status === 'failed') return 'failed';
  return 'pending';
}

export function kanbanStatusToTaskGraphStatus(task: KanbanTask): TaskStatus {
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

export function taskInputFromGraphNode(
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
    type: node.type,
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

export function applyGraphNodeToTask(
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
  task.type = node.type;
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

export function applyTaskGraphRelationships(
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

export function buildTaskGraphMetadata(
  board: KanbanBoard,
  task: KanbanTask,
): Record<string, unknown> {
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

export function taskToTaskGraphNode(
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
    type: task.type ?? inferTaskType(task),
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

export function taskGraphEdgesFromBoard(
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

export function inferTaskType(task: KanbanTask): TaskType {
  const signals = [task.title, task.description, ...(task.labels ?? [])].join(' ').toLowerCase();
  if (/\bbug|fix|defect|regression\b/.test(signals)) return 'bugfix';
  if (/\brefactor|cleanup|cleanup\b/.test(signals)) return 'refactor';
  if (/\bdoc|docs|readme|documentation\b/.test(signals)) return 'docs';
  if (/\btest|spec|coverage|verify\b/.test(signals)) return 'test';
  if (/\bchore|maintenance|deps|dependency\b/.test(signals)) return 'chore';
  return 'feature';
}

export function findTaskByOrigin(
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

export function isTaskFromGraph(
  task: KanbanTask,
  graphId: string,
  phaseId: string | undefined,
): boolean {
  return (
    task.origin?.graphId === graphId && (phaseId === undefined || task.origin.phaseId === phaseId)
  );
}

export function columnIdForTaskGraphStatus(board: KanbanBoard, status: TaskStatus): string {
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
  } catch {
    // Event logging is observability-only; current board state must remain authoritative.
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

export function columnIdForKanbanStatus(
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

export function normalizeColumnTaskOrders(board: KanbanBoard, columnId: string): void {
  board.tasks
    .filter((task) => task.columnId === columnId)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    .forEach((task, index) => {
      task.order = index;
    });
}

export function syncTaskColumnForStatus(
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

export function placeTaskInColumn(
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

export function nextTaskOrder(
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

export function clampOrder(order: number | undefined, max: number): number {
  if (!Number.isFinite(order)) return max;
  return Math.max(0, Math.min(Math.trunc(order as number), max));
}

export function applyCompletedAtForStatus(task: KanbanTask, timestamp: string): void {
  if (task.status === 'completed') task.completedAt = task.completedAt ?? timestamp;
  else delete task.completedAt;
}

export function statusForColumn(columnId: string): KanbanTaskStatus {
  const normalized = columnId.toLowerCase();
  if (normalized.includes('done') || normalized.includes('complete')) return 'completed';
  if (normalized.includes('progress') || normalized.includes('doing')) return 'in_progress';
  if (normalized.includes('review')) return 'review';
  if (normalized.includes('block')) return 'blocked';
  if (normalized.includes('ready')) return 'ready';
  return 'pending';
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty.`);
  return trimmed;
}

export function parseIsoTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isoFromTimestamp(value: number | undefined, fallback: string): string {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return new Date(value).toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

import type { KanbanBoard, KanbanGoalMetric, KanbanTask } from '../types.js';
import { nowIso, slugify, uniqueStrings } from './basic-helpers.js';
import { hasDependencyPath } from './dependency-helpers.js';
import { findTask } from './task-lookup.js';

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

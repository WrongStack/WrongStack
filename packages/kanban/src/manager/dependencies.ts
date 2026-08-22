import { randomUUID } from 'node:crypto';
import { mutateBoard, readBoard } from '../storage.js';
import type { KanbanBoard, KanbanBoundaryPolicy, KanbanEvent, KanbanTask } from '../types.js';
import type {
  KanbanSearchInput,
  KanbanSearchResult,
  MergeKanbanTasksInput,
  SetKanbanTaskChainInput,
  SplitKanbanTaskInput,
} from '../types-operations.js';
import {
  addDependencyToTask,
  cloneChecks,
  cloneGoalMetrics,
  createKanbanEvent,
  createTaskObject,
  emitKanbanEvent,
  existingColumnId,
  findTask,
  highestPriority,
  mergedTaskDescription,
  nextTaskOrder,
  normalizeChainMetadata,
  normalizeColumnTaskOrders,
  nowIso,
  placeTaskInColumn,
  requireNonBlank,
  resolveTaskRefs,
  rewireDependents,
  setChainMetadata,
  stampAtomicityAssessment,
  tasksInChain,
  uniqueStrings,
} from './_internal.js';
import { archiveManagedTask, initializeAndValidateManagedTask } from './lifecycle.js';
import { searchKanban } from './serialization.js';

export {
  areDependenciesMet,
  getDependencyReadinessIssues,
  type KanbanDependencyReadinessIssue,
} from './task-readiness.js';

export async function addDependency(
  projectRoot: string,
  boardId: string,
  taskId: string,
  dependencyTaskId: string,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    const dependency = findTask(board, dependencyTaskId);
    if (!task || !dependency) return null;
    addDependencyToTask(board, task, dependency);
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, 'task.dependency.added', {
      after: { dependsOn: dependency.id },
    });
    return task;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function splitTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: SplitKanbanTaskInput,
): Promise<{ board: KanbanBoard; parent: KanbanTask; children: KanbanTask[] } | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const parent = findTask(board, taskId);
    if (!parent) return null;
    const titles = input.titles.map((title) => requireNonBlank(title, 'Kanban split task title'));
    if (!titles.length) throw new Error('splitTask requires at least one child title.');
    const requestedColumnId = input.columnId ?? parent.columnId;
    const columnId = existingColumnId(board, requestedColumnId);
    if (!columnId) throw new Error(`Column not found: ${requestedColumnId}`);
    const childColumnId =
      board.lifecycle?.mode === 'managed' ? board.lifecycle.columns.backlog : columnId;
    const children: KanbanTask[] = [];
    const startOrder = nextTaskOrder(board, childColumnId);
    for (let index = 0; index < titles.length; index++) {
      const title = titles[index];
      if (!title) continue;
      const spec = input.childSpecs?.[index];
      const child = createTaskObject(board, {
        title,
        columnId: childColumnId,
        order: startOrder + index,
        priority: parent.priority,
        parentTaskId: parent.id,
        ...(spec?.description !== undefined
          ? { description: spec.description }
          : parent.description !== undefined
            ? { description: parent.description }
            : {}),
        ...(spec?.successCriteria !== undefined ? { successCriteria: spec.successCriteria } : {}),
        ...(spec?.expectedFileChanges !== undefined
          ? { expectedFileChanges: spec.expectedFileChanges }
          : {}),
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
        ...(input.inheritSuccessCriteria === true &&
        parent.successCriteria !== undefined &&
        spec?.successCriteria === undefined
          ? { successCriteria: cloneChecks(parent.successCriteria) }
          : {}),
        ...(input.inheritGoalMetrics === true && parent.goalMetrics !== undefined
          ? { goalMetrics: cloneGoalMetrics(parent.goalMetrics) }
          : {}),
        // A split must never drop the parent's execution ceiling. Unlike
        // descriptive metadata, boundaries are always inherited.
        ...(parent.boundary !== undefined ? { boundary: parent.boundary } : {}),
      });
      initializeAndValidateManagedTask(board, child);
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
    if (input.atomic === true) parent.atomic = true;
    for (const child of children) stampAtomicityAssessment(board, child);
    // The parent just became (or stayed) a container: refresh to 'composite'.
    stampAtomicityAssessment(board, parent);
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
    normalizeColumnTaskOrders(board, childColumnId);
    board.updatedAt = now;
    event = createKanbanEvent(board.id, parent, 'task.split', {
      after: { children: children.map((child) => child.id) },
    });
    return { parent, children };
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? { board: updated.board, ...updated.result } : null;
}

export async function mergeTasks(
  projectRoot: string,
  boardId: string,
  input: MergeKanbanTasksInput,
): Promise<{ board: KanbanBoard; task: KanbanTask; sourceTasks: KanbanTask[] } | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const sourceTasks = resolveTaskRefs(board, input.taskIds);
    if (sourceTasks.length < 2) throw new Error('mergeTasks requires at least two tasks.');
    const sourceIds = new Set(sourceTasks.map((task) => task.id));
    const requestedColumnId = input.targetColumnId ?? sourceTasks[0]?.columnId;
    const columnId = existingColumnId(board, requestedColumnId);
    if (!columnId) throw new Error(`Column not found: ${input.targetColumnId ?? ''}`);
    const mergedColumnId =
      board.lifecycle?.mode === 'managed' ? board.lifecycle.columns.backlog : columnId;
    const dependencies = uniqueStrings(
      sourceTasks.flatMap((task) => task.dependsOn ?? []).filter((depId) => !sourceIds.has(depId)),
    );
    const mergedBoundary = mergeTaskBoundaries(sourceTasks);
    const merged = createTaskObject(board, {
      title: input.title,
      description: input.description ?? mergedTaskDescription(sourceTasks),
      columnId: mergedColumnId,
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
      ...(mergedBoundary !== undefined ? { boundary: mergedBoundary } : {}),
    });
    merged.mergedFromTaskIds = [...sourceIds];
    initializeAndValidateManagedTask(board, merged);
    board.tasks.push(merged);
    placeTaskInColumn(board, merged, merged.columnId, merged.order);

    const now = nowIso();
    for (const source of sourceTasks) {
      source.mergedIntoTaskId = merged.id;
      if (input.closeSourceTasks !== false) {
        archiveManagedTask(board, source, { at: now, reason: `Merged into ${merged.id}` });
      }
      source.updatedAt = now;
    }
    rewireDependents(board, [...sourceIds], [merged.id], [merged.id, ...sourceIds]);
    board.updatedAt = now;
    event = createKanbanEvent(board.id, merged, 'task.merged', {
      note: `merged ${sourceTasks.length} tasks`,
    });
    return { task: merged, sourceTasks };
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? { board: updated.board, ...updated.result } : null;
}

function mergeTaskBoundaries(tasks: readonly KanbanTask[]): KanbanBoundaryPolicy | undefined {
  const policies = tasks
    .map((task) => task.boundary)
    .filter((policy): policy is KanbanBoundaryPolicy => policy?.enabled === true);
  if (policies.length === 0) return undefined;
  const first = policies[0]!;
  if (policies.every((policy) => policiesEqual(policy, first))) {
    return first;
  }
  return {
    enabled: true,
    enforcement: 'block',
    shellAccess: 'block',
    allow: [
      {
        kind: 'file',
        access: 'read_write',
        path: '.wrongstack/boundary-review-required',
        note: 'Merged tasks had incompatible boundaries; explicitly define the merged task scope.',
      },
    ],
    deny: policies.flatMap((policy) => policy.deny ?? []),
  };
}

/**
 * Structural equality for boundary policies. Compares scalar fields directly
 * and sorts `allow`/`deny` entries by a canonical key so two semantically
 * equivalent policies whose selector arrays are in different orders are
 * treated as the same policy. Required because `JSON.stringify` compares
 * object-key order, which made equivalent-but-reordered policies look
 * incompatible and downgraded merges to the conservative sentinel.
 */
function policiesEqual(a: KanbanBoundaryPolicy, b: KanbanBoundaryPolicy): boolean {
  if (a === b) return true;
  if (a.enabled !== b.enabled) return false;
  if (a.enforcement !== b.enforcement) return false;
  if (a.shellAccess !== b.shellAccess) return false;
  if (!selectorsEqual(a.allow, b.allow)) return false;
  const aDeny = a.deny ?? [];
  const bDeny = b.deny ?? [];
  return selectorsEqual(aDeny, bDeny);
}

function selectorsEqual(
  a: readonly { kind: string; path: string; access: string; note?: string | undefined }[],
  b: readonly { kind: string; path: string; access: string; note?: string | undefined }[],
): boolean {
  if (a.length !== b.length) return false;
  const key = (s: { kind: string; path: string; access: string; note?: string | undefined }) =>
    `${s.kind}\u0000${s.path}\u0000${s.access}\u0000${s.note ?? ''}`;
  const aSorted = [...a].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  const bSorted = [...b].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  for (let i = 0; i < aSorted.length; i++) {
    if (key(aSorted[i]!) !== key(bSorted[i]!)) return false;
  }
  return true;
}

export async function setTaskChain(
  projectRoot: string,
  boardId: string,
  input: SetKanbanTaskChainInput,
): Promise<{ board: KanbanBoard; chainId: string; tasks: KanbanTask[] } | null> {
  let event: KanbanEvent | undefined;
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
    const head = tasks[0];
    if (head) event = createKanbanEvent(board.id, head, 'task.chain.set', { after: { chainId } });
    return { chainId, tasks };
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
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

export async function listReadyTasks(
  projectRoot: string,
  input: KanbanSearchInput & { limit?: number | undefined } = {},
): Promise<KanbanSearchResult[]> {
  const results = await searchKanban(projectRoot, { ...input, readyOnly: true });
  return input.limit && input.limit > 0 ? results.slice(0, input.limit) : results;
}

export function findBlockedTasks(board: KanbanBoard, taskId: string): KanbanTask[] {
  const sourceTask = findTask(board, taskId);
  if (!sourceTask) return [];
  return board.tasks.filter(
    (task) => task.dependsOn?.includes(sourceTask.id) && task.status !== 'completed',
  );
}

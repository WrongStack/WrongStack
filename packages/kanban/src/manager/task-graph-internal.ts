import { normalizeKanbanBoundaryPolicy } from '../boundary.js';
import type { TaskEdge, TaskGraph, TaskNode, TaskStatus, TaskType } from '../types/task-graph.js';
import type { KanbanBoard, KanbanBoundaryPolicy, KanbanTask, KanbanTaskStatus } from '../types.js';
import type { CreateKanbanTaskInput } from '../types-operations.js';
import {
  isoFromTimestamp,
  parseIsoTimestamp,
  requireNonBlank,
  uniqueIdFromSet,
  uniqueStrings,
} from './basic-helpers.js';
import {
  applyCompletedAtForStatus,
  existingColumnId,
  normalizeColumnTaskOrders,
  placeTaskInColumn,
} from './task-column-helpers.js';
import type { CreateKanbanBoardFromTaskGraphOptions } from './task-graph-contracts.js';

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
  const kanbanMetadata =
    node.metadata?.['kanban'] && typeof node.metadata['kanban'] === 'object'
      ? (node.metadata['kanban'] as Record<string, unknown>)
      : undefined;
  const boundary =
    kanbanMetadata?.['boundary'] && typeof kanbanMetadata['boundary'] === 'object'
      ? (kanbanMetadata['boundary'] as KanbanBoundaryPolicy)
      : undefined;
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
    ...(boundary !== undefined ? { boundary } : {}),
    origin: {
      system: options.sourceSystem ?? 'task-graph',
      graphId: graph.id,
      taskId: node.id,
      specId: graph.specId,
      ...(node.specRequirementId !== undefined
        ? { specRequirementId: node.specRequirementId }
        : {}),
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
    ...(node.specRequirementId !== undefined ? { specRequirementId: node.specRequirementId } : {}),
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
  if (task.boundary !== undefined) kanban.boundary = normalizeKanbanBoundaryPolicy(task.boundary);
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
    ...(task.origin?.specRequirementId !== undefined
      ? { specRequirementId: task.origin.specRequirementId }
      : {}),
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
      (task.origin?.graphId === graphId &&
        task.origin?.taskId === nodeId &&
        (phaseId === undefined || task.origin.phaseId === phaseId)) ||
      (task.id === nodeId && task.origin === undefined),
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

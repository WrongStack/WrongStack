import { createBoardObject, mutateBoard, readBoard, writeBoard } from '../storage.js';
import { DEFAULT_COLUMNS, type KanbanBoard } from '../types.js';
import type { PhaseGraph, PhaseNode } from '../types/phase-graph.js';
import type { TaskGraph, TaskNode } from '../types/task-graph.js';
import type {
  CreateKanbanBoardFromTaskGraphOptions,
  SyncKanbanBoardFromTaskGraphOptions,
} from './task-graph-contracts.js';
export type {
  CreateKanbanBoardFromTaskGraphOptions,
  SyncKanbanBoardFromTaskGraphOptions,
} from './task-graph-contracts.js';
import {
  assertNoDependencyCycles,
  createTaskObject,
  normalizeAllColumnTaskOrders,
  nowIso,
  parseIsoTimestamp,
  placeTaskInColumn,
  requireNonBlank,
  uniqueIdFromSet,
  uniqueStrings,
} from './_internal.js';
import {
  applyGraphNodeToTask,
  applyTaskGraphRelationships,
  columnIdForTaskGraphStatus,
  findTaskByOrigin,
  isTaskFromGraph,
  taskGraphEdgesFromBoard,
  taskGraphStatusToKanbanStatus,
  taskInputFromGraphNode,
  taskToTaskGraphNode,
} from './task-graph-internal.js';

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
    if (board.lifecycle?.mode === 'managed') {
      throw new Error(
        'Task-graph synchronization cannot overwrite a managed Kanban Agent board. Import into a legacy board, then adopt cards through Backlog.',
      );
    }
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
      tags: uniqueStrings(['goal', graph.id, phase.id]),
      generatedBy: `goal:${graph.id}:${phase.id}`,
      sourceSystem: 'goal',
      phaseId: phase.id,
      includeCompletedTasks: options.includeCompletedTasks,
    });
    boards.push({ phase, ...imported });
  }
  return boards;
}

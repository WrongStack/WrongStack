import { createBoardObject, mutateBoard, readBoard, writeBoard } from '../storage.js';
import type { PhaseGraph, PhaseNode } from '../types/phase-graph.js';
import type { TaskGraph, TaskNode } from '../types/task-graph.js';
import type { KanbanBoard } from '../types.js';
import { DEFAULT_COLUMNS } from '../types-operations.js';
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
import { archiveManagedTask } from './lifecycle.js';
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
  assertDeclaredRequirementCoverage(graph);
  const board = createBoardObject({
    title: requireNonBlank(options.title ?? graph.title, 'Kanban board title'),
    description: options.description ?? `Imported from task graph ${graph.id}`,
    tags: uniqueStrings([...(options.tags ?? []), options.sourceSystem ?? 'task-graph', graph.id]),
    generatedBy: options.generatedBy ?? `${options.sourceSystem ?? 'task-graph'}:${graph.id}`,
    columns: DEFAULT_COLUMNS.map((column) => ({ ...column })),
  });
  if (graph.requiredRequirementIds !== undefined) {
    applyDeclaredRequirementScope(board, graph, options.sourceSystem ?? 'task-graph', true);
  }
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
        ...(node.specRequirementId !== undefined
          ? { specRequirementId: node.specRequirementId }
          : {}),
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
  assertDeclaredRequirementCoverage(graph);
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
    applyDeclaredRequirementScope(
      board,
      graph,
      sourceSystem,
      options.allowRequirementScopeShrink === true,
    );

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
        archiveManagedTask(board, task, {
          at: now,
          reason: 'Dropped from the source task graph',
        });
        delete task.assignment;
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

function assertDeclaredRequirementCoverage(graph: TaskGraph): void {
  if (graph.requiredRequirementIds === undefined) return;
  const required = new Set(graph.requiredRequirementIds.map((id) => id.trim()).filter(Boolean));
  const mapped = new Set(
    Array.from(graph.nodes.values()).flatMap((node) =>
      node.specRequirementId ? [node.specRequirementId] : [],
    ),
  );
  const missing = Array.from(required).filter((id) => !mapped.has(id));
  const unknown = Array.from(mapped).filter((id) => !required.has(id));
  if (!missing.length && !unknown.length) return;
  const problems = [
    missing.length ? `missing task coverage for ${missing.join(', ')}` : '',
    unknown.length ? `unknown requirement mappings ${unknown.join(', ')}` : '',
  ].filter(Boolean);
  throw new Error(`Task graph requirement coverage is invalid: ${problems.join('; ')}.`);
}

function writeRequirementScopes(
  board: KanbanBoard,
  scopes: NonNullable<KanbanBoard['requirementScopes']>,
): void {
  board.requirementScopes = scopes;
  board.requiredRequirementIds = uniqueStrings(
    scopes.flatMap((candidate) => candidate.requirementIds),
  );
}

function applyDeclaredRequirementScope(
  board: KanbanBoard,
  graph: TaskGraph,
  sourceSystem: string,
  allowShrink: boolean,
): void {
  const scopes = [...(board.requirementScopes ?? [])];
  const index = scopes.findIndex((scope) => scope.graphId === graph.id);

  // A graph that declares no scope is not spec-backed — observational session
  // mirrors and ad-hoc imports have no requirement contract to uphold. Release
  // any scope it registered under an older declaration instead of returning
  // early: a stored scope that outlives its declaration makes every later sync
  // fail the shrink guard below forever, silently freezing the board.
  if (graph.requiredRequirementIds === undefined) {
    if (index < 0) return;
    scopes.splice(index, 1);
    writeRequirementScopes(board, scopes);
    return;
  }

  const nextIds = uniqueStrings(graph.requiredRequirementIds);
  const previous = index >= 0 ? scopes[index] : undefined;
  if (previous && !allowShrink) {
    const next = new Set(nextIds);
    const removed = previous.requirementIds.filter((id) => !next.has(id));
    const unresolved = removed.filter((requirementId) => {
      const coveringTasks = board.tasks.filter(
        (task) =>
          task.origin?.graphId === graph.id && task.origin?.specRequirementId === requirementId,
      );
      return (
        coveringTasks.length === 0 || coveringTasks.some((task) => task.status !== 'completed')
      );
    });
    if (unresolved.length > 0) {
      throw new Error(
        `Task graph requirement scope cannot shrink during ordinary sync; explicitly resolve or cancel: ${unresolved.join(', ')}.`,
      );
    }
  }
  const scope = {
    graphId: graph.id,
    specId: graph.specId,
    sourceSystem,
    requirementIds: nextIds,
    updatedAt: nowIso(),
  };
  if (index >= 0) scopes[index] = scope;
  else scopes.push(scope);
  writeRequirementScopes(board, scopes);
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
    ...(board.requiredRequirementIds !== undefined
      ? { requiredRequirementIds: [...board.requiredRequirementIds] }
      : {}),
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

import { randomUUID } from 'node:crypto';
import { normalizeKanbanBoundaryPolicy } from './boundary.js';
import type { KanbanBoard, KanbanBoardKind, KanbanBoardMeta, KanbanBoardSummary } from './types.js';
import { CURRENT_KANBAN_VERSION, DEFAULT_COLUMNS } from './types-operations.js';

export function summarizeBoard(board: KanbanBoard): KanbanBoardSummary {
  const total = board.tasks.length;
  const completed = board.tasks.filter((task) => task.status === 'completed').length;
  const lastActivity = latestActivity(board);
  return {
    id: board.id,
    title: board.title,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    columnCount: board.columns.length,
    taskCount: total,
    completedTaskCount: completed,
    ...(board.description !== undefined ? { description: board.description } : {}),
    ...(board.tags !== undefined ? { tags: board.tags } : {}),
    ...(board.kind !== undefined ? { kind: board.kind } : {}),
    ...(board.retention !== undefined ? { retention: board.retention } : {}),
    ...(board.presence !== undefined
      ? { presence: board.presence.map((entry) => ({ ...entry })) }
      : {}),
    ...(lastActivity !== undefined ? { lastActivity } : {}),
  };
}

export function boardMeta(board: KanbanBoard): KanbanBoardMeta {
  const summary = summarizeBoard(board);
  return {
    id: summary.id,
    title: summary.title,
    columnCount: summary.columnCount,
    taskCount: summary.taskCount,
    completedTaskCount: summary.completedTaskCount,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    ...(summary.description !== undefined ? { description: summary.description } : {}),
    ...(summary.tags !== undefined ? { tags: summary.tags } : {}),
    ...(summary.kind !== undefined ? { kind: summary.kind } : {}),
    ...(summary.retention !== undefined ? { retention: summary.retention } : {}),
    ...(summary.presence !== undefined
      ? { presence: summary.presence.map((entry) => ({ ...entry })) }
      : {}),
    ...(summary.lastActivity !== undefined ? { lastActivity: summary.lastActivity } : {}),
  };
}

export interface CreateBoardObjectOptions {
  title: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  columns?: KanbanBoard['columns'] | undefined;
  generatedBy?: string | undefined;
  supervisor?: KanbanBoard['supervisor'] | undefined;
  lifecycle?: KanbanBoard['lifecycle'] | undefined;
  boundary?: KanbanBoard['boundary'] | undefined;
  atomicity?: KanbanBoard['atomicity'] | undefined;
  completionGate?: KanbanBoard['completionGate'] | undefined;
  kind?: KanbanBoard['kind'] | undefined;
  retention?: KanbanBoard['retention'] | undefined;
}

export function createBoardObject(opts: CreateBoardObjectOptions): KanbanBoard {
  const now = new Date().toISOString();
  const board: KanbanBoard = {
    id: randomUUID(),
    title: opts.title,
    columns: opts.columns?.length
      ? opts.columns.map((column, index) => ({ ...column, order: column.order ?? index }))
      : DEFAULT_COLUMNS.map((column) => ({ ...column })),
    tasks: [],
    createdAt: now,
    updatedAt: now,
    version: CURRENT_KANBAN_VERSION,
    revision: 0,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
    ...(opts.generatedBy !== undefined ? { generatedBy: opts.generatedBy } : {}),
    ...(opts.supervisor !== undefined ? { supervisor: { ...opts.supervisor } } : {}),
    ...(opts.lifecycle !== undefined
      ? { lifecycle: { ...opts.lifecycle, columns: { ...opts.lifecycle.columns } } }
      : {}),
    ...(opts.boundary !== undefined
      ? { boundary: normalizeKanbanBoundaryPolicy(opts.boundary) }
      : {}),
    ...(opts.atomicity !== undefined
      ? {
          atomicity: {
            ...opts.atomicity,
            ...(opts.atomicity.config ? { config: { ...opts.atomicity.config } } : {}),
          },
        }
      : {}),
    ...(opts.completionGate !== undefined ? { completionGate: { ...opts.completionGate } } : {}),
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    ...(opts.retention !== undefined ? { retention: { ...opts.retention } } : {}),
  };
  // Apply kind inference so the returned object always has a kind, even
  // before the board is read back from disk (where normalizeBoard runs).
  board.kind = normalizeBoardKind(board);
  return board;
}

export function normalizeBoard(board: KanbanBoard): KanbanBoard {
  const now = new Date().toISOString();
  const columns = [...(board.columns?.length ? board.columns : DEFAULT_COLUMNS)]
    .map((column, index) => ({
      ...column,
      order:
        typeof column.order === 'number' && Number.isFinite(column.order) ? column.order : index,
    }))
    .sort((a, b) => a.order - b.order)
    .map((column, index) => ({ ...column, order: index }));
  const columnIds = new Set(columns.map((column) => column.id));
  const fallbackColumnId = columns[0]?.id ?? 'backlog';
  const tasks = normalizeTaskOrders(
    (board.tasks ?? []).map((task, index) => ({
      ...task,
      columnId: columnIds.has(task.columnId) ? task.columnId : fallbackColumnId,
      order: typeof task.order === 'number' && Number.isFinite(task.order) ? task.order : index,
      priority: task.priority ?? 'medium',
      status: task.status ?? 'pending',
      createdAt: task.createdAt ?? now,
      updatedAt: task.updatedAt ?? now,
    })),
  );
  return {
    ...board,
    version: board.version ?? CURRENT_KANBAN_VERSION,
    revision: board.revision ?? 0,
    createdAt: board.createdAt ?? now,
    updatedAt: board.updatedAt ?? now,
    // Default kind to 'project' for legacy boards. Detect session mirrors from
    // tags so old boards created before kind existed are still classified.
    kind: normalizeBoardKind(board),
    columns,
    tasks,
    ...(board.contractGraph
      ? { contractGraph: normalizeContractGraph(board.contractGraph, now) }
      : {}),
  };
}

function normalizeContractGraph(
  graph: NonNullable<KanbanBoard['contractGraph']>,
  now: string,
): NonNullable<KanbanBoard['contractGraph']> {
  const enforcement = ['off', 'advisory', 'strict'].includes(graph.enforcement)
    ? graph.enforcement
    : 'advisory';
  return {
    version: 1,
    enforcement,
    nodes: (Array.isArray(graph.nodes) ? graph.nodes : []).map((node) => ({
      ...node,
      enforcement: node.enforcement ?? 'blocking',
      state: node.state ?? 'unknown',
      createdAt: node.createdAt ?? now,
      updatedAt: node.updatedAt ?? now,
      ...(node.waiver ? { waiver: { ...node.waiver } } : {}),
      ...(node.metadata ? { metadata: { ...node.metadata } } : {}),
    })),
    edges: (Array.isArray(graph.edges) ? graph.edges : []).map((edge) => ({
      ...edge,
      enforcement: edge.enforcement ?? 'informational',
      createdAt: edge.createdAt ?? now,
    })),
    updatedAt: graph.updatedAt ?? now,
  };
}

/**
 * Infer board kind from tags when the explicit `kind` field is absent.
 * Boards tagged `session-work` are classified as `session_mirror`.
 * Boards created by `createBoardFromTaskGraph` with `generatedBy` containing
 * `session-kanban:` are also classified as `session_mirror`.
 * Boards with `generatedBy` containing `sdd` are classified as `sdd_mirror`.
 * Everything else defaults to `project`.
 */
function normalizeBoardKind(board: KanbanBoard): KanbanBoardKind {
  if (board.kind) return board.kind;
  const tags = board.tags ?? [];
  const generatedBy = board.generatedBy ?? '';
  if (tags.includes('session-work') || tags.some((tag) => tag.startsWith('session:'))) {
    return 'session_mirror';
  }
  if (generatedBy.startsWith('session-kanban:')) {
    return 'session_mirror';
  }
  if (generatedBy.includes('sdd') || tags.includes('sdd')) {
    return 'sdd_mirror';
  }
  return 'project';
}

function latestActivity(board: KanbanBoard): string | undefined {
  return [board.updatedAt, ...board.tasks.map((task) => task.updatedAt)]
    .filter(Boolean)
    .sort()
    .reverse()[0];
}

function normalizeTaskOrders(tasks: KanbanBoard['tasks']): KanbanBoard['tasks'] {
  const byColumn = new Map<string, KanbanBoard['tasks']>();
  for (const task of tasks) {
    const columnTasks = byColumn.get(task.columnId) ?? [];
    columnTasks.push(task);
    byColumn.set(task.columnId, columnTasks);
  }
  for (const columnTasks of byColumn.values()) {
    columnTasks
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
      .forEach((task, index) => {
        task.order = index;
      });
  }
  return tasks;
}

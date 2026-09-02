import type { HqKanbanSnapshotPayload } from '@wrongstack/core/hq';

const TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
const TASK_STATUSES = new Set([
  'pending',
  'ready',
  'in_progress',
  'review',
  'completed',
  'blocked',
  'failed',
  'archived',
]);

export interface HqKanbanTaskView {
  id: string;
  title: string;
  description?: string | undefined;
  columnId: string;
  order: number;
  priority: string;
  status: string;
  assignee?: string | undefined;
  assignmentStatus?: string | undefined;
  labels: string[];
  dependsOn: string[];
  dueDate?: string | undefined;
}

export interface HqKanbanColumnView {
  id: string;
  title: string;
  color?: string | undefined;
  order: number;
  wipLimit?: number | undefined;
  tasks: HqKanbanTaskView[];
}

export interface HqKanbanBoardView {
  id: string;
  title: string;
  description?: string | undefined;
  tags: string[];
  revision: number;
  updatedAt: string;
  activePresence: number;
  taskCount: number;
  completedTaskCount: number;
  activeTaskCount: number;
  blockedTaskCount: number;
  columns: HqKanbanColumnView[];
}

export function projectKanbanUrl(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/kanban`;
}

export function projectKanbanBoards(snapshot: HqKanbanSnapshotPayload): HqKanbanBoardView[] {
  return snapshot.boards
    .map((record) => parseBoard(record))
    .filter((board): board is HqKanbanBoardView => board !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function parseBoard(record: HqKanbanSnapshotPayload['boards'][number]): HqKanbanBoardView | null {
  const raw = record.board;
  if (raw['id'] !== record.boardId) return null;

  const columns = arrayOfRecords(raw['columns'])
    .map(parseColumn)
    .filter((column): column is Omit<HqKanbanColumnView, 'tasks'> => column !== null);
  const tasks = arrayOfRecords(raw['tasks'])
    .map(parseTask)
    .filter((task): task is HqKanbanTaskView => task !== null);

  const columnIds = new Set(columns.map((column) => column.id));
  const missingColumnIds = new Set(
    tasks.map((task) => task.columnId).filter((columnId) => !columnIds.has(columnId)),
  );
  for (const columnId of missingColumnIds) {
    columns.push({
      id: columnId,
      title: columnId.length > 0 ? columnId : 'Unmapped',
      order: Number.MAX_SAFE_INTEGER,
    });
  }

  const projectedColumns = columns
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
    .map<HqKanbanColumnView>((column) => ({
      ...column,
      tasks: tasks
        .filter((task) => task.columnId === column.id)
        .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title)),
    }));

  return {
    id: record.boardId,
    title: stringValue(raw['title']) ?? record.boardId,
    description: stringValue(raw['description']),
    tags: stringArray(raw['tags']),
    revision: record.revision,
    updatedAt: record.updatedAt,
    activePresence: arrayOfRecords(raw['presence']).filter(
      (presence) => presence['active'] === true,
    ).length,
    taskCount: tasks.length,
    completedTaskCount: tasks.filter((task) => task.status === 'completed').length,
    activeTaskCount: tasks.filter(
      (task) => task.status === 'in_progress' || task.status === 'review',
    ).length,
    blockedTaskCount: tasks.filter((task) => task.status === 'blocked' || task.status === 'failed')
      .length,
    columns: projectedColumns,
  };
}

function parseColumn(raw: Record<string, unknown>): Omit<HqKanbanColumnView, 'tasks'> | null {
  const id = stringValue(raw['id']);
  const title = stringValue(raw['title']);
  if (!id || !title) return null;
  return {
    id,
    title,
    color: stringValue(raw['color']),
    order: numberValue(raw['order']) ?? 0,
    wipLimit: numberValue(raw['wipLimit']),
  };
}

function parseTask(raw: Record<string, unknown>): HqKanbanTaskView | null {
  const id = stringValue(raw['id']);
  const title = stringValue(raw['title']);
  const columnId = stringValue(raw['columnId']);
  if (!id || !title || columnId === undefined) return null;
  const assignment = recordValue(raw['assignment']);
  return {
    id,
    title,
    description: stringValue(raw['description']),
    columnId,
    order: numberValue(raw['order']) ?? 0,
    priority: enumValue(raw['priority'], TASK_PRIORITIES) ?? 'medium',
    status: enumValue(raw['status'], TASK_STATUSES) ?? 'pending',
    assignee:
      stringValue(raw['assignee']) ??
      stringValue(raw['assignedAgent']) ??
      stringValue(assignment?.['name']) ??
      stringValue(assignment?.['agentId']),
    assignmentStatus: stringValue(assignment?.['status']),
    labels: stringArray(raw['labels']),
    dependsOn: stringArray(raw['dependsOn']),
    dueDate: stringValue(raw['dueDate']),
  };
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function enumValue(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

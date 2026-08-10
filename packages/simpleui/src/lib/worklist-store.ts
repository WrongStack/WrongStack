import type { KanbanWorkbenchSnapshot } from '@wrongstack/kanban';
import type { ServerMessage } from '../types.js';

export type WorklistView = 'flow' | 'todos' | 'tasks' | 'plan';
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
export type PlanStatus = 'open' | 'in_progress' | 'done';

export interface SimpleTodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string | undefined;
  kanbanBoardId?: string | undefined;
  kanbanTaskId?: string | undefined;
  /** Board-derived titles of the unfinished work this row waits on. */
  blockedBy?: string[] | undefined;
}

export interface SimpleTaskItem {
  id: string;
  title: string;
  description?: string | undefined;
  type: 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test' | 'chore';
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: TaskStatus;
  assignee?: string | undefined;
  estimateHours?: number | undefined;
}

export interface SimplePlanItem {
  id: string;
  title: string;
  details?: string | undefined;
  status: PlanStatus;
}

export interface WorklistSnapshot {
  sessionId: string | null;
  todos: SimpleTodoItem[];
  tasks: SimpleTaskItem[];
  planItems: SimplePlanItem[];
  workbench: KanbanWorkbenchSnapshot | null;
}

export interface WorklistStore {
  getSnapshot: () => WorklistSnapshot;
  subscribe: (listener: () => void) => () => void;
  reset: (sessionId: string | null) => void;
  applyMessage: (message: ServerMessage) => boolean;
}

const TODO_STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed']);
const TASK_STATUSES = new Set<TaskStatus>([
  'pending',
  'in_progress',
  'blocked',
  'failed',
  'review',
  'completed',
]);
const TASK_TYPES = new Set<SimpleTaskItem['type']>([
  'feature',
  'bugfix',
  'refactor',
  'docs',
  'test',
  'chore',
]);
const TASK_PRIORITIES = new Set<SimpleTaskItem['priority']>(['critical', 'high', 'medium', 'low']);
const PLAN_STATUSES = new Set<PlanStatus>(['open', 'in_progress', 'done']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function parseSimpleTodos(value: unknown): SimpleTodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = record(entry);
    const id = optionalString(item?.['id']);
    const content = optionalString(item?.['content']);
    const status = item?.['status'];
    if (!id || !content || typeof status !== 'string' || !TODO_STATUSES.has(status as TodoStatus)) {
      return [];
    }
    return [
      {
        id,
        content,
        status: status as TodoStatus,
        ...(optionalString(item?.['activeForm']) && {
          activeForm: optionalString(item?.['activeForm']),
        }),
        ...(optionalString(item?.['kanbanBoardId']) && {
          kanbanBoardId: optionalString(item?.['kanbanBoardId']),
        }),
        ...(optionalString(item?.['kanbanTaskId']) && {
          kanbanTaskId: optionalString(item?.['kanbanTaskId']),
        }),
        ...(Array.isArray(item?.['blockedBy']) && item['blockedBy'].length
          ? { blockedBy: item['blockedBy'].flatMap((entry) => optionalString(entry) ?? []) }
          : {}),
      },
    ];
  });
}

export function parseSimpleTasks(value: unknown): SimpleTaskItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = record(entry);
    const id = optionalString(item?.['id']);
    const title = optionalString(item?.['title']);
    const status = item?.['status'];
    if (!id || !title || typeof status !== 'string' || !TASK_STATUSES.has(status as TaskStatus)) {
      return [];
    }
    const type = item?.['type'];
    const priority = item?.['priority'];
    const estimateHours = item?.['estimateHours'];
    return [
      {
        id,
        title,
        status: status as TaskStatus,
        type:
          typeof type === 'string' && TASK_TYPES.has(type as SimpleTaskItem['type'])
            ? (type as SimpleTaskItem['type'])
            : 'chore',
        priority:
          typeof priority === 'string' &&
          TASK_PRIORITIES.has(priority as SimpleTaskItem['priority'])
            ? (priority as SimpleTaskItem['priority'])
            : 'medium',
        ...(optionalString(item?.['description']) && {
          description: optionalString(item?.['description']),
        }),
        ...(optionalString(item?.['assignee']) && { assignee: optionalString(item?.['assignee']) }),
        ...(typeof estimateHours === 'number' && Number.isFinite(estimateHours)
          ? { estimateHours }
          : {}),
      },
    ];
  });
}

export function parseSimplePlan(value: unknown): SimplePlanItem[] {
  const plan = record(value);
  const items = plan?.['items'];
  if (!Array.isArray(items)) return [];
  return items.flatMap((entry) => {
    const item = record(entry);
    const id = optionalString(item?.['id']);
    const title = optionalString(item?.['title']);
    const status = item?.['status'];
    if (!id || !title || typeof status !== 'string' || !PLAN_STATUSES.has(status as PlanStatus)) {
      return [];
    }
    return [
      {
        id,
        title,
        status: status as PlanStatus,
        ...(optionalString(item?.['details']) && { details: optionalString(item?.['details']) }),
      },
    ];
  });
}

function payloadSessionId(payload: Record<string, unknown>): string | null {
  return typeof payload['sessionId'] === 'string' && payload['sessionId']
    ? payload['sessionId']
    : null;
}

/**
 * Tiny external store for sidebar-only state. Worklist broadcasts can be frequent
 * during tool execution; keeping them outside App state prevents a full chat-tree
 * render when only the sidebar badge or its open panel needs to change.
 */
export function createWorklistStore(): WorklistStore {
  let snapshot: WorklistSnapshot = {
    sessionId: null,
    todos: [],
    tasks: [],
    planItems: [],
    workbench: null,
  };
  const listeners = new Set<() => void>();

  const publish = (next: WorklistSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: (sessionId) => {
      publish({ sessionId, todos: [], tasks: [], planItems: [], workbench: null });
    },
    applyMessage: (message) => {
      const payload = message.payload ?? {};
      const incomingSessionId = payloadSessionId(payload);
      if (incomingSessionId && snapshot.sessionId && incomingSessionId !== snapshot.sessionId) {
        return false;
      }

      if ((message.type as string) === 'kanban.workbench') {
        const envelope = record(payload['data']);
        if (!envelope || !record(envelope['lanes']) || !record(envelope['totals'])) return false;
        publish({ ...snapshot, workbench: envelope as unknown as KanbanWorkbenchSnapshot });
        return true;
      }

      switch (message.type) {
        case 'todos.updated':
          publish({ ...snapshot, todos: parseSimpleTodos(payload['todos']) });
          return true;
        case 'todos.cleared':
          publish({ ...snapshot, todos: [] });
          return true;
        case 'tasks.updated':
          publish({ ...snapshot, tasks: parseSimpleTasks(payload['tasks']) });
          return true;
        case 'plan.updated':
          publish({ ...snapshot, planItems: parseSimplePlan(payload['plan']) });
          return true;
        default:
          return false;
      }
    },
  };
}

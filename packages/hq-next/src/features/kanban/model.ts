/**
 * Kanban rules as pure functions over a parsed board view. Only types come
 * from the legacy domain, so these run (and are tested) anywhere.
 */
import type {
  HqKanbanBoardView,
  HqKanbanColumnView,
  HqKanbanTaskView,
} from '@hq/domain/kanban-model';
import type { HqSnapshot } from '@wrongstack/hq';

export interface DependencyState {
  id: string;
  title: string;
  /** The dependency's OWN status — not the dependent task's. */
  status: string | undefined;
  done: boolean;
  /** Not on this board any more (archived elsewhere, or a stale id). */
  missing: boolean;
}

export function taskIndex(board: HqKanbanBoardView): ReadonlyMap<string, HqKanbanTaskView> {
  const index = new Map<string, HqKanbanTaskView>();
  for (const column of board.columns) for (const task of column.tasks) index.set(task.id, task);
  return index;
}

export function dependencyStates(
  task: HqKanbanTaskView,
  index: ReadonlyMap<string, HqKanbanTaskView>,
): DependencyState[] {
  return task.dependsOn.map((id) => {
    const dependency = index.get(id);
    return {
      id,
      title: dependency?.title ?? id.slice(0, 8),
      status: dependency?.status,
      done: dependency?.status === 'completed',
      missing: dependency === undefined,
    };
  });
}

/** Whether every dependency of a task is completed (vacuously true for none). */
export function dependenciesMet(
  task: HqKanbanTaskView,
  index: ReadonlyMap<string, HqKanbanTaskView>,
): boolean {
  return dependencyStates(task, index).every((dependency) => dependency.done);
}

export interface ColumnLoad {
  count: number;
  limit: number | undefined;
  over: boolean;
}

export function columnLoad(column: HqKanbanColumnView): ColumnLoad {
  const count = column.tasks.length;
  const limit = column.wipLimit !== undefined && column.wipLimit > 0 ? column.wipLimit : undefined;
  return { count, limit, over: limit !== undefined && count > limit };
}

/** Statuses whose card needs a human to look at it. */
export function needsAttention(task: Pick<HqKanbanTaskView, 'status'>): boolean {
  return task.status === 'blocked' || task.status === 'failed';
}

export const TASK_STATUSES = [
  'pending',
  'ready',
  'in_progress',
  'review',
  'blocked',
  'failed',
  'completed',
  'archived',
] as const;

export function statusLabel(status: string): string {
  return status === 'in_progress'
    ? 'In progress'
    : status.charAt(0).toUpperCase() + status.slice(1).replaceAll('_', ' ');
}

export interface AssignmentTarget {
  key: string;
  agentId: string;
  /** What the task records as its assignee: the agent's name, nothing transient. */
  assignee: string;
  /** What the picker shows: name, machine and current status. */
  label: string;
}

/** Live agents of a project that a task can be assigned to. */
export function assignmentTargets(
  snapshot: Pick<HqSnapshot, 'liveSessions'> | null,
  projectId: string,
): AssignmentTarget[] {
  const targets = new Map<string, AssignmentTarget>();
  for (const session of snapshot?.liveSessions ?? []) {
    if (session.projectId !== projectId) continue;
    for (const agent of session.agents) {
      const key = `${session.sessionId}:${agent.id}`;
      targets.set(key, {
        key,
        agentId: agent.id,
        assignee: agent.name,
        label: `${agent.name} · ${session.hostname ?? session.machineId} · ${agent.status}`,
      });
    }
  }
  return [...targets.values()].sort((left, right) => left.label.localeCompare(right.label));
}

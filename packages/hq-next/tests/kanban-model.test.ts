import type {
  HqKanbanBoardView,
  HqKanbanColumnView,
  HqKanbanTaskView,
} from '@hq/domain/kanban-model';
import { describe, expect, it } from 'vitest';
import {
  assignmentTargets,
  columnLoad,
  dependenciesMet,
  dependencyStates,
  needsAttention,
  statusLabel,
  taskIndex,
} from '../src/features/kanban/model';

const task = (
  id: string,
  status: string,
  extra: Partial<HqKanbanTaskView> = {},
): HqKanbanTaskView => ({
  id,
  title: `Task ${id}`,
  columnId: 'c',
  order: 0,
  priority: 'medium',
  status,
  labels: [],
  dependsOn: [],
  ...extra,
});

const column = (id: string, tasks: HqKanbanTaskView[], wipLimit?: number): HqKanbanColumnView => ({
  id,
  title: id,
  order: 0,
  wipLimit,
  tasks,
});

const board = (columns: HqKanbanColumnView[]): HqKanbanBoardView => ({
  id: 'b',
  title: 'Board',
  tags: [],
  revision: 1,
  updatedAt: '2026-10-31T00:00:00.000Z',
  activePresence: 0,
  taskCount: 0,
  completedTaskCount: 0,
  activeTaskCount: 0,
  blockedTaskCount: 0,
  columns,
});

describe('kanban dependencies', () => {
  const done = task('done', 'completed');
  const open = task('open', 'in_progress');
  // The dependent task is itself completed: its own status must not leak onto its dependencies.
  const dependent = task('dep', 'completed', { dependsOn: ['done', 'open', 'gone-1234567890'] });
  const index = taskIndex(board([column('a', [done, open]), column('b', [dependent])]));

  it('reports each dependency by its own status', () => {
    expect(dependencyStates(dependent, index)).toEqual([
      { id: 'done', title: 'Task done', status: 'completed', done: true, missing: false },
      { id: 'open', title: 'Task open', status: 'in_progress', done: false, missing: false },
      { id: 'gone-1234567890', title: 'gone-123', status: undefined, done: false, missing: true },
    ]);
  });

  it('is met only when every dependency is completed', () => {
    expect(dependenciesMet(dependent, index)).toBe(false);
    expect(dependenciesMet(task('x', 'ready', { dependsOn: ['done'] }), index)).toBe(true);
    expect(dependenciesMet(task('y', 'ready'), index)).toBe(true);
  });
});

describe('kanban columns and statuses', () => {
  it('flags a column over its WIP limit and ignores a zero limit', () => {
    const three = [task('1', 'ready'), task('2', 'ready'), task('3', 'ready')];
    expect(columnLoad(column('c', three, 2))).toEqual({ count: 3, limit: 2, over: true });
    expect(columnLoad(column('c', three, 3))).toEqual({ count: 3, limit: 3, over: false });
    expect(columnLoad(column('c', three, 0))).toEqual({ count: 3, limit: undefined, over: false });
  });

  it('asks for a human only on blocked or failed cards', () => {
    expect(needsAttention({ status: 'blocked' })).toBe(true);
    expect(needsAttention({ status: 'failed' })).toBe(true);
    expect(needsAttention({ status: 'review' })).toBe(false);
  });

  it('labels statuses in words', () => {
    expect(statusLabel('in_progress')).toBe('In progress');
    expect(statusLabel('blocked')).toBe('Blocked');
  });
});

describe('kanban assignment targets', () => {
  it('records only the agent name as the assignee, never its transient status', () => {
    const snapshot = {
      liveSessions: [
        {
          sessionId: 's1',
          projectId: 'p1',
          machineId: 'm1',
          hostname: 'atlas',
          agents: [{ id: 'a1', name: 'builder', status: 'idle' }],
        },
        {
          sessionId: 's2',
          projectId: 'other',
          machineId: 'm2',
          agents: [{ id: 'a2', name: 'x', status: 'idle' }],
        },
      ],
    } as never;
    expect(assignmentTargets(snapshot, 'p1')).toEqual([
      { key: 's1:a1', agentId: 'a1', assignee: 'builder', label: 'builder · atlas · idle' },
    ]);
  });
});

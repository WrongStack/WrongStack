/**
 * Queue-health bucketing.
 *
 * Two rules here were each a bug once, and both are invisible from the type
 * signature: a card with a live assignment counts as RUNNING whatever its
 * stored status says, and "healthy" is decided by failure signals alone —
 * work in flight is not a problem.
 */
import { describe, expect, it } from 'vitest';
import type {
  HqKanbanBoardView,
  HqKanbanColumnView,
  HqKanbanTaskView,
} from '../../src/domain/kanban-model.js';
import {
  computeQueueCounts,
  isQueueHealthy,
} from '../../src/domain/kanban-queue-health.js';

function task(id: string, overrides: Partial<HqKanbanTaskView> = {}): HqKanbanTaskView {
  return {
    id,
    title: id,
    columnId: 'col-1',
    order: 0,
    priority: 'medium',
    status: 'pending',
    labels: [],
    dependsOn: [],
    ...overrides,
  };
}

function board(tasks: HqKanbanTaskView[]): HqKanbanBoardView {
  const column: HqKanbanColumnView = {
    id: 'col-1',
    title: 'Backlog',
    order: 0,
    tasks,
  };
  return {
    id: 'board-1',
    title: 'Board',
    tags: [],
    revision: 1,
    updatedAt: '2026-07-14T12:00:00.000Z',
    activePresence: 0,
    taskCount: tasks.length,
    completedTaskCount: tasks.filter((entry) => entry.status === 'completed').length,
    activeTaskCount: 0,
    blockedTaskCount: 0,
    columns: [column],
  };
}

describe('computeQueueCounts', () => {
  it('counts a pending task with no dependencies as startable', () => {
    expect(computeQueueCounts(board([task('a')])).startable).toBe(1);
  });

  it('does not count a task whose dependency is unfinished', () => {
    const counts = computeQueueCounts(
      board([task('a', { status: 'in_progress' }), task('b', { dependsOn: ['a'] })]),
    );
    expect(counts.startable).toBe(0);
  });

  it('counts a task whose dependencies are all completed', () => {
    const counts = computeQueueCounts(
      board([task('a', { status: 'completed' }), task('b', { dependsOn: ['a'] })]),
    );
    expect(counts.startable).toBe(1);
  });

  it('treats a live assignment as running, whatever the status says', () => {
    // Managed cards keep their lifecycle stage in `status`; ignoring the
    // assignment under-reported every one of them.
    const counts = computeQueueCounts(
      board([task('a', { status: 'pending', assignmentStatus: 'running' })]),
    );
    expect(counts.running).toBe(1);
  });

  it('does not call a claimed card startable', () => {
    expect(
      computeQueueCounts(board([task('a', { status: 'ready', assignmentStatus: 'queued' })]))
        .startable,
    ).toBe(0);
  });

  it('buckets review, blocked and failed', () => {
    const counts = computeQueueCounts(
      board([
        task('a', { status: 'review' }),
        task('b', { status: 'blocked' }),
        task('c', { status: 'failed' }),
      ]),
    );
    expect(counts).toMatchObject({ review: 1, blocked: 1, failed: 1 });
  });
});

describe('isQueueHealthy', () => {
  it('is healthy with work in flight', () => {
    const counts = computeQueueCounts(
      board([task('a', { status: 'in_progress' }), task('b', { status: 'review' })]),
    );
    expect(isQueueHealthy(counts)).toBe(true);
  });

  it.each(['blocked', 'failed'] as const)('is not healthy with a %s card', (status) => {
    expect(isQueueHealthy(computeQueueCounts(board([task('a', { status })])))).toBe(false);
  });
});

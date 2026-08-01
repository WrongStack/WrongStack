import { describe, expect, it } from 'vitest';
import type { KanbanBoard, KanbanTask } from '../src/types.js';
import { classifyTaskForQueue } from '../src/manager/task-classifier.js';

const NOW = '2026-08-01T00:00:00.000Z';
const FUTURE = '2026-08-01T00:10:00.000Z';
const PAST = '2026-07-31T23:59:00.000Z';

function board(overrides: Partial<KanbanBoard> = {}): KanbanBoard {
  return {
    id: 'board-1',
    title: 'Board',
    columns: [
      { id: 'backlog', title: 'Backlog', order: 0 },
      { id: 'todo', title: 'Todo', order: 1 },
      { id: 'in-progress', title: 'Running', order: 2 },
      { id: 'review', title: 'Review', order: 3 },
      { id: 'done', title: 'Done', order: 4 },
    ],
    tasks: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function managedBoard(tasks: KanbanTask[] = []): KanbanBoard {
  return board({
    lifecycle: {
      mode: 'managed',
      columns: {
        backlog: 'backlog',
        todo: 'todo',
        running: 'in-progress',
        review: 'review',
        done: 'done',
      },
    },
    tasks,
  });
}

function task(overrides: Partial<KanbanTask> & { id?: string } = {}): KanbanTask {
  return {
    id: overrides.id ?? 'task-1',
    title: 'Task',
    columnId: 'backlog',
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('classifyTaskForQueue', () => {
  it('classifies a legacy pending task with met dependencies as claimable', () => {
    const t = task();
    const b = board({ tasks: [t] });

    expect(classifyTaskForQueue(b, t, { now: NOW })).toMatchObject({
      bucket: 'claimable',
      claimable: true,
      reasons: [],
    });
  });

  it('classifies unmet dependencies before generic claimability', () => {
    const blocker = task({ id: 'blocker', status: 'pending' });
    const blocked = task({ id: 'blocked', status: 'ready', dependsOn: [blocker.id] });
    const b = board({ tasks: [blocker, blocked] });

    const classification = classifyTaskForQueue(b, blocked, { now: NOW });

    expect(classification.bucket).toBe('dependency_blocked');
    expect(classification.claimable).toBe(false);
    expect(classification.reasons).toContain('Task has unmet dependencies.');
  });

  it('classifies managed backlog tasks as stage blocked', () => {
    const t = task({ lifecycle: { currentStage: 'backlog', stageEnteredAt: NOW, history: [] } });
    const b = managedBoard([t]);

    const classification = classifyTaskForQueue(b, t, { now: NOW });

    expect(classification.bucket).toBe('stage_blocked');
    expect(classification.managedStage).toBe('backlog');
    expect(classification.reasons[0]).toContain('not todo');
  });

  it('classifies managed todo tasks missing required details as detail incomplete', () => {
    const t = task({
      status: 'ready',
      columnId: 'todo',
      lifecycle: { currentStage: 'todo', stageEnteredAt: NOW, history: [] },
    });
    const b = managedBoard([t]);

    const classification = classifyTaskForQueue(b, t, { now: NOW });

    expect(classification.bucket).toBe('detail_incomplete');
    expect(classification.claimable).toBe(false);
    expect(classification.reasons[0]).toContain('description');
    expect(classification.reasons[0]).toContain('successCriteria');
  });

  it('classifies fully specified managed todo tasks as claimable', () => {
    const t = task({
      status: 'ready',
      columnId: 'todo',
      description: 'Detailed work scope.',
      dueDate: '2026-08-02T00:00:00.000Z',
      assignee: 'agent',
      labels: ['kanban'],
      childTaskIds: ['child-1'],
      successCriteria: [{ id: 'check-1', description: 'Acceptance criterion', type: 'manual', status: 'pending' }],
      lifecycle: { currentStage: 'todo', stageEnteredAt: NOW, history: [] },
    });
    const b = managedBoard([t]);

    expect(classifyTaskForQueue(b, t, { now: NOW })).toMatchObject({
      bucket: 'claimable',
      claimable: true,
      managedStage: 'todo',
    });
  });

  it('classifies running leases by health', () => {
    const live = task({
      status: 'in_progress',
      assignment: { status: 'running', leaseId: 'lease', leaseExpiresAt: FUTURE },
    });
    const expired = task({
      id: 'expired',
      status: 'in_progress',
      assignment: { status: 'running', leaseId: 'lease', leaseExpiresAt: PAST },
    });
    const noLease = task({ id: 'no-lease', status: 'in_progress', assignment: { status: 'running' } });
    const b = board({ tasks: [live, expired, noLease] });

    expect(classifyTaskForQueue(b, live, { now: NOW }).bucket).toBe('running_live');
    expect(classifyTaskForQueue(b, expired, { now: NOW }).bucket).toBe('running_expired');
    expect(classifyTaskForQueue(b, noLease, { now: NOW }).bucket).toBe('running_no_lease');
  });

  it('classifies retryable and terminal failures separately', () => {
    const retryable = task({
      status: 'failed',
      assignment: { status: 'failed', attempt: 1, maxAttempts: 2 },
    });
    const terminal = task({ id: 'terminal', status: 'failed', assignment: { status: 'failed', attempt: 2, maxAttempts: 2 } });
    const b = board({ tasks: [retryable, terminal] });

    expect(classifyTaskForQueue(b, retryable, { now: NOW }).bucket).toBe('failed_retryable');
    expect(classifyTaskForQueue(b, terminal, { now: NOW }).bucket).toBe('failed_terminal');
  });
});

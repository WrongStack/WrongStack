import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import { auditKanbanBoard } from '../../src/lib/kanban-cleaner.js';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');

function completeTask(overrides: Record<string, unknown> = {}): KanbanTask {
  return {
    id: 'task-1',
    title: 'Ship cleaner',
    description: 'Audit every active card before the board drifts.',
    columnId: 'ready',
    order: 0,
    priority: 'high',
    status: 'ready',
    assignee: 'agent-1',
    labels: ['webui'],
    childTaskIds: ['child-1'],
    successCriteria: [
      { id: 'check-1', description: 'Focused tests pass', type: 'test', status: 'pending' },
    ],
    createdAt: '2026-07-14T12:00:00.000Z',
    updatedAt: '2026-07-15T10:00:00.000Z',
    dueDate: '2026-07-18T12:00:00.000Z',
    ...overrides,
  } as KanbanTask;
}

function board(tasks: KanbanTask[], overrides: Record<string, unknown> = {}): KanbanBoard {
  return {
    id: 'board-1',
    title: 'Cleaner',
    columns: [
      { id: 'ready', title: 'Ready', order: 0 },
      { id: 'doing', title: 'Doing', order: 1 },
      { id: 'review', title: 'Review', order: 2 },
      { id: 'done', title: 'Done', order: 3 },
    ],
    tasks,
    createdAt: '2026-07-14T12:00:00.000Z',
    updatedAt: '2026-07-15T12:00:00.000Z',
    version: 1,
    ...overrides,
  } as KanbanBoard;
}

function codes(result: ReturnType<typeof auditKanbanBoard>): string[] {
  return result.issues.map((issue) => issue.code);
}

describe('auditKanbanBoard', () => {
  it('returns a clean summary for a detailed active card', () => {
    const result = auditKanbanBoard(board([completeTask()]), { now: NOW });

    expect(result).toEqual({
      issues: [],
      counts: { error: 0, warning: 0 },
      affectedTaskCount: 0,
    });
  });

  it('reports every required detail and accepts tags/assignment identity aliases', () => {
    const missing = completeTask({
      id: 'missing',
      description: ' ',
      assignee: undefined,
      labels: [],
      childTaskIds: [],
      successCriteria: [],
      dueDate: undefined,
    });
    const aliases = completeTask({
      id: 'aliases',
      assignee: undefined,
      labels: undefined,
      assignedAgent: undefined,
      tags: ['frontend'],
      assignment: { status: 'assigned', agentId: 'worker-2' },
    });

    const result = auditKanbanBoard(board([missing, aliases]), {
      now: NOW,
      requireDueDate: true,
    });

    expect(codes(result)).toEqual([
      'missing-description',
      'missing-labels',
      'missing-success-criteria',
      'missing-assignee',
      'missing-subtasks',
      'missing-due-date',
    ]);
    expect(result.counts).toEqual({ error: 0, warning: 6 });
    expect(result.affectedTaskCount).toBe(1);
  });

  it('only requires a due date when the shared contract enables that rule', () => {
    const task = completeTask({ dueDate: undefined });

    expect(codes(auditKanbanBoard(board([task]), { now: NOW }))).not.toContain('missing-due-date');
    expect(codes(auditKanbanBoard(board([task]), { now: NOW, requireDueDate: true }))).toContain(
      'missing-due-date',
    );
  });

  it('treats numeric and Date due dates as present', () => {
    const numeric = completeTask({ dueDate: 1_753_000_000_000 });
    const date = completeTask({ id: 'date', dueDate: new Date('2026-07-18T12:00:00.000Z') });

    expect(
      codes(auditKanbanBoard(board([numeric, date]), { now: NOW, requireDueDate: true })),
    ).not.toContain('missing-due-date');
  });

  it('ignores completed and archived cards', () => {
    const result = auditKanbanBoard(
      board([
        completeTask({ id: 'done', status: 'completed', description: undefined }),
        completeTask({ id: 'archived', status: 'archived', assignee: undefined }),
      ]),
      { now: NOW },
    );

    expect(result.issues).toHaveLength(0);
  });

  it('flags expired and lease-less running cards, but never a valid lease even when the agent is not live locally', () => {
    const assignment = {
      status: 'running' as const,
      agentId: 'agent-1',
      leaseId: 'lease-1',
      claimedAt: '2026-07-15T12:00:00.000Z',
      heartbeatAt: '2026-07-15T12:30:00.000Z',
      leaseExpiresAt: '2026-07-15T13:00:00.000Z',
    };
    const tasks = [
      completeTask({ id: 'missing-lease', status: 'in_progress', assignment: undefined }),
      // Cross-session regression: a valid lease is the authoritative liveness
      // signal. This WebUI's fleet roster does not know 'agent-1' (it runs in
      // another session), which previously produced a false
      // 'abandoned-running-task' error on the card.
      completeTask({ id: 'not-live', status: 'in_progress', assignment }),
      completeTask({
        id: 'expired',
        status: 'in_progress',
        assignment: { ...assignment, leaseExpiresAt: '2026-07-15T11:59:59.000Z' },
      }),
      completeTask({ id: 'healthy', status: 'in_progress', assignment }),
    ];

    const result = auditKanbanBoard(board(tasks), {
      now: NOW,
      // Deliberately non-matching: the roster option is accepted for API
      // compatibility but a valid lease is the only liveness signal the
      // audit may rely on (see the kanban-cleaner addRunningIssue comment).
      liveAgentIdentities: ['other-agent'],
    });
    const runtimeIssues = result.issues.filter(
      (issue) => issue.code === 'abandoned-running-task' || issue.code === 'stale-running-task',
    );

    expect(runtimeIssues.map((issue) => [issue.taskId, issue.code])).toEqual([
      ['expired', 'stale-running-task'],
      ['missing-lease', 'abandoned-running-task'],
    ]);
    expect(result.issues.filter((issue) => issue.taskId === 'not-live')).toEqual([]);
  });

  it('detects skipped managed lifecycle states from status history', () => {
    const task = completeTask({
      statusHistory: [
        { status: 'ready', at: '2026-07-15T09:00:00.000Z' },
        { status: 'review', at: '2026-07-15T10:00:00.000Z' },
      ],
    });
    const result = auditKanbanBoard(
      board([task], { lifecycle: { states: ['ready', 'in_progress', 'review', 'completed'] } }),
      { now: NOW },
    );

    expect(result.issues.find((issue) => issue.code === 'skipped-lifecycle-state')).toMatchObject({
      severity: 'error',
      message: 'Lifecycle skipped ready → review',
    });
  });

  it('audits the authoritative managed lifecycle ledger and column roles', () => {
    const task = completeTask({
      lifecycle: {
        currentStage: 'review',
        stageEnteredAt: '2026-07-15T10:00:00.000Z',
        history: [
          { to: 'backlog', at: '2026-07-15T08:00:00.000Z', actor: 'agent' },
          { from: 'backlog', to: 'review', at: '2026-07-15T10:00:00.000Z', actor: 'agent' },
        ],
      },
    });
    const result = auditKanbanBoard(
      board([task], {
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
      }),
      { now: NOW, requireDueDate: true },
    );

    expect(codes(result)).toContain('skipped-lifecycle-state');
  });

  it('uses lifecycle review entry time and board threshold for stale review cards', () => {
    const task = completeTask({
      status: 'review',
      updatedAt: '2026-07-15T11:59:00.000Z',
      lifecycleHistory: [
        { state: 'in_progress', at: '2026-07-15T05:00:00.000Z' },
        { state: 'review', at: '2026-07-15T06:00:00.000Z' },
      ],
    });
    const result = auditKanbanBoard(
      board([task], {
        lifecycle: {
          mode: 'managed',
          columns: {
            backlog: 'backlog',
            todo: 'todo',
            running: 'in-progress',
            review: 'review',
            done: 'done',
          },
          staleReviewAfterMs: 4 * 60 * 60 * 1000,
        },
      }),
      { now: NOW },
    );

    expect(result.issues.find((issue) => issue.code === 'stale-review')).toMatchObject({
      severity: 'warning',
      message: 'Waiting in review for 6h',
    });
  });
});

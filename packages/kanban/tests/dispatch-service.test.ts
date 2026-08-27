import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addTask,
  cancelKanbanDispatch,
  completeKanbanDispatch,
  createBoard,
  failKanbanDispatch,
  heartbeatKanbanDispatch,
  reserveKanbanDispatch,
  startKanbanDispatch,
  updateTask,
} from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-dispatch-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

const COLS = [
  { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 },
  { id: 'todo', title: 'To Do', order: 1, wipLimit: 0 },
  { id: 'in-progress', title: 'In Progress', order: 2, wipLimit: 0 },
  { id: 'review', title: 'Review', order: 3, wipLimit: 0 },
  { id: 'done', title: 'Done', order: 4, wipLimit: 0 },
];

function managedLifecycle() {
  return {
    mode: 'managed' as const,
    columns: {
      backlog: 'backlog',
      todo: 'todo',
      running: 'in-progress',
      review: 'review',
      done: 'done',
    },
  };
}

function _nowIso(): string {
  return '2026-08-01T00:00:00.000Z';
}

const FUTURE = '2026-12-01T00:00:00.000Z';

// ── Reserve ──────────────────────────────────────────────────────────

describe('reserveKanbanDispatch', () => {
  it('claims a ready task on a legacy board and seeds lease', async () => {
    const b = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    await addTask(tmpDir, b.id, {
      title: 'Task',
      description: 'Work to do.',
      status: 'ready',
      columnId: 'todo',
    });

    const result = await reserveKanbanDispatch(tmpDir, { boardId: b.id });
    expect(result).not.toBeNull();
    expect(result!.task.title).toBe('Task');
    expect(result!.lease.leaseId).toBeDefined();
    expect(result!.lease.leaseExpiresAt).toBeDefined();
    expect(result!.task.assignment?.leaseId).toBe(result!.lease.leaseId);
    expect(result!.task.assignment?.status).toBe('queued');
  });

  it('returns null when no ready task exists', async () => {
    const b = await createBoard(tmpDir, { title: 'Empty', columns: COLS });
    const result = await reserveKanbanDispatch(tmpDir, { boardId: b.id });
    expect(result).toBeNull();
  });
});

// ── Start ────────────────────────────────────────────────────────────

describe('startKanbanDispatch', () => {
  it('transitions legacy task to in_progress with running assignment', async () => {
    const b = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    await addTask(tmpDir, b.id, {
      title: 'Task',
      description: 'Work.',
      status: 'ready',
      columnId: 'todo',
    });
    const reserved = await reserveKanbanDispatch(tmpDir, { boardId: b.id });
    expect(reserved).not.toBeNull();

    const started = await startKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: reserved!.lease.leaseId,
      actor: 'test-agent',
      subagentId: 'sub-1',
    });
    expect(started).not.toBeNull();
    expect(started!.task.status).toBe('in_progress');
    expect(started!.task.assignment?.status).toBe('running');
    expect(started!.task.assignment?.subagentId).toBe('sub-1');
  });

  it('transitions managed task from todo to running', async () => {
    const b = await createBoard(tmpDir, {
      title: 'Managed',
      columns: COLS,
      lifecycle: managedLifecycle(),
    });
    // Create a card in backlog with required description, then transition to todo
    const added = await addTask(tmpDir, b.id, {
      title: 'Managed Task',
      description: 'Detailed scope.',
    });
    // Fill required details and transition to todo
    await updateTask(tmpDir, b.id, added!.task.id, {
      description: 'Detailed scope.',
      assignee: 'agent-1',
      dueDate: FUTURE,
      labels: ['test'],
      childTaskIds: ['child-1'],
      successCriteria: [{ id: 'c1', description: 'Pass', type: 'manual', status: 'pending' }],
    });
    const { transitionTask } = await import('./helpers/session-manager.js');
    await transitionTask(tmpDir, b.id, added!.task.id, {
      to: 'todo',
      actor: 'agent',
      comment: 'Ready.',
    });

    const reserved = await reserveKanbanDispatch(tmpDir, { boardId: b.id });
    expect(reserved).not.toBeNull();
    expect(reserved!.task.lifecycle?.currentStage).toBe('todo');

    const started = await startKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: reserved!.lease.leaseId,
      actor: 'test-agent',
    });
    expect(started).not.toBeNull();
    expect(started!.task.lifecycle?.currentStage).toBe('running');
    expect(started!.task.assignment?.status).toBe('running');
  });

  it('returns null when lease does not match (stale owner)', async () => {
    const b = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    await addTask(tmpDir, b.id, {
      title: 'Task',
      description: 'Work.',
      status: 'ready',
      columnId: 'todo',
    });
    const reserved = await reserveKanbanDispatch(tmpDir, { boardId: b.id });
    expect(reserved).not.toBeNull();

    // Use a wrong leaseId
    const started = await startKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: 'wrong-lease',
      actor: 'stale-agent',
    });
    expect(started).toBeNull();
  });

  it('omits lifecycleTransitionError on a successful managed todo→running dispatch', async () => {
    // The happy path must not populate lifecycleTransitionError: when the
    // transition succeeds, the field stays absent so callers can distinguish
    // "running cleanly" from "running but lifecycle diverged".
    const b = await createBoard(tmpDir, {
      title: 'Managed',
      columns: COLS,
      lifecycle: managedLifecycle(),
    });
    const added = await addTask(tmpDir, b.id, {
      title: 'Managed Task',
      description: 'Detailed scope.',
    });
    await updateTask(tmpDir, b.id, added!.task.id, {
      assignee: 'agent-1',
      dueDate: FUTURE,
      labels: ['test'],
      childTaskIds: ['child-1'],
      successCriteria: [{ id: 'c1', description: 'Pass', type: 'manual', status: 'pending' }],
    });
    const { transitionTask } = await import('./helpers/session-manager.js');
    await transitionTask(tmpDir, b.id, added!.task.id, {
      to: 'todo',
      actor: 'agent',
      comment: 'Ready.',
    });

    const reserved = await reserveKanbanDispatch(tmpDir, { boardId: b.id });
    expect(reserved).not.toBeNull();

    const started = await startKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: reserved!.lease.leaseId,
      actor: 'test-agent',
    });
    expect(started).not.toBeNull();
    expect(started!.task.lifecycle?.currentStage).toBe('running');
    expect(started!.task.assignment?.status).toBe('running');
    // No lifecycle divergence on the success path.
    expect(started!.lifecycleTransitionError).toBeUndefined();
  });
});

// ── Complete ─────────────────────────────────────────────────────────

describe('completeKanbanDispatch', () => {
  it('completes a legacy task with a result', async () => {
    const b = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    await addTask(tmpDir, b.id, {
      title: 'Task',
      description: 'Work.',
      status: 'ready',
      columnId: 'todo',
    });
    const reserved = await reserveKanbanDispatch(tmpDir, { boardId: b.id });
    await startKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: reserved!.lease.leaseId,
      actor: 'agent',
    });

    const completed = await completeKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: reserved!.lease.leaseId,
      actor: 'agent',
      result: 'Implementation done. Tests pass.',
    });
    expect(completed).not.toBeNull();
    expect(completed!.task.assignment?.status).toBe('completed');
    expect(completed!.task.assignment?.lastResult).toContain('Implementation done');
  });

  it('transitions managed task from running to review on completion', async () => {
    const b = await createBoard(tmpDir, {
      title: 'Managed',
      columns: COLS,
      lifecycle: managedLifecycle(),
    });
    const added = await addTask(tmpDir, b.id, {
      title: 'Managed Task',
      description: 'Detailed scope.',
    });
    await updateTask(tmpDir, b.id, added!.task.id, {
      assignee: 'agent-1',
      dueDate: FUTURE,
      labels: ['test'],
      childTaskIds: ['child-1'],
      successCriteria: [{ id: 'c1', description: 'Pass', type: 'manual', status: 'pending' }],
    });
    const { transitionTask } = await import('./helpers/session-manager.js');
    await transitionTask(tmpDir, b.id, added!.task.id, {
      to: 'todo',
      actor: 'agent',
      comment: 'Ready.',
    });

    const reserved = await reserveKanbanDispatch(tmpDir, { boardId: b.id });
    await startKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: reserved!.lease.leaseId,
      actor: 'agent',
    });

    const completed = await completeKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: reserved!.lease.leaseId,
      actor: 'agent',
      result: 'Work done.',
    });
    expect(completed).not.toBeNull();
    expect(completed!.task.lifecycle?.currentStage).toBe('review');
    expect(completed!.task.assignment?.status).toBe('completed');
  });
});

// ── Fail ─────────────────────────────────────────────────────────────

describe('failKanbanDispatch', () => {
  it('records a failure with error message', async () => {
    const b = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    await addTask(tmpDir, b.id, {
      title: 'Task',
      description: 'Work.',
      status: 'ready',
      columnId: 'todo',
    });
    const reserved = await reserveKanbanDispatch(tmpDir, { boardId: b.id });
    await startKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: reserved!.lease.leaseId,
      actor: 'agent',
    });

    const failed = await failKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: reserved!.lease.leaseId,
      actor: 'agent',
      error: 'Tests failed: 3 errors.',
    });
    expect(failed).not.toBeNull();
    const task = failed!.tasks.find((t) => t.id === reserved!.task.id);
    expect(task?.assignment?.status).toBe('failed');
    expect(task?.assignment?.error).toContain('Tests failed');
    expect(task?.status).toBe('failed');
  });

  it('returns null when lease does not match', async () => {
    const b = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    await addTask(tmpDir, b.id, {
      title: 'Task',
      description: 'Work.',
      status: 'ready',
      columnId: 'todo',
    });
    const reserved = await reserveKanbanDispatch(tmpDir, { boardId: b.id });

    const failed = await failKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: 'wrong-lease',
      actor: 'stale',
      error: 'Should not apply.',
    });
    expect(failed).toBeNull();
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────

describe('heartbeatKanbanDispatch', () => {
  it('renews the lease heartbeat timestamp', async () => {
    const b = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    await addTask(tmpDir, b.id, {
      title: 'Task',
      description: 'Work.',
      status: 'ready',
      columnId: 'todo',
    });
    const reserved = await reserveKanbanDispatch(tmpDir, { boardId: b.id });

    const heartbeated = await heartbeatKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: reserved!.lease.leaseId,
    });
    expect(heartbeated).not.toBeNull();
    const task = heartbeated!.tasks.find((t) => t.id === reserved!.task.id);
    expect(task?.assignment?.heartbeatAt).toBeDefined();
  });

  it('returns null when lease does not match', async () => {
    const b = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    await addTask(tmpDir, b.id, {
      title: 'Task',
      description: 'Work.',
      status: 'ready',
      columnId: 'todo',
    });
    const reserved = await reserveKanbanDispatch(tmpDir, { boardId: b.id });

    const result = await heartbeatKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: 'wrong-lease',
    });
    expect(result).toBeNull();
  });
});

// ── Cancel ────────────────────────────────────────────────────────────

describe('cancelKanbanDispatch', () => {
  it('releases a claimed task back to the queue', async () => {
    const b = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    await addTask(tmpDir, b.id, {
      title: 'Task',
      description: 'Work.',
      status: 'ready',
      columnId: 'todo',
    });
    const reserved = await reserveKanbanDispatch(tmpDir, { boardId: b.id });

    const cancelled = await cancelKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: reserved!.lease.leaseId,
      actor: 'agent',
      reason: 'Changed priority.',
    });
    expect(cancelled).not.toBeNull();
    const task = cancelled!.tasks.find((t) => t.id === reserved!.task.id);
    // After release, assignment is cleared and status returns to ready/blocked
    expect(task?.assignment).toBeUndefined();
    expect(task?.status).toBe('ready');
  });

  it('returns null when lease does not match', async () => {
    const b = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    await addTask(tmpDir, b.id, {
      title: 'Task',
      description: 'Work.',
      status: 'ready',
      columnId: 'todo',
    });
    const reserved = await reserveKanbanDispatch(tmpDir, { boardId: b.id });

    const result = await cancelKanbanDispatch(tmpDir, {
      boardId: reserved!.board.id,
      taskId: reserved!.task.id,
      leaseId: 'wrong-lease',
      actor: 'stale',
      reason: 'Should not work.',
    });
    // updateTaskAssignment with wrong lease returns null, so cancelKanbanDispatch returns null
    expect(result).toBeNull();
  });
});

// ── Concurrency ─────────────────────────────────────────────────────

describe('reserveKanbanDispatch under concurrent reservation', () => {
  it('awards the task to exactly one of two concurrent reservations', async () => {
    // Two concurrent reservations racing for the same ready task must produce
    // exactly one winner and one null (loser). The protection is the
    // revision-based optimistic lock inside mutateBoard: the first commit
    // bumps revision, the second's expected-revision check fails and the
    // claim returns null. This was previously untested at the dispatch layer.
    const b = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    await addTask(tmpDir, b.id, {
      title: 'Contended Task',
      description: 'Only one agent may claim this.',
      status: 'ready',
      columnId: 'todo',
    });

    const [a, c] = await Promise.all([
      reserveKanbanDispatch(tmpDir, { boardId: b.id }),
      reserveKanbanDispatch(tmpDir, { boardId: b.id }),
    ]);

    const results = [a, c];
    const winners = results.filter((r) => r !== null);
    const losers = results.filter((r) => r === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });
});

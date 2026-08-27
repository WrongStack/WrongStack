import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KanbanBoard } from '../src/types.js';
import {
  addTask,
  assignTask,
  createBoard,
  getBoard,
  recoverStaleTaskAssignments,
  releaseTaskClaim,
  transitionTask,
  updateTaskAssignment,
} from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-mgd-recovery-'));
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

const policy = {
  mode: 'managed' as const,
  columns: {
    backlog: 'backlog',
    todo: 'todo',
    running: 'in-progress',
    review: 'review',
    done: 'done',
  },
};

function fullDetails() {
  return {
    description: 'A complete task with every required detail.',
    dueDate: '2026-08-01T00:00:00.000Z',
    assignee: 'agent-1',
    labels: ['release'],
    childTaskIds: ['child-1'],
    successCriteria: [
      {
        id: 'c1',
        description: 'Acceptance criterion',
        type: 'manual' as const,
        status: 'pending' as const,
      },
    ],
  };
}

async function makeRunningManagedTask(): Promise<{
  board: KanbanBoard;
  taskId: string;
}> {
  const board = await createBoard(tmpDir, {
    title: 'Managed Recovery Board',
    columns: COLS,
    lifecycle: policy,
  });
  const added = await addTask(tmpDir, board.id, {
    title: 'Recovery target',
    ...fullDetails(),
  });
  await transitionTask(tmpDir, board.id, added!.task.id, {
    to: 'todo',
    actor: 'agent-1',
    comment: 'Ready.',
  });
  await assignTask(tmpDir, board.id, added!.task.id, {
    agentId: 'agent-1',
    name: 'worker',
  });
  await updateTaskAssignment(tmpDir, board.id, added!.task.id, {
    status: 'running',
    leaseId: 'lease-1',
    claimedAt: '2026-07-31T00:00:00.000Z',
    heartbeatAt: '2026-07-31T00:00:00.000Z',
    leaseExpiresAt: '2026-12-31T00:00:00.000Z',
  });
  await transitionTask(tmpDir, board.id, added!.task.id, {
    to: 'running',
    actor: 'agent-1',
    comment: 'Started.',
  });
  // Now expire the lease so recovery picks it up.
  await updateTaskAssignment(tmpDir, board.id, added!.task.id, {
    leaseExpiresAt: '2020-01-01T00:00:00.000Z',
  });
  return { board, taskId: added!.task.id };
}

// ── recoverStaleTaskAssignments: managed boards ──────────────────────

/**
 * Recovery never lets a raw status→column sync touch a managed card — the
 * lifecycle stage is authoritative there. But leaving the stage untouched was
 * not the same as leaving the card usable: an assignment-less card in Running
 * classifies as `running_no_lease`, which is not claimable, so a recovered card
 * needed a human to run repair_managed_projection before anything could pick it
 * up again.
 *
 * Recovery now walks a retried/released card back one legal step to Todo under
 * a `kanban-supervisor` actor. A `fail`ed card is deliberately left in Running:
 * its retry budget is spent, and re-queueing it would loop.
 */
describe('recoverStaleTaskAssignments — managed boards', () => {
  it('retry mode: clears the assignment and returns the card to Todo', async () => {
    const { board, taskId } = await makeRunningManagedTask();

    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'retry',
      now: '2026-08-01T00:00:00.000Z',
    });

    expect(result).not.toBeNull();
    const updated = await getBoard(tmpDir, board.id);
    const task = updated!.tasks.find((t) => t.id === taskId)!;

    // Walked back one stage so the queue can serve it again.
    expect(task.lifecycle?.currentStage).toBe('todo');
    expect(task.columnId).toBe('todo');
    // The walk-back is an audited transition, not a silent projection edit.
    expect(task.lifecycle?.history.at(-1)).toMatchObject({
      from: 'running',
      to: 'todo',
      actor: 'kanban-supervisor',
    });
    // Assignment was retried (attempt incremented, lease cleared).
    expect(task.assignment?.status).toBe('assigned');
    expect(task.assignment?.leaseId).toBeUndefined();
    expect(task.assignment?.attempt).toBeGreaterThan(0);
  });

  it('release mode: clears the assignment and returns the card to Todo', async () => {
    const { board, taskId } = await makeRunningManagedTask();

    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'release',
      now: '2026-08-01T00:00:00.000Z',
    });

    expect(result).not.toBeNull();
    const updated = await getBoard(tmpDir, board.id);
    const task = updated!.tasks.find((t) => t.id === taskId)!;

    expect(task.lifecycle?.currentStage).toBe('todo');
    expect(task.columnId).toBe('todo');
    // Assignment fully released.
    expect(task.assignment).toBeUndefined();
  });

  it('returns the recovered board with the walk-back already applied', async () => {
    const { board, taskId } = await makeRunningManagedTask();

    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'release',
      now: '2026-08-01T00:00:00.000Z',
    });

    // The caller must not have to re-read the board to see the final stage.
    const returned = result!.board.tasks.find((t) => t.id === taskId)!;
    expect(returned.lifecycle?.currentStage).toBe('todo');
  });

  it('fail mode: marks assignment failed but preserves lifecycle stage and column', async () => {
    const { board, taskId } = await makeRunningManagedTask();

    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'fail',
      now: '2026-08-01T00:00:00.000Z',
    });

    expect(result).not.toBeNull();
    const updated = await getBoard(tmpDir, board.id);
    const task = updated!.tasks.find((t) => t.id === taskId)!;

    // Lifecycle stage preserved — fail does not override the column.
    expect(task.lifecycle?.currentStage).toBe('running');
    expect(task.columnId).toBe('in-progress');
    // Assignment marked failed.
    expect(task.assignment?.status).toBe('failed');
    expect(task.assignment?.error).toBeDefined();
  });

  it('stamps lastStaleRecoveredAt on the board', async () => {
    const { board } = await makeRunningManagedTask();

    await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'retry',
      now: '2026-08-01T12:00:00.000Z',
    });

    const updated = await getBoard(tmpDir, board.id);
    expect(updated?.lastStaleRecoveredAt).toBeDefined();
  });
});

// ── releaseTaskClaim: managed boards ─────────────────────────────────

describe('releaseTaskClaim — managed boards', () => {
  it('clears assignment but preserves lifecycle stage and column', async () => {
    const { board, taskId } = await makeRunningManagedTask();

    const result = await releaseTaskClaim(tmpDir, board.id, taskId, {
      reason: 'Test release on managed board.',
    });

    expect(result).not.toBeNull();
    const updated = await getBoard(tmpDir, board.id);
    const task = updated!.tasks.find((t) => t.id === taskId)!;

    // Lifecycle stage preserved — release does not move the card backward.
    expect(task.lifecycle?.currentStage).toBe('running');
    expect(task.columnId).toBe('in-progress');
    // Assignment cleared.
    expect(task.assignment).toBeUndefined();
    // Reason note recorded.
    expect(task.notes?.some((n) => n.content.includes('Test release'))).toBe(true);
  });
});

// ── Legacy boards still work as before ───────────────────────────────

describe('recoverStaleTaskAssignments — legacy boards (unchanged)', () => {
  it('retry mode: clears assignment and syncs status→column', async () => {
    const board = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    const added = await addTask(tmpDir, board.id, {
      title: 'Legacy task',
      status: 'ready',
      columnId: 'todo',
    });
    await assignTask(tmpDir, board.id, added!.task.id, { agentId: 'bot' });
    await updateTaskAssignment(tmpDir, board.id, added!.task.id, {
      status: 'running',
      leaseId: 'lease-1',
      leaseExpiresAt: '2020-01-01T00:00:00.000Z',
    });

    await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'retry',
      now: '2026-08-01T00:00:00.000Z',
    });

    const updated = await getBoard(tmpDir, board.id);
    const task = updated!.tasks.find((t) => t.id === added!.task.id)!;

    // Legacy: status was synced (ready/blocked based on deps) and column moved.
    expect(task.status).toBe('ready');
    expect(task.columnId).toBe('todo');
    expect(task.assignment?.status).toBe('assigned');
  });

  it('release mode: clears assignment and moves card back to ready column', async () => {
    const board = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    const added = await addTask(tmpDir, board.id, {
      title: 'Legacy task',
      status: 'ready',
      columnId: 'todo',
    });
    await assignTask(tmpDir, board.id, added!.task.id, { agentId: 'bot' });
    await updateTaskAssignment(tmpDir, board.id, added!.task.id, {
      status: 'running',
      leaseId: 'lease-1',
      leaseExpiresAt: '2020-01-01T00:00:00.000Z',
    });

    await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'release',
      now: '2026-08-01T00:00:00.000Z',
    });

    const updated = await getBoard(tmpDir, board.id);
    const task = updated!.tasks.find((t) => t.id === added!.task.id)!;

    // Legacy: assignment gone, status synced.
    expect(task.assignment).toBeUndefined();
    expect(task.status).toBe('ready');
  });

  it('fail mode: marks task failed and column synced', async () => {
    const board = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    const added = await addTask(tmpDir, board.id, {
      title: 'Legacy task',
      status: 'ready',
      columnId: 'todo',
    });
    await assignTask(tmpDir, board.id, added!.task.id, { agentId: 'bot' });
    await updateTaskAssignment(tmpDir, board.id, added!.task.id, {
      status: 'running',
      leaseId: 'lease-1',
      leaseExpiresAt: '2020-01-01T00:00:00.000Z',
    });

    await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'fail',
      now: '2026-08-01T00:00:00.000Z',
    });

    const updated = await getBoard(tmpDir, board.id);
    const task = updated!.tasks.find((t) => t.id === added!.task.id)!;

    // Legacy: status failed.
    expect(task.status).toBe('failed');
    expect(task.assignment?.status).toBe('failed');
  });
});

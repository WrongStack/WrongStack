import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateContractGraphReadiness } from '../src/contract-graph.js';
import { validateManagedTaskTransition } from '../src/manager/lifecycle.js';
import { classifyTaskForQueue } from '../src/manager/task-classifier.js';
import { writeBoard } from '../src/storage.js';
import type { KanbanBoard, KanbanTask } from '../src/types.js';
import {
  addTask,
  assignTask,
  createBoard,
  createManagedLifecyclePolicy,
  getBoard,
  getKanbanQueueHealth,
  listReadyTasks,
  recoverStaleTaskAssignments,
  transitionTask,
  updateTaskAssignment,
} from './helpers/session-manager.js';

/**
 * "Can this card be started?" had four implementations. Three of them —
 * `validateRequiredCardDetails`, `evaluateContractGraphReadiness` and
 * `classifyTaskForQueue` — were aligned on the same field set. The fourth,
 * `isTaskReadyForWork`, checked no card detail at all, and it is the one that
 * feeds `counts.startable`, `listReadyTasks` and `claimReadyTask`.
 *
 * So a managed card missing its owner was counted as claimable, listed as
 * ready, and handed out by the dispatcher — and then `start_task` refused it
 * with "Task is not implementation-ready". Recovery is what made that state
 * routine: a released card walks back to Todo, and the release used to delete
 * `assignee` on its way.
 *
 * These tests hold the queue's answer to the gate's answer.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-startability-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

const DETAILS = {
  description: 'A card carrying everything the managed gate asks for.',
  assignee: 'owner-1',
  successCriteria: [
    {
      id: 'c1',
      description: 'Acceptance criterion',
      type: 'manual' as const,
      status: 'pending' as const,
    },
  ],
};

async function managedBoard(): Promise<KanbanBoard> {
  return createBoard(tmpDir, {
    title: 'Startability agreement',
    lifecycle: createManagedLifecyclePolicy(),
  });
}

async function todoCard(
  board: KanbanBoard,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const added = await addTask(tmpDir, board.id, { title: 'Card', ...DETAILS, ...overrides });
  const taskId = added!.task.id;
  await transitionTask(tmpDir, board.id, taskId, {
    to: 'todo',
    actor: 'owner-1',
    comment: 'Card is fully specified.',
  });
  return taskId;
}

async function verdicts(boardId: string, taskId: string) {
  const board = (await getBoard(tmpDir, boardId)) as KanbanBoard;
  const task = board.tasks.find((candidate: KanbanTask) => candidate.id === taskId);
  const health = await getKanbanQueueHealth(tmpDir, { boardId });
  const ready = await listReadyTasks(tmpDir, { boardId });
  return {
    task,
    startable: health.counts.startable,
    inReadyList: ready.some((entry) => entry.task.id === taskId),
    // A clean card produces no diagnostic entry at all — the classifier only
    // records one when it has a reason — so read the bucket tally instead.
    claimable: health.classifications?.counts.claimable ?? 0,
    bucket: health.classifications?.diagnostics.find((d) => d.taskId === taskId)?.bucket,
    gateAccepts: evaluateContractGraphReadiness(board, taskId).ready,
  };
}

/**
 * All THREE detail predicates on one corpus.
 *
 *   - `classifyTaskForQueue`        → the queue bucket an agent reads
 *   - `evaluateContractGraphReadiness` → the gate `start_task` consults
 *   - `validateManagedTaskTransition`  → the gate that actually blocks the move
 *
 * They are supposed to demand the same fields. They did not: the contract graph
 * had no `atomic → childTaskIds` rule, so a childless composite parent was
 * reported "start ready", accepted by `start_task`, and thrown out by the
 * transition a moment later — while the queue had already binned it as
 * `detail_incomplete`. Three surfaces, three answers, one card.
 */
describe('managed card detail predicates agree', () => {
  const policy = createManagedLifecyclePolicy();
  const base = {
    id: 't1',
    title: 'Card',
    columnId: policy.columns.todo,
    order: 0,
    priority: 'medium',
    status: 'ready',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    description: 'A described card.',
    assignee: 'owner-1',
    successCriteria: [
      { id: 'c', description: 'ok', type: 'manual' as const, status: 'pending' as const },
    ],
    lifecycle: {
      currentStage: 'todo' as const,
      stageEnteredAt: '2026-08-10T00:00:00.000Z',
      history: [],
    },
  };

  const CORPUS: Array<[string, Record<string, unknown>]> = [
    ['fully specified leaf', {}],
    ['missing description', { description: '  ' }],
    ['missing owner', { assignee: undefined }],
    ['missing success criteria', { successCriteria: [] }],
    [
      'success criterion with a blank description',
      {
        successCriteria: [{ id: 'c', description: '  ', type: 'manual', status: 'pending' }],
      },
    ],
    ['composite parent with children', { atomic: true, childTaskIds: ['child-1'] }],
    ['composite parent with NO children', { atomic: true, childTaskIds: [] }],
    ['composite parent with blank child ids', { atomic: true, childTaskIds: ['  '] }],
    ['leaf without children (allowed)', { atomic: false, childTaskIds: [] }],
  ];

  it.each(CORPUS)('agrees on "%s"', (_label, overrides) => {
    const task = { ...base, ...overrides } as unknown as KanbanTask;
    const board = {
      id: 'b1',
      title: 'Predicates',
      columns: Object.values(policy.columns).map((id, index) => ({ id, title: id, order: index })),
      tasks: [task],
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
      version: 1,
      lifecycle: policy,
    } as unknown as KanbanBoard;

    const queueComplete =
      classifyTaskForQueue(board, task, { now: '2026-08-10T12:00:00.000Z' }).bucket !==
      'detail_incomplete';
    const gateComplete = evaluateContractGraphReadiness(board, task.id).ready;
    // The transition validator also enforces running-ownership, which is about
    // holding a lease rather than card detail — filter to the detail issues.
    const DETAIL_FIELDS = new Set(['description', 'assignee', 'childTaskIds', 'successCriteria']);
    const transitionComplete = !validateManagedTaskTransition(board, task, {
      to: 'running',
      actor: 'tester',
      comment: 'parity probe',
    }).some(
      (issue) => issue.code === 'task-detail-missing' && DETAIL_FIELDS.has(issue.field ?? ''),
    );

    expect({ queueComplete, gateComplete }).toEqual({
      queueComplete: transitionComplete,
      gateComplete: transitionComplete,
    });
  });
});

describe('queue startability agrees with the start gate', () => {
  it('offers a fully specified managed card', async () => {
    const board = await managedBoard();
    const taskId = await todoCard(board);

    const v = await verdicts(board.id, taskId);
    expect(v.gateAccepts).toBe(true);
    expect(v.startable).toBe(1);
    expect(v.inReadyList).toBe(true);
  });

  it('refuses to create a detail-missing card on a managed board at all', async () => {
    // Worth pinning because it bounds the problem: `addTask` runs the same
    // detail validation, so a managed card cannot be BORN incomplete. The only
    // routes into the incomplete state are mutations that strip a field after
    // the fact — which is exactly what recovery used to do.
    const board = await managedBoard();
    await expect(
      addTask(tmpDir, board.id, { title: 'Card', ...DETAILS, description: '' }),
    ).rejects.toThrow(/description/i);
  });

  it('does not offer a managed card whose owner was stripped after creation', async () => {
    const board = await managedBoard();
    const taskId = await todoCard(board);
    // Reach the state directly rather than through recovery, so this test still
    // fails if the queue predicate regresses even after recovery is fixed.
    const stored = (await getBoard(tmpDir, board.id)) as KanbanBoard;
    const task = stored.tasks.find((candidate: KanbanTask) => candidate.id === taskId)!;
    delete task.assignee;
    delete task.assignedAgent;
    await writeBoard(tmpDir, stored);

    const v = await verdicts(board.id, taskId);
    expect(v.gateAccepts).toBe(false);
    expect(v.bucket).toBe('detail_incomplete');
    // The queue must reach the same conclusion, by whichever number the caller
    // happens to read.
    expect(v.startable).toBe(0);
    expect(v.inReadyList).toBe(false);
  });

  it('returns a recovered card to the queue in a state that can actually start', async () => {
    // The full path: specified card → claimed → lease expires → supervisor
    // recovers it → back in Todo. Before the fix this card came back with no
    // owner: counted as startable, listed as ready, refused by the gate.
    const board = await managedBoard();
    const taskId = await todoCard(board);
    await assignTask(tmpDir, board.id, taskId, { agentId: 'worker-1', name: 'worker' });
    await updateTaskAssignment(tmpDir, board.id, taskId, {
      status: 'running',
      leaseId: 'lease-1',
      claimedAt: '2026-08-01T00:00:00.000Z',
      heartbeatAt: '2026-08-01T00:00:00.000Z',
      leaseExpiresAt: '2026-08-01T00:01:00.000Z',
    });
    await transitionTask(tmpDir, board.id, taskId, {
      to: 'running',
      actor: 'worker-1',
      comment: 'Started.',
    });

    const recovered = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'release',
      reason: 'Lease expired.',
      now: '2026-08-02T00:00:00.000Z',
    });
    expect(recovered?.tasks.map((task) => task.id)).toContain(taskId);

    const v = await verdicts(board.id, taskId);
    expect(v.task?.lifecycle?.currentStage).toBe('todo');
    // The worker's agent id is gone; the required `assignee` field is not.
    // (It reads 'worker' rather than 'owner-1' because `assignTask` overwrites
    // `assignee` with the worker's name — a pre-existing conflation of owner
    // and worker. What matters here is that recovery leaves it populated.)
    expect(v.task?.assignedAgent).toBeUndefined();
    expect(v.task?.assignee).toBeTruthy();
    expect(v.claimable).toBe(1);
    expect(v.gateAccepts).toBe(true);
    expect(v.startable).toBe(1);
    expect(v.inReadyList).toBe(true);
  });

  it('does not return a card to the queue once its retry budget is spent', async () => {
    // `retry` with attempts exhausted marks the assignment failed — the same
    // terminal state `fail` mode produces. Walking THAT card back to Todo hands
    // it straight to the next claimer, which fails it again: a loop. The
    // walk-back must key on the resulting state, not on the requested mode.
    const board = await managedBoard();
    const taskId = await todoCard(board);
    await assignTask(tmpDir, board.id, taskId, { agentId: 'worker-1', name: 'worker' });
    await updateTaskAssignment(tmpDir, board.id, taskId, {
      status: 'running',
      leaseId: 'lease-1',
      claimedAt: '2026-08-01T00:00:00.000Z',
      heartbeatAt: '2026-08-01T00:00:00.000Z',
      leaseExpiresAt: '2026-08-01T00:01:00.000Z',
      attempt: 3,
      maxAttempts: 3,
    });
    await transitionTask(tmpDir, board.id, taskId, {
      to: 'running',
      actor: 'worker-1',
      comment: 'Started.',
    });

    await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'retry',
      reason: 'Lease expired.',
      now: '2026-08-02T00:00:00.000Z',
    });

    const v = await verdicts(board.id, taskId);
    expect(v.task?.assignment?.status).toBe('failed');
    expect(v.task?.lifecycle?.currentStage, 'an exhausted card must not be requeued').toBe(
      'running',
    );
    expect(v.startable).toBe(0);
    expect(v.inReadyList).toBe(false);
  });

  it('still clears the assignee on a legacy board, where it records the worker', async () => {
    const board = await createBoard(tmpDir, { title: 'Legacy' });
    const taskId = (await addTask(tmpDir, board.id, { title: 'Card' }))!.task.id;
    await assignTask(tmpDir, board.id, taskId, { agentId: 'worker-1', name: 'worker' });
    await updateTaskAssignment(tmpDir, board.id, taskId, {
      status: 'running',
      leaseId: 'lease-1',
      claimedAt: '2026-08-01T00:00:00.000Z',
      heartbeatAt: '2026-08-01T00:00:00.000Z',
      leaseExpiresAt: '2026-08-01T00:01:00.000Z',
    });

    await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'release',
      reason: 'Lease expired.',
      now: '2026-08-02T00:00:00.000Z',
    });

    const board2 = (await getBoard(tmpDir, board.id)) as KanbanBoard;
    const task = board2.tasks.find((candidate: KanbanTask) => candidate.id === taskId);
    expect(task?.assignee).toBeUndefined();
    expect(task?.assignedAgent).toBeUndefined();
  });
});

/**
 * The refusal budget: verification guards Done without stalling progress.
 *
 * Before this, a strict gate refusal put the card back in `review` and counted
 * nothing, so the same card could be re-verified forever — and on a managed
 * board every card downstream of it stayed unreachable. These tests pin the
 * two halves that make it terminate: refusals accumulate, and the card parks
 * exactly once the budget is spent.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  dependencyIncompleteMessage,
  formatDependencyReadinessIssues,
  getDependencyReadinessIssues,
} from '../src/manager/task-readiness.js';
import { readKanbanEvents } from '../src/storage.js';
import type { KanbanBoard, KanbanTask } from '../src/types.js';
import {
  applyGateRefusal,
  clearGateRefusals,
  DEFAULT_MAX_VERIFICATION_ATTEMPTS,
  isBudgetedRefusal,
  isParked,
  maxVerificationAttempts,
} from '../src/verification/completion-park.js';
import {
  addCheckToTask,
  addTask,
  assignTask,
  createBoard,
  finalizeTaskCompletion,
  getBoard,
  updateTaskAssignment,
} from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-park-'));
});

/** A legacy strict-gate board whose single card cannot pass: its manual check is pending. */
async function refusableCard(maxVerificationAttempts?: number) {
  const board = await createBoard(tmpDir, {
    title: 'Park board',
    completionGate: {
      enforcement: 'strict',
      ...(maxVerificationAttempts !== undefined ? { maxVerificationAttempts } : {}),
    },
  });
  const added = await addTask(tmpDir, board.id, { title: 'Refused task' });
  await addCheckToTask(tmpDir, board.id, added!.task.id, {
    description: 'Manually confirmed by reviewer',
    type: 'manual',
    status: 'pending',
  });
  await assignTask(tmpDir, board.id, added!.task.id, { agentId: 'worker' });
  await updateTaskAssignment(tmpDir, board.id, added!.task.id, { status: 'completed' });
  return { boardId: board.id, taskId: added!.task.id };
}

const taskOf = async (boardId: string, taskId: string): Promise<KanbanTask> => {
  const board = await getBoard(tmpDir, boardId);
  return board!.tasks.find((task) => task.id === taskId)!;
};

describe('maxVerificationAttempts', () => {
  it('defaults to two and never drops below one', () => {
    const bare = {} as KanbanBoard;
    expect(maxVerificationAttempts(bare)).toBe(DEFAULT_MAX_VERIFICATION_ATTEMPTS);
    expect(DEFAULT_MAX_VERIFICATION_ATTEMPTS).toBe(2);

    // A card that can never park is the wedge this policy exists to prevent,
    // so 0 and a negative budget are clamped rather than honored.
    const zero = { completionGate: { enforcement: 'strict', maxVerificationAttempts: 0 } };
    expect(maxVerificationAttempts(zero as KanbanBoard)).toBe(1);
    const negative = { completionGate: { enforcement: 'strict', maxVerificationAttempts: -3 } };
    expect(maxVerificationAttempts(negative as KanbanBoard)).toBe(1);
    const five = { completionGate: { enforcement: 'strict', maxVerificationAttempts: 5 } };
    expect(maxVerificationAttempts(five as KanbanBoard)).toBe(5);
  });
});

describe('finalizeTaskCompletion refusal budget', () => {
  it('counts the first refusal and leaves the card in review', async () => {
    const { boardId, taskId } = await refusableCard();

    const first = await finalizeTaskCompletion(tmpDir, boardId, taskId);
    expect(first?.gate.allowed).toBe(false);

    const task = await taskOf(boardId, taskId);
    expect(task.verificationAttempts).toBe(1);
    expect(task.park).toBeUndefined();
    expect(task.status).toBe('review');
  });

  it('parks the card on the second refusal instead of parking the worker', async () => {
    const { boardId, taskId } = await refusableCard();

    await finalizeTaskCompletion(tmpDir, boardId, taskId);
    await finalizeTaskCompletion(tmpDir, boardId, taskId);

    const task = await taskOf(boardId, taskId);
    expect(task.verificationAttempts).toBe(2);
    expect(task.park?.attempts).toBe(2);
    expect(task.park?.reason).toBeTruthy();
    expect(task.park?.issues?.length).toBeGreaterThan(0);
    // Parked is blocked, never completed: the gate still did its job.
    expect(task.status).toBe('blocked');
    expect(task.completedAt).toBeUndefined();

    const events = await readKanbanEvents(tmpDir, boardId);
    const types = events.map((event) => event.type);
    expect(types).toContain('task.completion.parked');
    // The pre-existing refusal event is still emitted — parking adds a signal,
    // it does not replace the one consumers already listen for.
    expect(types.filter((type) => type === 'task.completion.gate_blocked')).toHaveLength(2);
  });

  it('honors a wider budget before parking', async () => {
    const { boardId, taskId } = await refusableCard(3);

    await finalizeTaskCompletion(tmpDir, boardId, taskId);
    await finalizeTaskCompletion(tmpDir, boardId, taskId);
    expect((await taskOf(boardId, taskId)).park).toBeUndefined();

    await finalizeTaskCompletion(tmpDir, boardId, taskId);
    expect((await taskOf(boardId, taskId)).park?.attempts).toBe(3);
  });
});

describe('applyGateRefusal', () => {
  const boardWith = (task: KanbanTask, managed = false): KanbanBoard =>
    ({
      id: 'b',
      columns: [],
      tasks: [task],
      ...(managed ? { lifecycle: { mode: 'managed' } } : {}),
    }) as unknown as KanbanBoard;

  const card = (): KanbanTask =>
    ({ id: 't', title: 'card', status: 'review', columnId: 'c' }) as unknown as KanbanTask;

  it('leaves a managed card in its stage and signals only through park', () => {
    const task = card();
    const board = boardWith(task, true);

    applyGateRefusal(board, task, { reason: 'first' });
    const outcome = applyGateRefusal(board, task, { reason: 'criteria not met' });

    expect(outcome.parked).toBe(true);
    expect(task.park?.reason).toBe('criteria not met');
    // Managed status is derived from the lifecycle stage and
    // assertManagedTaskPatchAllowed rejects out-of-band writes, so writing
    // 'blocked' here would desync stage from column.
    expect(task.status).toBe('review');
  });

  it('drops a stale park while the card is still inside its budget', () => {
    const task = card();
    const board = boardWith(task);
    board.completionGate = { enforcement: 'strict', maxVerificationAttempts: 3 };

    task.park = { reason: 'stale', parkedAt: 'then', attempts: 9 };
    applyGateRefusal(board, task, { reason: 'fresh' });

    expect(task.park).toBeUndefined();
    expect(isParked(task)).toBe(false);
  });

  it('clearGateRefusals resets both the counter and the park', () => {
    const task = card();
    task.verificationAttempts = 4;
    task.park = { reason: 'r', parkedAt: 'then', attempts: 4 };

    clearGateRefusals(task);

    expect(task.verificationAttempts).toBeUndefined();
    expect(task.park).toBeUndefined();
  });
});

describe('isBudgetedRefusal', () => {
  it('spends the budget only on refusals the next call cannot fix', () => {
    expect(isBudgetedRefusal([{ code: 'acceptance-criteria-incomplete' }])).toBe(true);
    expect(isBudgetedRefusal([{ code: 'parent-child-incomplete' }])).toBe(true);

    // Each of these names exactly what to pass or fix on the retry; parking a
    // card for one of them would punish a typo and bury the instruction.
    expect(isBudgetedRefusal([{ code: 'review-evidence-missing' }])).toBe(false);
    expect(isBudgetedRefusal([{ code: 'wip-limit-exceeded' }])).toBe(false);
    expect(isBudgetedRefusal([{ code: 'task-detail-missing' }])).toBe(false);
    expect(isBudgetedRefusal([])).toBe(false);
    expect(isBudgetedRefusal(undefined)).toBe(false);
  });
});

describe('parked dependencies', () => {
  const boardWithChain = (): KanbanBoard =>
    ({
      id: 'b',
      columns: [],
      tasks: [
        {
          id: 'blocker',
          title: 'Migrate schema',
          status: 'blocked',
          columnId: 'c',
          park: { reason: 'acceptance criteria never passed', parkedAt: 'now', attempts: 2 },
        },
        {
          id: 'waiter',
          title: 'Backfill rows',
          status: 'ready',
          columnId: 'c',
          dependsOn: ['blocker'],
        },
      ],
    }) as unknown as KanbanBoard;

  it('tells a waiting card that its blocker will not clear itself', () => {
    const issues = getDependencyReadinessIssues(boardWithChain(), 'waiter');

    expect(issues).toHaveLength(1);
    expect(issues[0]?.parkedReason).toBe('acceptance criteria never passed');
    expect(formatDependencyReadinessIssues(issues)).toContain(
      'parked: acceptance criteria never passed',
    );

    const message = dependencyIncompleteMessage(issues);
    expect(message).toContain('will not clear itself');
    expect(message).toContain('do not re-run it unchanged');
  });

  it('says nothing extra when the blocker is merely still running', () => {
    const board = boardWithChain();
    delete board.tasks[0]!.park;
    board.tasks[0]!.status = 'in_progress';

    const issues = getDependencyReadinessIssues(board, 'waiter');

    expect(issues[0]?.parkedReason).toBeUndefined();
    expect(formatDependencyReadinessIssues(issues)).toBe('Migrate schema (in_progress)');
    expect(dependencyIncompleteMessage(issues)).not.toContain('will not clear itself');
  });
});

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addTask,
  createBoard,
  getBoard,
  listBoards,
  removeBoard,
  updateTask,
} from '@wrongstack/kanban';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrainArbiter, BrainDecisionRequest } from '../../src/coordination/brain.js';
import {
  applyGoalDeliverableCompletions,
  coordinateGoalIteration,
  parseCompletedGoalDeliverables,
  recomputeGoalProgress,
} from '../../src/storage/goal-coordination.js';
import { createGoalKanbanBoard, findGoalKanbanBoard } from '../../src/storage/goal-kanban.js';
import { emptyGoal, goalFilePath, loadGoal, saveGoal } from '../../src/storage/goal-store.js';
import { setBoardStorePort } from '../../src/storage/board-store-port.js';

beforeAll(() => {
  setBoardStorePort({ addTask, createBoard, getBoard, listBoards, removeBoard, updateTask });
});

describe('goal coordination', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('parses 1-based indices and text prefixes idempotently', () => {
    const deliverables = ['Build API', 'Add tests', 'Write docs'];
    expect(parseCompletedGoalDeliverables('[DONE: 2]', deliverables)).toEqual([
      { index: 1, text: 'Add tests' },
    ]);
    expect(parseCompletedGoalDeliverables('[DONE: write]', deliverables)).toEqual([
      { index: 2, text: 'Write docs' },
    ]);
    expect(parseCompletedGoalDeliverables('[DONE: 1]', ['✅ Build API'])).toEqual([]);
  });

  it('marks deliverables and recomputes progress from the checklist', () => {
    const goal = {
      ...emptyGoal('Ship it'),
      deliverables: ['A', 'B', 'C', 'D'],
    };
    const completed = parseCompletedGoalDeliverables('[DONE: 1]\n[DONE: C]', goal.deliverables);
    const next = applyGoalDeliverableCompletions(goal, completed);
    expect(next.deliverables).toEqual(['✅ A', 'B', '✅ C', 'D']);
    expect(next.progress).toBe(50);
    expect(next.progressNote).toBe('2/4 deliverables complete');
    expect(next.journal.filter((entry) => entry.source === 'deliverable')).toHaveLength(2);
    expect(recomputeGoalProgress(next).progress).toBe(50);
  });

  it('treats Kanban task status as authoritative over stale goal markers', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-goal-authority-'));
    roots.push(projectRoot);
    const goalPath = goalFilePath(projectRoot);
    await fs.mkdir(path.dirname(goalPath), { recursive: true });
    const goal = { ...emptyGoal('Authority'), deliverables: ['✅ Ship the task'] };
    const boardId = await createGoalKanbanBoard(projectRoot, goal);
    await saveGoal(goalPath, goal);

    const repaired = await coordinateGoalIteration({ projectRoot, goalPath, finalText: '' });
    expect(repaired?.goal.deliverables).toEqual(['Ship the task']);
    expect(repaired?.goal.progress).toBe(0);

    const board = await findGoalKanbanBoard(projectRoot, boardId ?? '');
    const done = board?.columns.find((column) => column.title.toLowerCase() === 'done');
    await updateTask(projectRoot, board!.id, board!.tasks[0]!.id, {
      columnId: done!.id,
      status: 'completed',
    });
    const projected = await coordinateGoalIteration({ projectRoot, goalPath, finalText: '' });
    expect(projected?.goal.deliverables).toEqual(['✅ Ship the task']);
    expect(projected?.goal.progress).toBe(100);
  });

  it('closes Kanban ↔ goal ↔ Brain end-to-end and persists goal reached', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-goal-coordinate-'));
    roots.push(projectRoot);
    const goalPath = goalFilePath(projectRoot);
    await fs.mkdir(path.dirname(goalPath), { recursive: true });

    const goal = {
      ...emptyGoal('Ship adaptive coordination'),
      refinedGoal: 'Ship adaptive coordination',
      deliverables: ['Implement marker parser', 'Verify full loop'],
    };
    const boardId = await createGoalKanbanBoard(projectRoot, goal);
    expect(boardId).toBeTruthy();
    goal.kanbanBoardId = boardId ?? undefined;
    await saveGoal(goalPath, goal);

    const decide = vi.fn(async (_req: BrainDecisionRequest) => ({
      type: 'answer' as const,
      optionId: 'goal_reached',
      text: 'All deliverables are complete and verified.',
      rationale: 'Kanban and goal state agree.',
    }));
    const brain: BrainArbiter = { decide };

    const result = await coordinateGoalIteration({
      projectRoot,
      goalPath,
      finalText: '[DONE: 1]\n[DONE: verify full]',
      brain,
      sessionId: 'test-session',
      now: () => new Date('2026-07-17T12:00:00.000Z'),
    });

    expect(result?.reached).toBe(true);
    expect(result?.completed).toHaveLength(2);
    expect(result?.kanbanUpdatedTaskIds).toHaveLength(2);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[0]!.context).toContain('Progress: 100%');

    const persisted = await loadGoal(goalPath);
    expect(persisted?.goalState).toBe('completed');
    expect(persisted?.progress).toBe(100);
    expect(persisted?.progressNote).toBe('goal reached');
    expect(persisted?.reachedNote).toBe('goal reached');
    expect(persisted?.reachedAt).toBe('2026-07-17T12:00:00.000Z');
    expect(persisted?.deliverables?.every((item) => item.startsWith('✅'))).toBe(true);

    const board = await findGoalKanbanBoard(projectRoot, boardId ?? '');
    expect(board?.tasks).toHaveLength(2);
    expect(board?.tasks.every((task) => task.status === 'completed')).toBe(true);
    const doneColumn = board?.columns.find((column) => column.title.toLowerCase() === 'done');
    expect(doneColumn).toBeTruthy();
    expect(board?.tasks.every((task) => task.columnId === doneColumn?.id)).toBe(true);
  });

  it('keeps a 100% goal active when Brain does not verify reach', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-goal-coordinate-deny-'));
    roots.push(projectRoot);
    const goalPath = goalFilePath(projectRoot);
    await fs.mkdir(path.dirname(goalPath), { recursive: true });
    const goal = { ...emptyGoal('Need verification'), deliverables: ['Only task'] };
    await createGoalKanbanBoard(projectRoot, goal);
    await saveGoal(goalPath, goal);
    const brain: BrainArbiter = {
      decide: vi.fn(async () => ({ type: 'answer' as const, optionId: 'keep_working', text: 'Not yet.' })),
    };

    const result = await coordinateGoalIteration({
      projectRoot,
      goalPath,
      finalText: '[DONE: 1]',
      brain,
    });
    expect(result?.reached).toBe(false);
    expect(result?.goal.progress).toBe(100);
    expect(result?.goal.goalState).toBe('active');
    expect(result?.goal.reachedNote).toBeUndefined();
  });

  it('skips Brain when the deliverable list is empty', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-goal-empty-'));
    roots.push(projectRoot);
    const goalPath = goalFilePath(projectRoot);
    await fs.mkdir(path.dirname(goalPath), { recursive: true });
    await saveGoal(goalPath, emptyGoal('Empty mission'));
    const brain: BrainArbiter = { decide: vi.fn(async () => ({ type: 'answer' as const, optionId: 'goal_reached', text: 'ok' })) };

    const result = await coordinateGoalIteration({
      projectRoot,
      goalPath,
      finalText: '[DONE: 1]',
      brain,
    });
    expect(result?.reached).toBe(false);
    expect(brain.decide).not.toHaveBeenCalled();
  });

  it('treats Brain deny like keep_working', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-goal-deny-'));
    roots.push(projectRoot);
    const goalPath = goalFilePath(projectRoot);
    await fs.mkdir(path.dirname(goalPath), { recursive: true });
    const goal = { ...emptyGoal('Deny'), deliverables: ['Only deliverable'] };
    await createGoalKanbanBoard(projectRoot, goal);
    await saveGoal(goalPath, goal);
    const brain: BrainArbiter = { decide: vi.fn(async () => ({ type: 'deny' as const, reason: 'still risky' })) };

    const result = await coordinateGoalIteration({
      projectRoot,
      goalPath,
      finalText: '[DONE: 1]',
      brain,
    });
    expect(result?.reached).toBe(false);
    expect(result?.goal.goalState).toBe('active');
    expect(result?.goal.progress).toBe(100);
    expect(result?.goal.reachedNote).toBeUndefined();
  });

  it('records a deliverable journal entry only once for duplicate markers', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-goal-dup-'));
    roots.push(projectRoot);
    const goalPath = goalFilePath(projectRoot);
    await fs.mkdir(path.dirname(goalPath), { recursive: true });
    const goal = { ...emptyGoal('Duplicates'), deliverables: ['Touch one'] };
    await createGoalKanbanBoard(projectRoot, goal);
    await saveGoal(goalPath, goal);
    const brain: BrainArbiter = { decide: vi.fn(async () => ({ type: 'deny' as const, reason: 'never' })) };

    const result = await coordinateGoalIteration({
      projectRoot,
      goalPath,
      finalText: '[DONE: 1]\n[DONE: 1]\n[DONE: 1]',
      brain,
    });
    const deliverableJournal = result?.goal.journal.filter((entry) => entry.source === 'deliverable');
    // Duplicate markers must collapse to a single deliverable journal entry —
    // we deduplicate via `seen` in the parser. Brain is still consulted once
    // because allComplete is now true.
    expect(deliverableJournal).toHaveLength(1);
    expect(brain.decide).toHaveBeenCalledTimes(1);
    expect(result?.reached).toBe(false);
  });

  it('ignores markers that match no deliverable', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-goal-noop-'));
    roots.push(projectRoot);
    const goalPath = goalFilePath(projectRoot);
    await fs.mkdir(path.dirname(goalPath), { recursive: true });
    await saveGoal(goalPath, { ...emptyGoal('No match'), deliverables: ['Alpha', 'Beta'] });

    const result = await coordinateGoalIteration({
      projectRoot,
      goalPath,
      finalText: '[DONE: 99]\n[DONE: gamma]',
    });
    expect(result?.completed).toEqual([]);
    expect(result?.goal.progress).toBe(0);
    expect(result?.goal.goalState).toBe('active');
  });
});

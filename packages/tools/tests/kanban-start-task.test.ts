import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import {
  addCheckToTask,
  addGoalMetricToTask,
  addTask,
  configureContractGraph,
  createBoard,
  getBoard,
  updateTask,
  upsertContractNode,
} from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { newSignal } from './fixtures.js';

describe('kanban tool — start_task governance binding', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-start-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seedReadyTask(options: { strictGraph?: 'complete' | 'empty' } = {}) {
    const board = await createBoard(dir, {
      title: 'Governed work',
      columns: [
        { id: 'backlog', title: 'Backlog', order: 0 },
        { id: 'todo', title: 'Todo', order: 1 },
        { id: 'in-progress', title: 'Running', order: 2 },
        { id: 'review', title: 'Review', order: 3 },
        { id: 'done', title: 'Done', order: 4 },
      ],
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
    });
    const added = await addTask(dir, board.id, {
      title: 'Implement safely',
      description: 'Change the parser while preserving existing behavior.',
      assignedAgent: 'agent-1',
      dueDate: '2026-08-10T00:00:00.000Z',
      labels: ['parser'],
    });
    const taskId = added!.task.id;
    await addGoalMetricToTask(dir, board.id, taskId, {
      name: 'New syntax parses',
      target: 'pass',
    });
    await addCheckToTask(dir, board.id, taskId, {
      description: 'Regression suite passes',
      type: 'test',
    });
    if (!options.strictGraph) return { boardId: board.id, taskId };

    await configureContractGraph(dir, board.id, 'strict');
    if (options.strictGraph === 'empty') return { boardId: board.id, taskId };

    const task = (await getBoard(dir, board.id))!.tasks.find((item) => item.id === taskId)!;
    const metricId = task.goalMetrics![0]!.id;
    const checkId = task.successCriteria![0]!.id;
    await upsertContractNode(dir, board.id, {
      taskId,
      kind: 'objective',
      title: 'Support new syntax',
      metricId,
    });
    await upsertContractNode(dir, board.id, {
      taskId,
      kind: 'guardrail',
      title: 'Preserve existing syntax',
      checkId,
    });
    await upsertContractNode(dir, board.id, {
      taskId,
      kind: 'risk',
      title: 'Token ambiguity',
      enforcement: 'advisory',
    });
    await upsertContractNode(dir, board.id, {
      taskId,
      kind: 'component',
      title: 'Parser package',
    });
    await upsertContractNode(dir, board.id, {
      taskId,
      kind: 'verification',
      title: 'Regression suite',
      checkId,
      enforcement: 'advisory',
    });
    return { boardId: board.id, taskId };
  }

  it('starts a detailed card without making Contract Map setup a prerequisite', async () => {
    const { boardId, taskId } = await seedReadyTask();
    const setCurrentKanbanTask = vi.fn();
    const ctx = { projectRoot: dir, setCurrentKanbanTask } as unknown as Context;

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId,
        taskId,
        author: 'agent-1',
        transitionComment: 'Contract reviewed; implementation starting.',
      },
      ctx,
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    expect(result.task?.lifecycle?.currentStage).toBe('running');
    expect(result.task?.assignment?.status).toBe('running');
    expect(result.task?.assignment?.leaseId).toBeTruthy();
    expect(setCurrentKanbanTask).toHaveBeenCalledWith(taskId, boardId);
  });

  it('still accepts a complete operator-owned strict Contract Map', async () => {
    const { boardId, taskId } = await seedReadyTask({ strictGraph: 'complete' });
    const setCurrentKanbanTask = vi.fn();

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId,
        taskId,
        author: 'agent-1',
        transitionComment: 'Operator policy is satisfied; implementation starting.',
      },
      { projectRoot: dir, setCurrentKanbanTask } as unknown as Context,
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    expect(result.task?.lifecycle?.currentStage).toBe('running');
  });

  it('does not make the model repair an incomplete strict map before starting', async () => {
    const { boardId, taskId } = await seedReadyTask({ strictGraph: 'empty' });
    const setCurrentKanbanTask = vi.fn();

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId,
        taskId,
        author: 'agent-1',
        transitionComment: 'Starting from the real card contract.',
      },
      { projectRoot: dir, setCurrentKanbanTask } as unknown as Context,
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    expect(result.task?.lifecycle?.currentStage).toBe('running');
  });

  it('restarts a Review card as a repair run instead of trapping continuation', async () => {
    const { boardId, taskId } = await seedReadyTask();
    const setCurrentKanbanTask = vi.fn();
    const ctx = {
      projectRoot: dir,
      agentId: 'agent-1',
      setCurrentKanbanTask,
    } as unknown as Context;

    await kanbanTool.execute(
      {
        action: 'start_task',
        boardId,
        taskId,
        author: 'agent-1',
        transitionComment: 'Starting implementation.',
      },
      ctx,
      { signal: newSignal() },
    );
    const completed = await kanbanTool.execute(
      {
        action: 'mark_assignment',
        boardId,
        taskId,
        assignmentStatus: 'completed',
        agentId: 'agent-1',
        lastResult: 'Implementation needs another verification pass.',
      },
      ctx,
      { signal: newSignal() },
    );
    expect(completed.task?.lifecycle?.currentStage).toBe('review');

    const restarted = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId,
        taskId,
        author: 'agent-1',
        transitionComment: 'Addressing review findings.',
      },
      ctx,
      { signal: newSignal() },
    );

    expect(restarted.ok, restarted.message).toBe(true);
    expect(restarted.task?.lifecycle?.currentStage).toBe('running');
    expect(restarted.task?.assignment?.status).toBe('running');
  });

  it('refuses to start a card whose required details and acceptance criteria are incomplete', async () => {
    const board = await createBoard(dir, { title: 'Incomplete' });
    const added = await addTask(dir, board.id, { title: 'Unsafe change' });
    const setCurrentKanbanTask = vi.fn();

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId: board.id,
        taskId: added!.task.id,
        author: 'agent-1',
        transitionComment: 'Start.',
      },
      { projectRoot: dir, setCurrentKanbanTask } as unknown as Context,
      { signal: newSignal() },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('not implementation-ready');
    expect(setCurrentKanbanTask).not.toHaveBeenCalled();
  });

  it('refuses a dependency-blocked card without leaving a running assignment behind', async () => {
    const { boardId, taskId } = await seedReadyTask();
    const dependency = await addTask(dir, boardId, {
      title: 'Required predecessor',
      description: 'Must finish before the implementation task.',
    });
    await updateTask(dir, boardId, taskId, { dependsOn: [dependency!.task.id] });
    const setCurrentKanbanTask = vi.fn();

    const result = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId,
        taskId,
        author: 'agent-1',
        transitionComment: 'Trying to start too early.',
      },
      { projectRoot: dir, setCurrentKanbanTask } as unknown as Context,
      { signal: newSignal() },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('every dependency');
    expect(setCurrentKanbanTask).not.toHaveBeenCalled();
    const persisted = await getBoard(dir, boardId);
    expect(persisted!.tasks.find((task) => task.id === taskId)?.assignment).toBeUndefined();
  });
});

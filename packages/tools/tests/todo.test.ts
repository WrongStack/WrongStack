import * as path from 'node:path';
import {
  loadPlan,
  loadTasks,
  type PlanFile,
  savePlan,
  saveTasks,
  type TaskFile,
} from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { todoTool } from '../src/todo.js';
import { mkSandbox, newSignal, type Sandbox } from './fixtures.js';

const now = '2026-06-15T00:00:00.000Z';
const mkPlan = (status: PlanFile['items'][number]['status']): PlanFile => ({
  version: 1,
  sessionId: 'test',
  updatedAt: now,
  items: [{ id: 'p1', title: 'Step one', status, createdAt: now, updatedAt: now }],
});
const mkTasks = (status: TaskFile['tasks'][number]['status']): TaskFile => ({
  version: 1,
  sessionId: 'test',
  updatedAt: now,
  tasks: [
    {
      id: 't1',
      title: 'Task one',
      type: 'feature',
      priority: 'medium',
      status,
      createdAt: now,
      updatedAt: now,
    },
  ],
});

describe('todo tool', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    process.env.WRONGSTACK_KANBAN_TASK_MIRROR = '0';
    sb = await mkSandbox();
  });
  afterEach(async () => {
    delete process.env.WRONGSTACK_KANBAN_TASK_MIRROR;
    await sb.cleanup();
  });

  it('replaces todo list', async () => {
    const out = await todoTool.execute(
      {
        todos: [
          { id: '1', content: 'a', status: 'pending' },
          { id: '2', content: 'b', status: 'in_progress' },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.count).toBe(2);
    expect(out.in_progress).toBe(1);
  });

  it('enforces single in_progress', async () => {
    const out = await todoTool.execute(
      {
        todos: [
          { id: '0', content: 'z', status: 'pending' }, // non-in_progress item in the dedup loop
          { id: '1', content: 'a', status: 'in_progress' },
          { id: '2', content: 'b', status: 'in_progress' },
          { id: '3', content: 'c', status: 'in_progress' },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.in_progress).toBe(1);
  });

  it('rejects a non-array todos input', async () => {
    await expect(
      todoTool.execute({ todos: undefined as never }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/must be an array/);
  });

  it('marks a plan item done when all its promoted todos complete', async () => {
    const planPath = path.join(sb.dir, 'plan.json');
    await savePlan(planPath, mkPlan('open'));
    (sb.ctx.meta as Record<string, unknown>)['plan.path'] = planPath;

    await todoTool.execute(
      { todos: [{ id: 'a', content: 'do', status: 'completed', promotedFromPlan: 'p1' }] },
      sb.ctx,
      { signal: newSignal() },
    );

    const plan = await loadPlan(planPath);
    expect(plan?.items[0]?.status).toBe('done');
  });

  it('leaves a plan item open when some promoted todos are still pending', async () => {
    const planPath = path.join(sb.dir, 'plan.json');
    await savePlan(planPath, mkPlan('open'));
    (sb.ctx.meta as Record<string, unknown>)['plan.path'] = planPath;

    await todoTool.execute(
      {
        todos: [
          { id: 'a', content: 'do', status: 'completed', promotedFromPlan: 'p1' },
          { id: 'b', content: 'more', status: 'pending', promotedFromPlan: 'p1' },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const plan = await loadPlan(planPath);
    expect(plan?.items[0]?.status).toBe('open');
  });

  it('ignores plan completion when no plan.path is configured', async () => {
    // No meta['plan.path'] → the completed-plan loop hits the `continue` guard.
    const out = await todoTool.execute(
      { todos: [{ id: 'a', content: 'do', status: 'completed', promotedFromPlan: 'p1' }] },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.count).toBe(1);
  });

  it('tolerates a missing plan file (loadPlan returns null)', async () => {
    (sb.ctx.meta as Record<string, unknown>)['plan.path'] = path.join(sb.dir, 'absent.json');
    const out = await todoTool.execute(
      { todos: [{ id: 'a', content: 'do', status: 'completed', promotedFromPlan: 'p1' }] },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.count).toBe(1);
  });

  it('marks a task completed when all its promoted todos complete', async () => {
    const taskPath = path.join(sb.dir, 'tasks.json');
    await saveTasks(taskPath, mkTasks('pending'));
    (sb.ctx.meta as Record<string, unknown>)['task.path'] = taskPath;

    await todoTool.execute(
      { todos: [{ id: 'a', content: 'do', status: 'completed', promotedFromTask: 't1' }] },
      sb.ctx,
      { signal: newSignal() },
    );

    const file = await loadTasks(taskPath);
    expect(file?.tasks[0]?.status).toBe('completed');
  });

  it('leaves a task when some promoted todos are still pending', async () => {
    const taskPath = path.join(sb.dir, 'tasks.json');
    await saveTasks(taskPath, mkTasks('pending'));
    (sb.ctx.meta as Record<string, unknown>)['task.path'] = taskPath;

    await todoTool.execute(
      {
        todos: [
          { id: 'a', content: 'do', status: 'completed', promotedFromTask: 't1' },
          { id: 'b', content: 'more', status: 'pending', promotedFromTask: 't1' },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const file = await loadTasks(taskPath);
    expect(file?.tasks[0]?.status).toBe('pending');
  });

  it('does not re-save a task that is already completed', async () => {
    const taskPath = path.join(sb.dir, 'tasks.json');
    await saveTasks(taskPath, mkTasks('completed'));
    (sb.ctx.meta as Record<string, unknown>)['task.path'] = taskPath;

    const out = await todoTool.execute(
      { todos: [{ id: 'a', content: 'do', status: 'completed', promotedFromTask: 't1' }] },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.count).toBe(1);
    const file = await loadTasks(taskPath);
    expect(file?.tasks[0]?.status).toBe('completed');
  });

  it('ignores task completion when no task.path is configured', async () => {
    const out = await todoTool.execute(
      { todos: [{ id: 'a', content: 'do', status: 'completed', promotedFromTask: 't1' }] },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.count).toBe(1);
  });

  it('tolerates a missing task file (loadTasks returns null)', async () => {
    (sb.ctx.meta as Record<string, unknown>)['task.path'] = path.join(sb.dir, 'absent-tasks.json');
    const out = await todoTool.execute(
      { todos: [{ id: 'a', content: 'do', status: 'completed', promotedFromTask: 't1' }] },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.count).toBe(1);
  });

  it('mirrors todo status through Todo, Running, Preview, and Done session columns', async () => {
    delete process.env.WRONGSTACK_KANBAN_TASK_MIRROR;
    const { projectSessionTodosToKanban } = await import('../src/session-kanban.js');

    let board = await projectSessionTodosToKanban(
      sb.dir,
      [
        { id: 'todo-1', content: 'Inspect', status: 'pending' },
        { id: 'todo-2', content: 'Implement', status: 'in_progress' },
        { id: 'todo-3', content: 'Ship', status: 'completed' },
      ],
      'sess',
    );

    expect(board?.tags).toContain('session:sess');
    expect(board?.columns.map((column) => column.title)).toEqual([
      'Todo',
      'Running',
      'Preview',
      'Done',
    ]);
    expect(board?.tasks.find((task) => task.origin?.taskId === 'todo-1')?.columnId).toBe('todo');
    expect(board?.tasks.find((task) => task.origin?.taskId === 'todo-2')?.columnId).toBe(
      'in-progress',
    );
    expect(board?.tasks.find((task) => task.origin?.taskId === 'todo-3')?.columnId).toBe('done');

    board = await projectSessionTodosToKanban(
      sb.dir,
      [{ id: 'todo-1', content: 'Inspect', status: 'completed' }],
      'sess',
    );
    expect(board?.tasks.find((task) => task.origin?.taskId === 'todo-1')?.columnId).toBe('done');
  });
});

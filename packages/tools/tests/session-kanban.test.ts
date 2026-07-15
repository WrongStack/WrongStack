import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type Context,
  loadPlan,
  loadTasks,
  savePlan,
  saveTasks,
  type TodoItem,
} from '@wrongstack/core';
import { createBoard, getBoard, listBoards, moveTask } from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySessionKanbanTaskToSource,
  attachSessionKanbanMirror,
  cleanupEmptySessionKanbanBoards,
  cleanupSessionKanbanBoardIfEmpty,
  ensureSessionKanbanBoard,
  projectSessionPlanToKanban,
  projectSessionTasksToKanban,
  projectSessionTodosToKanban,
} from '../src/session-kanban.js';

describe('unified session kanban', () => {
  let dir: string;

  beforeEach(async () => {
    delete process.env.WRONGSTACK_KANBAN_TASK_MIRROR;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-session-kanban-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps todo, task, and plan cards on one session board', async () => {
    await projectSessionTodosToKanban(
      dir,
      [{ id: 'todo-1', content: 'Tactical work', status: 'in_progress' }],
      'sess',
    );
    await projectSessionTasksToKanban(
      dir,
      [
        {
          id: 'task-1',
          title: 'Structured work',
          type: 'feature',
          priority: 'high',
          status: 'review',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      'sess',
    );
    const board = await projectSessionPlanToKanban(
      dir,
      [
        {
          id: 'plan-1',
          title: 'Strategic work',
          status: 'done',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      'sess',
    );

    expect(await listBoards(dir)).toHaveLength(1);
    expect(board?.tasks).toHaveLength(3);
    expect(board?.tasks.find((task) => task.origin?.taskId === 'todo-1')?.columnId).toBe(
      'in-progress',
    );
    expect(board?.tasks.find((task) => task.origin?.taskId === 'task-1')?.columnId).toBe('review');
    expect(board?.tasks.find((task) => task.origin?.taskId === 'plan-1')?.columnId).toBe('done');
  });

  it('projects a final completed todo into Done instead of leaving it in Todo', async () => {
    const board = await projectSessionTodosToKanban(
      dir,
      [{ id: 'todo-final', content: 'Finish everything', status: 'completed' }],
      'sess-done',
    );

    const card = board?.tasks.find((task) => task.origin?.taskId === 'todo-final');
    expect(card?.status).toBe('completed');
    expect(card?.columnId).toBe('done');
  });

  it('cleans only inactive, empty, system-owned session boards', async () => {
    const stale = await ensureSessionKanbanBoard(dir, 'stale-session');
    const active = await ensureSessionKanbanBoard(dir, 'active-session');
    const manual = await createBoard(dir, { title: 'Manual empty board' });
    const populated = await projectSessionTodosToKanban(
      dir,
      [{ id: 'todo-keep', content: 'Keep this board', status: 'pending' }],
      'populated-session',
    );

    const removed = await cleanupEmptySessionKanbanBoards(dir, 'active-session');
    const remainingIds = new Set((await listBoards(dir)).map((board) => board.id));

    expect(removed).toEqual([stale?.id]);
    expect(remainingIds.has(stale!.id)).toBe(false);
    expect(remainingIds.has(active!.id)).toBe(true);
    expect(remainingIds.has(manual.id)).toBe(true);
    expect(remainingIds.has(populated!.id)).toBe(true);
  });

  it('keeps an attached session board until that session detaches', async () => {
    const board = await ensureSessionKanbanBoard(dir, 'live-session');
    const context = {
      projectRoot: dir,
      session: { id: 'live-session' },
      meta: {},
      state: { onChange: () => () => undefined },
    } as never as Context;
    const detach = attachSessionKanbanMirror(context);

    expect(await cleanupSessionKanbanBoardIfEmpty(dir, 'live-session')).toEqual([]);
    expect(await getBoard(dir, board!.id)).not.toBeNull();

    detach();
    await cleanupSessionKanbanBoardIfEmpty(dir, 'live-session');
    expect(await getBoard(dir, board!.id)).toBeNull();
  });

  it('writes Kanban moves back to todo, task, and plan sources', async () => {
    const taskPath = path.join(dir, 'sess.tasks.json');
    const planPath = path.join(dir, 'sess.plan.json');
    const now = new Date().toISOString();
    await saveTasks(taskPath, {
      version: 1,
      sessionId: 'sess',
      updatedAt: now,
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          type: 'feature',
          priority: 'medium',
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    await savePlan(planPath, {
      version: 1,
      sessionId: 'sess',
      updatedAt: now,
      items: [{ id: 'plan-1', title: 'Plan', status: 'open', createdAt: now, updatedAt: now }],
    });

    const todos: TodoItem[] = [{ id: 'todo-1', content: 'Todo', status: 'pending' }];
    const context = {
      projectRoot: dir,
      todos,
      meta: { 'task.path': taskPath, 'plan.path': planPath },
      session: { id: 'sess' },
      state: {
        replaceTodos(next: TodoItem[]) {
          todos.splice(0, todos.length, ...next);
        },
      },
    } as never as Context;

    await projectSessionTodosToKanban(dir, todos, 'sess');
    await projectSessionTasksToKanban(dir, (await loadTasks(taskPath))?.tasks ?? [], 'sess');
    let board = await projectSessionPlanToKanban(
      dir,
      (await loadPlan(planPath))?.items ?? [],
      'sess',
    );
    expect(board).not.toBeNull();

    const todoCard = board?.tasks.find((task) => task.origin?.taskId === 'todo-1');
    const taskCard = board?.tasks.find((task) => task.origin?.taskId === 'task-1');
    const planCard = board?.tasks.find((task) => task.origin?.taskId === 'plan-1');
    expect(todoCard && taskCard && planCard).toBeTruthy();

    board = todoCard ? await moveTask(dir, board!.id, todoCard.id, 'review') : board;
    const movedTodo = board?.tasks.find((task) => task.id === todoCard?.id);
    if (movedTodo) await applySessionKanbanTaskToSource(context, movedTodo);
    expect(todos[0]?.status).toBe('in_progress');
    expect(movedTodo?.columnId).toBe('review');

    board = taskCard ? await moveTask(dir, board!.id, taskCard.id, 'done') : board;
    const movedTask = board?.tasks.find((task) => task.id === taskCard?.id);
    if (movedTask) await applySessionKanbanTaskToSource(context, movedTask);
    expect((await loadTasks(taskPath))?.tasks[0]?.status).toBe('completed');

    board = planCard ? await moveTask(dir, board!.id, planCard.id, 'in-progress') : board;
    const movedPlan = board?.tasks.find((task) => task.id === planCard?.id);
    if (movedPlan) await applySessionKanbanTaskToSource(context, movedPlan);
    expect((await loadPlan(planPath))?.items[0]?.status).toBe('in_progress');

    expect((await getBoard(dir, board!.id))?.columns.map((column) => column.title)).toEqual([
      'Todo',
      'Running',
      'Preview',
      'Done',
    ]);
  });
});

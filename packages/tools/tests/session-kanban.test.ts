import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context, TodoItem } from '@wrongstack/core/agent';
import { loadPlan, loadTasks, savePlan, saveTasks } from '@wrongstack/core/storage';
import { addTask, createBoard, getBoard, listBoards, moveTask } from '@wrongstack/kanban';
import { getKanbanPath } from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySessionKanbanBoardToTodos,
  applySessionKanbanTaskToSource,
  attachSessionKanbanMirror,
  cleanupEmptySessionKanbanBoards,
  cleanupSessionKanbanBoardIfEmpty,
  ensureSessionKanbanBoard,
  mirrorSessionTodosToKanban,
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

  it('coalesces a burst of observational todo mirrors to the latest pending state', async () => {
    const board = await ensureSessionKanbanBoard(dir, 'burst-session');
    const boardPath = getKanbanPath(dir, board!.id);
    const lockPath = path.join(path.dirname(boardPath), `.${path.basename(boardPath)}.lock`);
    const lock = await fs.open(lockPath, 'wx');
    await lock.writeFile(`${process.pid}:${Date.now()}`);

    for (let index = 0; index < 250; index++) {
      mirrorSessionTodosToKanban(
        dir,
        [{ id: 'burst', content: `state-${index}`, status: 'pending' }],
        'burst-session',
      );
    }

    await lock.close();
    await fs.unlink(lockPath);

    let current = await getBoard(dir, board!.id);
    const deadline = Date.now() + 5_000;
    while (
      current?.tasks.find((task) => task.origin?.taskId === 'burst')?.title !== 'state-249' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      current = await getBoard(dir, board!.id);
    }

    expect(current?.tasks.find((task) => task.origin?.taskId === 'burst')?.title).toBe('state-249');
    expect(current?.revision).toBeLessThanOrEqual((board?.revision ?? 0) + 2);
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

  it('replaces session todos when an agent reassesses and changes the board', async () => {
    const todos: TodoItem[] = [{ id: 'initial', content: 'Initial work', status: 'pending' }];
    const context = {
      projectRoot: dir,
      todos,
      meta: {},
      session: { id: 'dynamic-session' },
      state: {
        replaceTodos(next: TodoItem[]) {
          todos.splice(0, todos.length, ...next);
        },
      },
    } as never as Context;
    let board = await projectSessionTodosToKanban(dir, todos, 'dynamic-session');
    expect(board).not.toBeNull();

    const added = await addTask(dir, board!.id, {
      title: 'New evidence-driven work',
      description: 'Handling the new evidence',
      columnId: 'in-progress',
      status: 'in_progress',
    });
    board = added?.board ?? board;
    const initialCard = board?.tasks.find((task) => task.origin?.taskId === 'initial');
    if (initialCard) {
      board = (await moveTask(dir, board!.id, initialCard.id, 'done')) ?? board;
    }

    const next = applySessionKanbanBoardToTodos(context, board!);

    expect(next).toEqual([
      expect.objectContaining({
        id: added?.task.id,
        content: 'New evidence-driven work',
        activeForm: 'Handling the new evidence',
        status: 'in_progress',
      }),
      expect.objectContaining({ id: 'initial', content: 'Initial work', status: 'completed' }),
    ]);
    expect(todos).toEqual(next);

    const remirrored = await projectSessionTodosToKanban(dir, next, 'dynamic-session');
    expect(
      remirrored?.tasks.filter((task) => task.title === 'New evidence-driven work'),
    ).toHaveLength(1);
    expect(remirrored?.tasks.find((task) => task.id === added?.task.id)?.origin).toMatchObject({
      system: 'session-todo',
      taskId: added?.task.id,
    });
  });

  it('deduplicates an already-cleared all-completed board snapshot', async () => {
    const board = await projectSessionTodosToKanban(
      dir,
      [{ id: 'done', content: 'Done work', status: 'completed' }],
      'completed-session',
    );
    let replacements = 0;
    const context = {
      projectRoot: dir,
      todos: [],
      meta: {},
      session: { id: 'completed-session' },
      state: {
        replaceTodos() {
          replacements++;
        },
      },
    } as never as Context;

    expect(applySessionKanbanBoardToTodos(context, board!)).toEqual([]);
    expect(replacements).toBe(0);
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

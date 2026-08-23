import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context, TodoItem } from '@wrongstack/core/agent';
import { loadPlan, loadTasks, savePlan, saveTasks } from '@wrongstack/core/storage';
import {
  addDependency,
  addTask,
  compactSessionMirrorBoard,
  createBoard,
  getBoard,
  listBoards,
  moveTask,
  updateTask,
  type KanbanTask,
} from '@wrongstack/kanban';
import { getKanbanPath } from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySessionKanbanBoardToTodos,
  applySessionKanbanTaskToSource,
  attachSessionKanbanMirror,
  blockingTitles,
  cleanupEmptySessionKanbanBoards,
  cleanupSessionKanbanBoard,
  cleanupSessionKanbanBoardIfEmpty,
  ensureSessionKanbanBoard,
  hydrateSessionKanban,
  mirrorSessionTodosToKanban,
  orderTasksForTodos,
  planFileToSerializedGraph,
  projectSessionPlanToKanban,
  projectSessionTasksToKanban,
  projectSessionTodosToKanban,
  takeSessionMirrorFailure,
  taskFileToSerializedGraph,
  todoListToSerializedGraph,
  todosNeedingSessionMirror,
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
    expect(board?.tasks.every((task) => Boolean(task.origin?.specRequirementId))).toBe(true);
    expect(board?.requirementScopes).toHaveLength(3);
  });

  it('namespaces requirement scope for each session projection source', () => {
    const todoGraph = todoListToSerializedGraph(
      [{ id: 'same', content: 'Todo', status: 'pending' }],
      'scope-session',
    );
    const taskGraph = taskFileToSerializedGraph(
      [
        {
          id: 'same',
          title: 'Task',
          type: 'feature',
          priority: 'high',
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      'scope-session',
    );
    const planGraph = planFileToSerializedGraph(
      [
        {
          id: 'same',
          title: 'Plan',
          status: 'open',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      'scope-session',
    );

    expect(todoGraph.requiredRequirementIds).toEqual(['todo:scope-session:same']);
    expect(taskGraph.requiredRequirementIds).toEqual(['session:scope-session:same']);
    expect(planGraph.requiredRequirementIds).toEqual(['plan:scope-session:same']);
  });

  it('retains omitted work as an archived card instead of refusing the sync', async () => {
    await projectSessionTodosToKanban(
      dir,
      [
        { id: 'keep', content: 'Keep', status: 'pending' },
        { id: 'omitted', content: 'Dropped from the list', status: 'pending' },
      ],
      'shrink-session',
    );

    const shrunk = await projectSessionTodosToKanban(
      dir,
      [{ id: 'keep', content: 'Keep', status: 'pending' }],
      'shrink-session',
    );

    // The protection that matters is retention of the card, not refusal of the
    // projection: the omitted row survives as an archived card, so the work is
    // still on the board and recoverable.
    expect(shrunk?.tasks.find((task) => task.origin?.taskId === 'omitted')?.status).toBe(
      'archived',
    );
    // The ledger stays declared, and now tracks the current snapshot.
    expect(shrunk?.requirementScopes).toHaveLength(1);
    expect(shrunk?.requiredRequirementIds).toEqual(['todo:shrink-session:keep']);

    // A later, independent update must still land. The defect was that one
    // shrink froze the stored scope and every later projection failed on it.
    const after = await projectSessionTodosToKanban(
      dir,
      [
        { id: 'keep', content: 'Keep', status: 'completed' },
        { id: 'fresh', content: 'Added later', status: 'pending' },
      ],
      'shrink-session',
    );
    expect(after?.tasks.find((task) => task.origin?.taskId === 'keep')?.status).toBe('completed');
    expect(after?.tasks.find((task) => task.origin?.taskId === 'fresh')).toBeTruthy();
  });

  it('records no mirror failure when a background todo mirror keeps shrinking', async () => {
    // Reproduces the reported `session-kanban.mirror-failed` warning, which
    // arrived from the fire-and-forget queue rather than a direct projection:
    // an unfinished row (here `f8-test-typecheck`) leaves the list, and every
    // later mirror for that session used to fail against the recorded scope.
    const rows: TodoItem[] = [
      { id: 'f8-test-typecheck', content: 'Run typecheck', status: 'pending' },
      { id: 'f9-ship', content: 'Ship it', status: 'pending' },
    ];
    await projectSessionTodosToKanban(dir, rows, 'mirror-shrink');
    mirrorSessionTodosToKanban(dir, [rows[1]!], 'mirror-shrink');
    mirrorSessionTodosToKanban(
      dir,
      [{ id: 'f9-ship', content: 'Ship it', status: 'completed' }],
      'mirror-shrink',
    );

    const board = await ensureSessionKanbanBoard(dir, 'mirror-shrink');
    const deadline = Date.now() + 5_000;
    let current = await getBoard(dir, board!.id);
    while (
      current?.tasks.find((task) => task.origin?.taskId === 'f9-ship')?.status !== 'completed' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      current = await getBoard(dir, board!.id);
    }

    expect(current?.tasks.find((task) => task.origin?.taskId === 'f9-ship')?.status).toBe(
      'completed',
    );
    // The failure channel still exists and still reports real breakage — it
    // simply has nothing to report for an ordinary shrink.
    expect(takeSessionMirrorFailure(dir, 'mirror-shrink')).toBeUndefined();
  });

  it('recovers a board already wedged by a stale requirement scope', async () => {
    const board = await projectSessionTodosToKanban(
      dir,
      [{ id: 'keep', content: 'Keep', status: 'pending' }],
      'stale-scope',
    );
    const boardId = board?.id ?? '';
    const kanbanPath = getKanbanPath(dir, boardId);
    const raw = JSON.parse(await fs.readFile(kanbanPath, 'utf8')) as Record<string, unknown>;
    raw['requirementScopes'] = [
      {
        graphId: 'todo:stale-scope',
        specId: 'todo:stale-scope',
        sourceSystem: 'session-todo',
        requirementIds: ['todo:stale-scope:keep', 'todo:stale-scope:vanished'],
        updatedAt: new Date().toISOString(),
      },
    ];
    raw['requiredRequirementIds'] = ['todo:stale-scope:keep', 'todo:stale-scope:vanished'];
    await fs.writeFile(kanbanPath, JSON.stringify(raw), 'utf8');

    const resynced = await projectSessionTodosToKanban(
      dir,
      [{ id: 'keep', content: 'Keep', status: 'completed' }],
      'stale-scope',
    );

    // A scope entry that outlived its declaration used to fail every later
    // projection for the whole session. It is now re-stated from the live
    // snapshot, so the board heals on the next update instead of staying frozen.
    expect(resynced?.requiredRequirementIds).toEqual(['todo:stale-scope:keep']);
    expect(resynced?.tasks.find((task) => task.origin?.taskId === 'keep')?.status).toBe(
      'completed',
    );
  });

  it('enforces board retention on session start', async () => {
    // Every session mirror is created with a 7-day `archive_after_ttl` policy,
    // but nothing in production ever ran the sweep, so expired boards piled up
    // forever. Session start is the shared entry point that now triggers it.
    const stale = await ensureSessionKanbanBoard(dir, 'expired-session');
    // An *empty* stale board is already removed outright by the pre-existing
    // cleanup pass, so retention only ever governs boards that still hold
    // cards. Give it one so this exercises the sweep and not the cleanup.
    await addTask(dir, stale!.id, { title: 'Finished long ago' });
    const stalePath = getKanbanPath(dir, stale!.id);
    const raw = JSON.parse(await fs.readFile(stalePath, 'utf8')) as Record<string, unknown>;
    raw['updatedAt'] = '2020-01-01T00:00:00.000Z';
    await fs.writeFile(stalePath, JSON.stringify(raw), 'utf8');

    const context = {
      projectRoot: dir,
      todos: [],
      meta: {},
      session: { id: 'fresh-session' },
      state: { onChange: () => () => undefined, replaceTodos: () => undefined },
    } as never as Context;
    await hydrateSessionKanban(context);

    // The sweep is detached so it cannot delay the session becoming ready.
    const deadline = Date.now() + 5_000;
    let swept = await getBoard(dir, stale!.id);
    while (swept?.kind !== 'archive' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      swept = await getBoard(dir, stale!.id);
    }
    expect(swept?.kind).toBe('archive');
    expect(swept?.retention?.archivedAt).toBeTruthy();

    // The live session's own board is untouched — retention is about age, and
    // archiving the board a session just created would be self-defeating.
    const live = (await listBoards(dir)).find((candidate) =>
      candidate.tags?.includes('session:fresh-session'),
    );
    expect(live).toBeTruthy();
    expect((await getBoard(dir, live!.id))?.kind).toBe('session_mirror');
  });

  it('orders projected work by dependency and priority, not creation time', async () => {
    const board = await createBoard(dir, {
      title: 'Ordering',
      columns: [{ id: 'todo', title: 'Todo', order: 0, wipLimit: 0 }],
    });
    // Created first, but depends on the card created last.
    const last = await addTask(dir, board.id, { title: 'Ship', priority: 'critical' });
    const first = await addTask(dir, board.id, { title: 'Build', priority: 'low' });
    const middle = await addTask(dir, board.id, { title: 'Test', priority: 'medium' });
    await addDependency(dir, board.id, last!.task.id, first!.task.id);
    await addDependency(dir, board.id, middle!.task.id, first!.task.id);

    const current = await getBoard(dir, board.id);
    const ordered = orderTasksForTodos(current!, current!.tasks).map((task) => task.title);

    // Build has no dependencies so it leads despite being 'low' and created
    // second; Ship and Test only become available afterwards, and among them
    // 'critical' outranks 'medium'.
    expect(ordered).toEqual(['Build', 'Ship', 'Test']);
  });

  it('carries the blocking reason onto the projected todo row', async () => {
    const board = await createBoard(dir, {
      title: 'Blocking',
      columns: [{ id: 'todo', title: 'Todo', order: 0, wipLimit: 0 }],
    });
    const blocker = await addTask(dir, board.id, { title: 'Migrate schema' });
    const blocked = await addTask(dir, board.id, { title: 'Backfill rows' });
    await addDependency(dir, board.id, blocked!.task.id, blocker!.task.id);

    const current = await getBoard(dir, board.id);
    const target = current!.tasks.find((task) => task.id === blocked!.task.id);
    expect(blockingTitles(current!, target!)).toEqual(['Migrate schema']);

    // An unblocked card reports nothing, so the field never adds noise.
    const leader = current!.tasks.find((task) => task.id === blocker!.task.id);
    expect(blockingTitles(current!, leader!)).toEqual([]);
  });

  it('bounds terminal cards on a live session mirror without dropping open work', async () => {
    const board = await ensureSessionKanbanBoard(dir, 'growth-session');
    for (let index = 0; index < 12; index++) {
      const created = await addTask(dir, board!.id, { title: `Old ${index}` });
      await updateTask(dir, board!.id, created!.task.id, { status: 'completed' });
    }
    const open = await addTask(dir, board!.id, { title: 'Still open' });

    const result = await compactSessionMirrorBoard(dir, board!.id, { limit: 5 });
    expect(result?.removedTaskIds).toHaveLength(7);

    const after = await getBoard(dir, board!.id);
    // Open work always survives, and exactly the retention window of terminal
    // cards remains.
    expect(after?.tasks.find((task) => task.id === open!.task.id)).toBeTruthy();
    expect(after?.tasks.filter((task) => task.status === 'completed')).toHaveLength(5);
  });

  it('never compacts a durable project board', async () => {
    const board = await createBoard(dir, { title: 'Durable project work' });
    for (let index = 0; index < 6; index++) {
      const created = await addTask(dir, board.id, { title: `Done ${index}` });
      await updateTask(dir, board.id, created!.task.id, { status: 'completed' });
    }

    const result = await compactSessionMirrorBoard(dir, board.id, { limit: 1 });
    expect(result?.removedTaskIds ?? []).toHaveLength(0);
    expect((await getBoard(dir, board.id))?.tasks).toHaveLength(6);
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

  it('retains a skipped completion snapshot before removing the resolved requirement', async () => {
    const sessionId = 'resolved-coalescing-session';
    const board = await projectSessionTodosToKanban(
      dir,
      [
        { id: 'keep', content: 'Keep working', status: 'pending' },
        { id: 'f8-test-typecheck', content: 'Run verification', status: 'pending' },
      ],
      sessionId,
    );
    const boardPath = getKanbanPath(dir, board!.id);
    const lockPath = path.join(path.dirname(boardPath), `.${path.basename(boardPath)}.lock`);
    const lock = await fs.open(lockPath, 'wx');
    await lock.writeFile(`${process.pid}:${Date.now()}`);

    mirrorSessionTodosToKanban(
      dir,
      [
        { id: 'keep', content: 'Keep working', status: 'pending' },
        { id: 'f8-test-typecheck', content: 'Run verification', status: 'pending' },
      ],
      sessionId,
    );
    mirrorSessionTodosToKanban(
      dir,
      [
        { id: 'keep', content: 'Keep working', status: 'in_progress' },
        { id: 'f8-test-typecheck', content: 'Run verification', status: 'completed' },
      ],
      sessionId,
    );
    mirrorSessionTodosToKanban(
      dir,
      [{ id: 'keep', content: 'Keep working', status: 'in_progress' }],
      sessionId,
    );

    await lock.close();
    await fs.unlink(lockPath);

    let current = await getBoard(dir, board!.id);
    const deadline = Date.now() + 5_000;
    while (
      current?.tasks.find((task) => task.origin?.taskId === 'f8-test-typecheck')?.status !==
        'archived' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      current = await getBoard(dir, board!.id);
    }

    expect(current?.tasks.find((task) => task.origin?.taskId === 'f8-test-typecheck')?.status).toBe(
      'archived',
    );
    expect(
      current?.requirementScopes?.find((scope) => scope.graphId === `todo:${sessionId}`),
    ).not.toEqual(
      expect.objectContaining({
        requirementIds: expect.arrayContaining([`todo:${sessionId}:f8-test-typecheck`]),
      }),
    );
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

  it('keeps an attached session board until detach, then removes the populated mirror', async () => {
    const board = await projectSessionTodosToKanban(
      dir,
      [{ id: 'todo-1', content: 'Tactical work', status: 'completed' }],
      'live-session',
    );
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
    await cleanupSessionKanbanBoard(dir, 'live-session');
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

    // Session boards now use the 5 standard columns (backlog, todo, in-progress,
    // review, done) like every other board — formerly they used a 4-column
    // variant (Todo/Running/Preview/Done) without a backlog.
    expect((await getBoard(dir, board!.id))?.columns.map((column) => column.title)).toEqual([
      'Backlog',
      'To Do',
      'In Progress',
      'Review',
      'Done',
    ]);
  });
});

describe('applySessionKanbanTaskToSource — missing source path', () => {
  // A card whose origin is session-task/session-plan but whose session has
  // no task.path/plan.path configured used to silently return a sourceless
  // `{ source: 'task'/'plan' }`, hiding that the board mutation had no place
  // to write back to. These tests pin the new throw so callers surface the
  // divergence instead of reporting silent success.
  function makeCard(
    originSystem: 'session-task' | 'session-plan',
    originTaskId: string,
  ): KanbanTask {
    return {
      id: 'card-1',
      title: 'Reflected card',
      columnId: 'done',
      order: 0,
      priority: 'medium',
      status: 'completed',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
      origin: { system: originSystem, taskId: originTaskId, graphId: `session:${originTaskId}` },
    } as KanbanTask;
  }

  it('throws when a session-task card is reflected with no task.path configured', async () => {
    const context = {
      projectRoot: '/tmp/project',
      todos: [],
      meta: {},
      session: { id: 'sess' },
      state: { replaceTodos() {} },
    } as never as Context;
    const card = makeCard('session-task', 'task-1');
    await expect(applySessionKanbanTaskToSource(context, card)).rejects.toThrow(
      /task\.path.*out of sync/i,
    );
  });

  it('throws when a session-plan card is reflected with no plan.path configured', async () => {
    const context = {
      projectRoot: '/tmp/project',
      todos: [],
      meta: {},
      session: { id: 'sess' },
      state: { replaceTodos() {} },
    } as never as Context;
    const card = makeCard('session-plan', 'plan-1');
    await expect(applySessionKanbanTaskToSource(context, card)).rejects.toThrow(
      /plan\.path.*out of sync/i,
    );
  });
});

describe('todosNeedingSessionMirror', () => {
  const bound = (id: string, boardId: string): TodoItem =>
    ({
      id,
      content: id,
      status: 'pending',
      kanbanBoardId: boardId,
      kanbanTaskId: `card-${id}`,
    }) as TodoItem;
  const loose = (id: string): TodoItem => ({ id, content: id, status: 'pending' }) as TodoItem;

  it('mirrors nothing when every row is already a card on the active board', () => {
    const todos = [bound('a', 'board-1'), bound('b', 'board-1')];
    expect(todosNeedingSessionMirror(todos, 'board-1')).toEqual([]);
  });

  it('mirrors only the unbound row, not the whole list', () => {
    // The regression: one stray row used to send every row to a separate
    // session board, duplicating work already tracked on the real board.
    const todos = [bound('a', 'board-1'), loose('b'), bound('c', 'board-1')];
    expect(todosNeedingSessionMirror(todos, 'board-1').map((t) => t.id)).toEqual(['b']);
  });

  it('treats a row bound to a different board as still needing the mirror', () => {
    const todos = [bound('a', 'other-board')];
    expect(todosNeedingSessionMirror(todos, 'board-1').map((t) => t.id)).toEqual(['a']);
  });

  it('mirrors everything when no board is active', () => {
    const todos = [bound('a', 'board-1'), loose('b')];
    expect(todosNeedingSessionMirror(todos, undefined)).toEqual(todos);
    expect(todosNeedingSessionMirror(todos, '')).toEqual(todos);
  });

  it('matches and updates todo status by kanbanTaskId when origin is not set', async () => {
    const todos: TodoItem[] = [
      { id: 'todo-1', content: 'Do something', status: 'pending', kanbanTaskId: 'task-xyz' },
    ];
    const context = {
      todos,
      state: {
        replaceTodos(next: TodoItem[]) {
          todos.length = 0;
          todos.push(...next);
        },
      },
      session: { id: 'sess-1' },
      meta: {},
    } as unknown as Context;

    const kanbanTask = {
      id: 'task-xyz',
      title: 'Do something updated',
      status: 'completed',
      columnId: 'done',
    } as unknown as import('@wrongstack/kanban').KanbanTask;

    const result = await applySessionKanbanTaskToSource(context, kanbanTask);
    expect(result.source).toBe('todo');
    expect(todos[0]?.status).toBe('completed');
    expect(todos[0]?.content).toBe('Do something updated');
  });
});


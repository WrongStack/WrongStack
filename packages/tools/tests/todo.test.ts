import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  loadPlan,
  loadTasks,
  type PlanFile,
  savePlan,
  saveTasks,
  type TaskFile,
} from '@wrongstack/core/storage';
import { createBoard, getBoard } from '@wrongstack/kanban';
import {
  addCheckToTask,
  addGoalMetricToTask,
  addTask,
  configureContractGraph,
  splitTask,
  updateGoalMetricOnTask,
  updateTask,
  upsertContractNode,
} from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { planTool } from '../src/plan.js';
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

  it('retains unfinished rows omitted by a later replacement', async () => {
    await todoTool.execute(
      {
        todos: [
          { id: 'keep', content: 'Must remain', status: 'pending' },
          { id: 'active', content: 'Active work', status: 'in_progress' },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const out = await todoTool.execute({ todos: [] }, sb.ctx, { signal: newSignal() });

    expect(out.count).toBe(2);
    expect(sb.ctx.todos?.map((item) => item.id).sort()).toEqual(['active', 'keep']);
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

  it('rolls a completed project-scoped promotion up to the backlog plan file', async () => {
    // Regression: the rollup used to read only the seeded session
    // meta['plan.path'], while scope:'project' writes to the derived
    // backlog.plan.json — so project-scoped plan items were never marked done.
    // plan.ts now records the RESOLVED path in meta['plan.path.resolved'].
    const sessionPlanPath = path.join(sb.dir, 'sess.plan.json');
    const meta = sb.ctx.meta as Record<string, unknown>;
    meta['plan.path'] = sessionPlanPath;
    meta['task.path'] = path.join(sb.dir, 'sess.tasks.json');

    await planTool.execute({ action: 'add', title: 'Ship feature', scope: 'project' }, sb.ctx, {
      signal: newSignal(),
    });
    const promoted = await planTool.execute(
      { action: 'promote', target: 'Ship feature', scope: 'project' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(promoted.ok).toBe(true);

    const backlogPath = path.join(sb.dir, 'backlog.plan.json');
    const backlog = await loadPlan(backlogPath);
    expect(backlog?.items[0]?.title).toBe('Ship feature');
    // The session-scoped file must not have absorbed the project item.
    expect((await loadPlan(sessionPlanPath))?.items ?? []).toHaveLength(0);

    // Complete every promoted todo → the rollup must follow the backlog file.
    const completed = (sb.ctx.todos ?? []).map((t) => ({
      ...t,
      status: 'completed' as const,
    }));
    expect(completed.length).toBeGreaterThan(0);
    await todoTool.execute({ todos: completed }, sb.ctx, { signal: newSignal() });

    expect((await loadPlan(backlogPath))?.items[0]?.status).toBe('done');
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
    // Session boards now use the 5 standard columns like every other board.
    expect(board?.columns.map((column) => column.title)).toEqual([
      'Backlog',
      'To Do',
      'In Progress',
      'Review',
      'Done',
    ]);
    // Session boards now have 5 columns (with backlog). A pending task lands in
    // backlog (formerly it landed in todo because the session layout had no
    // backlog). An in_progress task lands in in-progress.
    expect(board?.tasks.find((task) => task.origin?.taskId === 'todo-1')?.columnId).toBe('backlog');
    expect(board?.tasks.find((task) => task.origin?.taskId === 'todo-2')?.columnId).toBe(
      'in-progress',
    );
    expect(board?.tasks.find((task) => task.origin?.taskId === 'todo-3')?.columnId).toBe('done');

    board = await projectSessionTodosToKanban(
      sb.dir,
      [
        { id: 'todo-1', content: 'Inspect', status: 'completed' },
        { id: 'todo-2', content: 'Implement', status: 'in_progress' },
        { id: 'todo-3', content: 'Ship', status: 'completed' },
      ],
      'sess',
    );
    expect(board?.tasks.find((task) => task.origin?.taskId === 'todo-1')?.columnId).toBe('done');
  });

  it('advances the real managed cards and rebinds runtime context when todo progress moves', async () => {
    sb.ctx.agentId = 'test-agent';
    sb.ctx.agentName = 'Test Agent';
    sb.ctx.setCurrentKanbanTask = (taskId, boardId) => {
      sb.ctx.currentKanbanTaskId = taskId;
      sb.ctx.currentKanbanBoardId = boardId;
      sb.ctx.meta['kanban'] = { taskId, boardId };
    };
    await fs.writeFile(path.join(sb.dir, 'completion.txt'), 'verified', 'utf8');
    const board = await createBoard(sb.dir, {
      title: 'Canonical work',
      columns: [
        { id: 'backlog', title: 'Backlog', order: 0 },
        { id: 'todo', title: 'Todo', order: 1 },
        { id: 'running', title: 'Running', order: 2 },
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
    await configureContractGraph(sb.dir, board.id, 'strict');
    const seed = async (title: string) => {
      const added = await addTask(sb.dir, board.id, {
        title,
        description: `${title} completely.`,
        assignedAgent: 'test-agent',
        dueDate: '2026-08-10T00:00:00.000Z',
        labels: ['todo-sync'],
      });
      await addCheckToTask(sb.dir, board.id, added!.task.id, {
        description: 'completion.txt',
        type: 'file_exists',
      });
      await addGoalMetricToTask(sb.dir, board.id, added!.task.id, {
        name: `${title} result`,
        target: 'complete',
      });
      const task = (await getBoard(sb.dir, board.id))!.tasks.find(
        (candidate) => candidate.id === added!.task.id,
      )!;
      const checkId = task.successCriteria![0]!.id;
      const metricId = task.goalMetrics![0]!.id;
      await updateGoalMetricOnTask(sb.dir, board.id, task.id, metricId, {
        current: 'complete',
        status: 'met',
      });
      await upsertContractNode(sb.dir, board.id, {
        taskId: task.id,
        kind: 'objective',
        title: `${title} objective`,
        metricId,
      });
      await upsertContractNode(sb.dir, board.id, {
        taskId: task.id,
        kind: 'guardrail',
        title: `${title} guardrail`,
        checkId,
      });
      await upsertContractNode(sb.dir, board.id, {
        taskId: task.id,
        kind: 'risk',
        title: `${title} risk`,
        enforcement: 'advisory',
      });
      await upsertContractNode(sb.dir, board.id, {
        taskId: task.id,
        kind: 'component',
        title: 'Tools package',
      });
      await upsertContractNode(sb.dir, board.id, {
        taskId: task.id,
        kind: 'verification',
        title: `${title} verification`,
        checkId,
        enforcement: 'advisory',
      });
      return task.id;
    };
    const firstTaskId = await seed('First real task');
    const secondTaskId = await seed('Second real task');

    const started = await kanbanTool.execute(
      {
        action: 'start_task',
        boardId: board.id,
        taskId: firstTaskId,
        author: 'test-agent',
        transitionComment: 'Starting first card.',
      },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(started.ok, started.message).toBe(true);

    const advanced = await todoTool.execute(
      {
        todos: [
          { id: 'ui-1', content: 'First real task', status: 'completed' },
          { id: 'ui-2', content: 'Second real task', status: 'in_progress' },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const afterAdvance = await getBoard(sb.dir, board.id);
    expect(advanced.kanban_warnings, JSON.stringify(advanced)).toBeUndefined();
    expect(advanced.kanban_bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          todoId: 'ui-1',
          boardId: board.id,
          taskId: firstTaskId,
          taskStatus: 'completed',
        }),
        expect.objectContaining({
          todoId: 'ui-2',
          boardId: board.id,
          taskId: secondTaskId,
          taskStatus: 'in_progress',
        }),
      ]),
    );
    const firstAfterAdvance = afterAdvance?.tasks.find((task) => task.id === firstTaskId);
    expect(firstAfterAdvance?.status, JSON.stringify(firstAfterAdvance?.verificationReport)).toBe(
      'completed',
    );
    expect(afterAdvance?.tasks.find((task) => task.id === secondTaskId)?.status).toBe(
      'in_progress',
    );
    expect(sb.ctx.currentKanbanTaskId).toBe(secondTaskId);
    expect(sb.ctx.todos.find((todo) => todo.kanbanTaskId === secondTaskId)?.status).toBe(
      'in_progress',
    );

    await todoTool.execute(
      {
        todos: [
          {
            id: 'ui-1',
            content: 'First real task',
            status: 'completed',
            kanbanBoardId: board.id,
            kanbanTaskId: firstTaskId,
          },
          {
            id: 'ui-2',
            content: 'Second real task',
            status: 'pending',
            kanbanBoardId: board.id,
            kanbanTaskId: secondTaskId,
          },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const afterDemotion = await getBoard(sb.dir, board.id);
    const demoted = afterDemotion?.tasks.find((task) => task.id === secondTaskId);
    expect(demoted?.lifecycle?.currentStage).toBe('todo');
    expect(demoted?.assignment?.status).toBe('assigned');

    await todoTool.execute(
      {
        todos: [
          {
            id: 'ui-1',
            content: 'First real task',
            status: 'completed',
            kanbanBoardId: board.id,
            kanbanTaskId: firstTaskId,
          },
          {
            id: 'ui-2',
            content: 'Second real task',
            status: 'in_progress',
            kanbanBoardId: board.id,
            kanbanTaskId: secondTaskId,
          },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    await todoTool.execute(
      {
        todos: [
          {
            id: 'ui-1',
            content: 'First real task',
            status: 'completed',
            kanbanBoardId: board.id,
            kanbanTaskId: firstTaskId,
          },
          {
            id: 'ui-2',
            content: 'Second real task',
            status: 'completed',
            kanbanBoardId: board.id,
            kanbanTaskId: secondTaskId,
          },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const finished = await getBoard(sb.dir, board.id);
    expect(finished?.tasks.every((task) => task.status === 'completed')).toBe(true);
    expect(sb.ctx.todos.every((todo) => todo.status === 'completed')).toBe(true);
  });

  it('starts the next managed card while the previous card awaits acceptance', async () => {
    sb.ctx.agentId = 'test-agent';
    sb.ctx.setCurrentKanbanTask = (taskId, boardId) => {
      sb.ctx.currentKanbanTaskId = taskId;
      sb.ctx.currentKanbanBoardId = boardId;
      sb.ctx.meta['kanban'] = { taskId, boardId };
    };
    const board = await createBoard(sb.dir, {
      title: 'Non-blocking review queue',
      columns: [
        { id: 'backlog', title: 'Backlog', order: 0 },
        { id: 'todo', title: 'Todo', order: 1 },
        { id: 'running', title: 'Running', order: 2 },
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
    const seed = async (title: string, checkPath: string) => {
      const added = await addTask(sb.dir, board.id, {
        title,
        description: `${title} completely.`,
        assignedAgent: 'test-agent',
        dueDate: '2026-08-10T00:00:00.000Z',
        labels: ['todo-sync'],
      });
      await addCheckToTask(sb.dir, board.id, added!.task.id, {
        description: checkPath,
        type: 'file_exists',
      });
      return added!.task.id;
    };
    const firstTaskId = await seed('Needs another pass', 'missing-result.txt');
    const secondTaskId = await seed('Independent next task', 'next-result.txt');
    await fs.writeFile(path.join(sb.dir, 'next-result.txt'), 'ready', 'utf8');

    await kanbanTool.execute(
      {
        action: 'start_task',
        boardId: board.id,
        taskId: firstTaskId,
        author: 'test-agent',
        transitionComment: 'Starting first card.',
      },
      sb.ctx,
      { signal: newSignal() },
    );
    const result = await todoTool.execute(
      {
        todos: [
          { id: 'ui-1', content: 'Needs another pass', status: 'completed' },
          { id: 'ui-2', content: 'Independent next task', status: 'in_progress' },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const refreshed = await getBoard(sb.dir, board.id);
    expect(refreshed?.tasks.find((task) => task.id === firstTaskId)?.status).toBe('review');
    expect(refreshed?.tasks.find((task) => task.id === secondTaskId)?.status).toBe('in_progress');
    expect(sb.ctx.currentKanbanTaskId).toBe(secondTaskId);
    expect(result.kanban_warnings).toContain(
      'A completed todo is still awaiting acceptance; the next independent Kanban task was started.',
    );
  });

  it('does not silently reactivate a managed card that is already in Review', async () => {
    // Regression: synchroniseManagedKanban used to call start_task
    // unconditionally for any in_progress todo row, which yanked a Review
    // card back to Running without the reviewer's consent. The card must
    // stay in Review and a warning must explain why.
    sb.ctx.agentId = 'test-agent';
    sb.ctx.setCurrentKanbanTask = (taskId, boardId) => {
      sb.ctx.currentKanbanTaskId = taskId;
      sb.ctx.currentKanbanBoardId = boardId;
      sb.ctx.meta['kanban'] = { taskId, boardId };
    };
    const board = await createBoard(sb.dir, {
      title: 'Review guard',
      columns: [
        { id: 'backlog', title: 'Backlog', order: 0 },
        { id: 'todo', title: 'Todo', order: 1 },
        { id: 'running', title: 'Running', order: 2 },
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
    const added = await addTask(sb.dir, board.id, {
      title: 'Held for review',
      description: 'Work that reached Review.',
      assignedAgent: 'test-agent',
      dueDate: '2026-08-10T00:00:00.000Z',
      labels: ['todo-sync'],
    });
    const taskId = added!.task.id;
    await addCheckToTask(sb.dir, board.id, taskId, {
      description: 'evidence.txt',
      type: 'file_exists',
    });

    // Walk the card into Review the same way the happy-path todo test does:
    // start_task (Backlog→Todo→Running) then a todo `completed` row, which
    // drives mark_assignment(completed) and the managed running→review
    // auto-transition inside synchroniseManagedKanban.
    await kanbanTool.execute(
      {
        action: 'start_task',
        boardId: board.id,
        taskId,
        author: 'test-agent',
        transitionComment: 'Starting card.',
      },
      sb.ctx,
      { signal: newSignal() },
    );
    await todoTool.execute(
      {
        todos: [{ id: 'ui-1', content: 'Held for review', status: 'completed' }],
      },
      sb.ctx,
      { signal: newSignal() },
    );
    const beforeTodo = await getBoard(sb.dir, board.id);
    expect(beforeTodo?.tasks.find((task) => task.id === taskId)?.lifecycle?.currentStage).toBe(
      'review',
    );

    // Now the agent's todo list flips the same card back to in_progress
    // (e.g. it thinks it should keep working on it). Before the fix this
    // silently pulled the card back to Running; now it must stay in Review
    // with a warning that tells the user to call start_task explicitly.
    const result = await todoTool.execute(
      {
        todos: [{ id: 'ui-1', content: 'Held for review', status: 'in_progress' }],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const refreshed = await getBoard(sb.dir, board.id);
    const heldTask = refreshed?.tasks.find((task) => task.id === taskId);
    expect(heldTask?.lifecycle?.currentStage).toBe('review');
    expect(heldTask?.status).toBe('review');
    expect(result.kanban_warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Held for review.*Review.*not re-activating/i),
      ]),
    );
  });

  it('does not silently reactivate a managed card that has reached Done', async () => {
    // Done is terminal. A todo in_progress row bound to a Done card must not
    // pull it back; the user should be told to create a follow-up instead.
    sb.ctx.agentId = 'test-agent';
    sb.ctx.setCurrentKanbanTask = (taskId, boardId) => {
      sb.ctx.currentKanbanTaskId = taskId;
      sb.ctx.currentKanbanBoardId = boardId;
      sb.ctx.meta['kanban'] = { taskId, boardId };
    };
    const board = await createBoard(sb.dir, {
      title: 'Done guard',
      columns: [
        { id: 'backlog', title: 'Backlog', order: 0 },
        { id: 'todo', title: 'Todo', order: 1 },
        { id: 'running', title: 'Running', order: 2 },
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
    const added = await addTask(sb.dir, board.id, {
      title: 'Already shipped',
      description: 'Work that reached Done.',
      assignedAgent: 'test-agent',
      dueDate: '2026-08-10T00:00:00.000Z',
      labels: ['todo-sync'],
    });
    const taskId = added!.task.id;
    await addCheckToTask(sb.dir, board.id, taskId, {
      description: 'evidence.txt',
      type: 'file_exists',
    });
    await fs.writeFile(path.join(sb.dir, 'evidence.txt'), 'done', 'utf8');

    // Walk the card to Review via the todo-completion path, then to Done via
    // an explicit transition (acceptance).
    await kanbanTool.execute(
      {
        action: 'start_task',
        boardId: board.id,
        taskId,
        author: 'test-agent',
        transitionComment: 'Starting card.',
      },
      sb.ctx,
      { signal: newSignal() },
    );
    await todoTool.execute(
      {
        todos: [{ id: 'ui-1', content: 'Already shipped', status: 'completed' }],
      },
      sb.ctx,
      { signal: newSignal() },
    );
    await kanbanTool.execute(
      {
        action: 'transition_task',
        boardId: board.id,
        taskId,
        lifecycleStage: 'done',
        author: 'test-agent',
        transitionComment: 'Accepted.',
        transitionAction: 'verify',
      },
      sb.ctx,
      { signal: newSignal() },
    );
    const beforeTodo = await getBoard(sb.dir, board.id);
    expect(beforeTodo?.tasks.find((task) => task.id === taskId)?.lifecycle?.currentStage).toBe(
      'done',
    );

    const result = await todoTool.execute(
      {
        todos: [{ id: 'ui-1', content: 'Already shipped', status: 'in_progress' }],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const refreshed = await getBoard(sb.dir, board.id);
    const doneTask = refreshed?.tasks.find((task) => task.id === taskId);
    expect(doneTask?.lifecycle?.currentStage).toBe('done');
    expect(doneTask?.status).toBe('completed');
    expect(result.kanban_warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Already shipped.*Done.*terminal.*follow-up/i),
      ]),
    );
  });

  it('rolls up an invisible atomic parent after every visible child reaches Done', async () => {
    sb.ctx.agentId = 'test-agent';
    sb.ctx.setCurrentKanbanTask = (taskId, boardId) => {
      sb.ctx.currentKanbanTaskId = taskId;
      sb.ctx.currentKanbanBoardId = boardId;
      sb.ctx.meta['kanban'] = { taskId, boardId };
    };
    await Promise.all([
      fs.writeFile(path.join(sb.dir, 'parent.done'), 'yes', 'utf8'),
      fs.writeFile(path.join(sb.dir, 'child-a.done'), 'yes', 'utf8'),
      fs.writeFile(path.join(sb.dir, 'child-b.done'), 'yes', 'utf8'),
    ]);
    const board = await createBoard(sb.dir, {
      title: 'Composite completion',
      columns: [
        { id: 'backlog', title: 'Backlog', order: 0 },
        { id: 'todo', title: 'Todo', order: 1 },
        { id: 'running', title: 'Running', order: 2 },
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
    const parent = await addTask(sb.dir, board.id, {
      title: 'Composite parent',
      description: 'Aggregate both child results.',
      assignedAgent: 'test-agent',
      dueDate: '2026-08-10T00:00:00.000Z',
      labels: ['composite'],
      successCriteria: [
        { id: 'parent-check', description: 'parent.done', type: 'file_exists', status: 'pending' },
      ],
    });
    const split = await splitTask(sb.dir, board.id, parent!.task.id, {
      titles: ['Child A', 'Child B'],
      atomic: true,
      inheritAssignment: true,
      childSpecs: [
        {
          description: 'Complete child A.',
          successCriteria: [
            {
              id: 'child-a-check',
              description: 'child-a.done',
              type: 'file_exists',
              status: 'pending',
            },
          ],
        },
        {
          description: 'Complete child B.',
          successCriteria: [
            {
              id: 'child-b-check',
              description: 'child-b.done',
              type: 'file_exists',
              status: 'pending',
            },
          ],
        },
      ],
    });
    const [childA, childB] = split!.children;
    for (const child of split!.children) {
      await updateTask(sb.dir, board.id, child.id, {
        dueDate: '2026-08-10T00:00:00.000Z',
        labels: ['composite'],
      });
    }

    await kanbanTool.execute(
      {
        action: 'start_task',
        boardId: board.id,
        taskId: childA!.id,
        author: 'test-agent',
        transitionComment: 'Starting first child.',
      },
      sb.ctx,
      { signal: newSignal() },
    );
    await todoTool.execute(
      {
        todos: [
          { id: 'a', content: 'Child A', status: 'completed' },
          { id: 'b', content: 'Child B', status: 'in_progress' },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );
    await todoTool.execute(
      {
        todos: [
          {
            id: 'a',
            content: 'Child A',
            status: 'completed',
            kanbanBoardId: board.id,
            kanbanTaskId: childA!.id,
          },
          {
            id: 'b',
            content: 'Child B',
            status: 'completed',
            kanbanBoardId: board.id,
            kanbanTaskId: childB!.id,
          },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const completed = await getBoard(sb.dir, board.id);
    expect(completed?.tasks.find((task) => task.id === parent!.task.id)?.status).toBe('completed');
    expect(completed?.tasks.every((task) => task.status === 'completed')).toBe(true);
  });
});

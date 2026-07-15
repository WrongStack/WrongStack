import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskTool } from '../src/task.js';
import { newSignal } from './fixtures.js';

interface TaskSandbox {
  dir: string;
  taskPath: string;
  ctx: Context;
  cleanup(): Promise<void>;
}

async function mkTaskSandbox(): Promise<TaskSandbox> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-task-tool-'));
  const taskPath = path.join(dir, 'sess.tasks.json');
  const planPath = path.join(dir, 'sess.plan.json');
  const ctx = {
    cwd: dir,
    projectRoot: dir,
    session: { id: 'sess', append: async () => undefined, close: async () => undefined },
    meta: { 'task.path': taskPath, 'plan.path': planPath },
  } as never as Context;
  return {
    dir,
    taskPath,
    ctx,
    cleanup: async () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/** Read the raw task file from disk. */
async function readTasksOnDisk(taskPath: string): Promise<Array<{ id: string; title: string; status: string; dependsOn?: string[] }>> {
  const raw = JSON.parse(await fs.readFile(taskPath, 'utf8')) as {
    tasks: Array<{ id: string; title: string; status: string; dependsOn?: string[] }>;
  };
  return raw.tasks;
}

describe('taskTool', () => {
  let sb: TaskSandbox;
  beforeEach(async () => {
    // The task tool live-mirrors the list onto a kanban board (fire-and-forget).
    // These unit tests exercise the task tool in isolation, and the async board
    // write would race the recursive tmp-dir teardown (ENOTEMPTY on Windows), so
    // disable the mirror by default — the mirror gets its own explicit test.
    process.env.WRONGSTACK_KANBAN_TASK_MIRROR = '0';
    sb = await mkTaskSandbox();
  });
  afterEach(async () => {
    delete process.env.WRONGSTACK_KANBAN_TASK_MIRROR;
    await sb.cleanup();
  });

  // -------------------------------------------------------------------
  // show
  // -------------------------------------------------------------------
  it('show on a fresh session returns empty', async () => {
    const out = await taskTool.execute({ action: 'show' }, sb.ctx, { signal: newSignal() });
    expect(out.ok).toBe(true);
    expect(out.count).toBe(0);
    expect(out.completed).toBe(0);
    expect(out.inProgress).toBe(0);
    expect(out.message).toContain('No tasks');
  });

  // -------------------------------------------------------------------
  // replace
  // -------------------------------------------------------------------
  it('replace sets the full task list and persists to disk', async () => {
    const tasks = [
      { id: 't1', title: 'Task one', type: 'feature' as const, priority: 'high' as const, status: 'pending' as const },
      { id: 't2', title: 'Task two', type: 'bugfix' as const, priority: 'medium' as const, status: 'completed' as const },
    ];
    const out = await taskTool.execute({ action: 'replace', tasks }, sb.ctx, { signal: newSignal() });
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    expect(out.completed).toBe(1);
    expect(out.inProgress).toBe(0);

    const onDisk = await readTasksOnDisk(sb.taskPath);
    expect(onDisk).toHaveLength(2);
    expect(onDisk[0]?.title).toBe('Task one');
    expect(onDisk[0]?.id).toBe('t1');
  });

  // -------------------------------------------------------------------
  // add
  // -------------------------------------------------------------------
  it('add persists a single task with auto-generated id', async () => {
    await taskTool.execute(
      { action: 'add', task: { title: 'New feature', type: 'feature', priority: 'high' } },
      sb.ctx,
      { signal: newSignal() },
    );

    const onDisk = await readTasksOnDisk(sb.taskPath);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]?.title).toBe('New feature');
    expect(onDisk[0]?.type).toBe('feature');
    expect(onDisk[0]?.priority).toBe('high');
    expect(onDisk[0]?.status).toBe('pending');
    expect(onDisk[0]?.id).toMatch(/^task_/);
  });

  it('add with valid dependsOn persists dependency references', async () => {
    // Seed parent with known ID via replace
    await taskTool.execute(
      {
        action: 'replace',
        tasks: [{ id: 'p1', title: 'Parent', type: 'feature', priority: 'high', status: 'pending' }],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    // Add child that depends on p1
    await taskTool.execute(
      {
        action: 'add',
        task: { title: 'Child', type: 'feature', priority: 'medium', dependsOn: ['p1'] },
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const onDisk = await readTasksOnDisk(sb.taskPath);
    expect(onDisk).toHaveLength(2);
    const child = onDisk.find((t) => t.dependsOn && t.dependsOn.length > 0);
    expect(child).toBeDefined();
    expect(child!.dependsOn).toEqual(['p1']);
  });

  it('add without title returns ok=false', async () => {
    const out = await taskTool.execute(
      { action: 'add', task: { title: '', type: 'feature', priority: 'medium' } },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/requires/i);
  });

  it('add rejects dependsOn referencing non-existent task IDs', async () => {
    const out = await taskTool.execute(
      {
        action: 'add',
        task: { title: 'Orphan', type: 'feature', priority: 'medium', dependsOn: ['ghost_id'] },
      },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/dependsOn/i);
  });

  // -------------------------------------------------------------------
  // status transitions
  // -------------------------------------------------------------------
  it('status transitions pending → in_progress → completed', async () => {
    await taskTool.execute(
      {
        action: 'replace',
        tasks: [{ id: 't1', title: 'Work item', type: 'feature', priority: 'high', status: 'pending' }],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    // → in_progress
    let out = await taskTool.execute(
      { action: 'status', id: 't1', status: 'in_progress' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(true);
    expect(out.inProgress).toBe(1);

    // → completed
    out = await taskTool.execute(
      { action: 'status', id: 't1', status: 'completed' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(true);
    expect(out.completed).toBe(1);
    expect(out.inProgress).toBe(0);

    const onDisk = await readTasksOnDisk(sb.taskPath);
    expect(onDisk[0]?.status).toBe('completed');
  });

  it('status with ghost id returns ok=false', async () => {
    const out = await taskTool.execute(
      { action: 'status', id: 'ghost', status: 'in_progress' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not found/i);
  });

  it('status without id or status returns ok=false', async () => {
    const out = await taskTool.execute(
      { action: 'status' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(false);
  });

  // -------------------------------------------------------------------
  // promote (task → todo)
  // -------------------------------------------------------------------
  it('promote converts a task to todo items and calls replaceTodos', async () => {
    const replacedTodos: Array<{ id: string; content: string; status: string }> = [];
    (sb.ctx as never as { state: { replaceTodos: (todos: unknown[]) => void } }).state = {
      replaceTodos(todos: unknown[]) {
        replacedTodos.length = 0;
        replacedTodos.push(...todos as Array<{ id: string; content: string; status: string }>);
      },
    };

    await taskTool.execute(
      {
        action: 'replace',
        tasks: [
          {
            id: 'login-task',
            title: 'Implement login',
            description: 'Build OAuth login flow',
            type: 'feature',
            priority: 'high',
            status: 'pending',
          },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const out = await taskTool.execute(
      { action: 'promote', target: 'login-task' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/promote/i);
    expect(out.message).toContain('todo');
    expect(replacedTodos.length).toBeGreaterThanOrEqual(1);
    expect(replacedTodos[0]?.content).toBe('Implement login');
    expect(replacedTodos[0]?.status).toBe('in_progress');
  });

  it('promote with subtasks creates multiple todo items', async () => {
    const replacedTodos: Array<{ id: string; content: string; status: string }> = [];
    (sb.ctx as never as { state: { replaceTodos: (todos: unknown[]) => void } }).state = {
      replaceTodos(todos: unknown[]) {
        replacedTodos.length = 0;
        replacedTodos.push(...todos as Array<{ id: string; content: string; status: string }>);
      },
    };

    await taskTool.execute(
      {
        action: 'replace',
        tasks: [
          { id: 't1', title: 'Build auth', type: 'feature', priority: 'high', status: 'pending' },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const out = await taskTool.execute(
      { action: 'promote', target: 't1', subtasks: ['Write tests', 'Add docs'] },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(true);
    expect(replacedTodos.length).toBe(3); // 1 parent + 2 subtasks
    expect(replacedTodos[0]?.status).toBe('in_progress'); // parent active
    expect(replacedTodos[1]?.status).toBe('pending');      // subtask 1
    expect(replacedTodos[2]?.status).toBe('pending');      // subtask 2
  });

  // -------------------------------------------------------------------
  // planify (task → plan)
  // -------------------------------------------------------------------
  it('planify converts a task to a plan item', async () => {
    await taskTool.execute(
      {
        action: 'replace',
        tasks: [{ id: 't1', title: 'Strategic initiative', description: 'Big picture goal', type: 'feature', priority: 'high', status: 'pending' }],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const out = await taskTool.execute(
      { action: 'planify', target: 't1' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/planify ok/i);
    expect(out.message).toContain('Strategic initiative');

    // Verify the plan file was written
    const planPath = (sb.ctx.meta as Record<string, unknown>)['plan.path'] as string;
    const raw = JSON.parse(await fs.readFile(planPath, 'utf8')) as {
      items: Array<{ title: string; details: string }>;
    };
    expect(raw.items).toHaveLength(1);
    expect(raw.items[0]?.title).toBe('Strategic initiative');
    expect(raw.items[0]?.details).toBe('Big picture goal');
  });

  it('planify without target returns ok=false', async () => {
    const out = await taskTool.execute(
      { action: 'planify' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/target/i);
  });

  // -------------------------------------------------------------------
  // error paths
  // -------------------------------------------------------------------
  it('returns failure when task path is not configured', async () => {
    const noMetaCtx = {
      cwd: sb.dir,
      projectRoot: sb.dir,
      session: { id: 'x', append: async () => undefined, close: async () => undefined },
      meta: {},
    } as never as Context;
    const out = await taskTool.execute({ action: 'show' }, noMetaCtx, { signal: newSignal() });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not configured/i);
  });

  it('replace without tasks array returns ok=false', async () => {
    const out = await taskTool.execute({ action: 'replace' }, sb.ctx, { signal: newSignal() });
    expect(out.ok).toBe(false);
  });

  it('unknown action returns ok=false', async () => {
    const out = await taskTool.execute({ action: 'bogus' as 'show' }, sb.ctx, { signal: newSignal() });
    expect(out.ok).toBe(false);
  });

  // -------------------------------------------------------------------
  // additional branch coverage
  // -------------------------------------------------------------------
  it('replace rejects dependsOn referencing IDs outside the new batch', async () => {
    const out = await taskTool.execute(
      {
        action: 'replace',
        tasks: [
          { id: 't1', title: 'A', type: 'feature', priority: 'high', status: 'pending', dependsOn: ['nope'] },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/dependsOn validation failed/);
  });

  it('promote includes the description as a second todo and matches by index/substring', async () => {
    (sb.ctx as never as { state: { replaceTodos: (t: unknown[]) => void } }).state = {
      replaceTodos() {},
    };
    await taskTool.execute(
      {
        action: 'replace',
        tasks: [
          { id: 't1', title: 'Build login', description: 'OAuth + sessions', type: 'feature', priority: 'high', status: 'pending' },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );
    // Match by 1-based index → exercises the numeric branch of findTaskIndex.
    const byIndex = await taskTool.execute({ action: 'promote', target: '1' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(byIndex.ok).toBe(true);
    // The description becomes an extra todo (count includes title + description).
    expect(byIndex.message).toMatch(/2 todo\(s\)/);

    // Match by title substring → exercises the substring branch.
    const bySubstring = await taskTool.execute({ action: 'promote', target: 'login' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(bySubstring.ok).toBe(true);
  });

  it('promote without a target returns ok=false', async () => {
    const out = await taskTool.execute({ action: 'promote' }, sb.ctx, { signal: newSignal() });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/requires `target`/);
  });

  it('promote with a non-matching target returns ok=false', async () => {
    const out = await taskTool.execute({ action: 'promote', target: 'no-such-task' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/No task matched/);
  });

  it('planify with a non-matching target returns ok=false', async () => {
    await taskTool.execute(
      {
        action: 'replace',
        tasks: [{ id: 't1', title: 'X', type: 'feature', priority: 'low', status: 'pending' }],
      },
      sb.ctx,
      { signal: newSignal() },
    );
    const out = await taskTool.execute({ action: 'planify', target: 'ghost' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/No task matched/);
  });

  it('planify returns ok=false when no plan path is configured', async () => {
    const noPlanCtx = {
      cwd: sb.dir,
      projectRoot: sb.dir,
      session: { id: 'sess2', append: async () => undefined, close: async () => undefined },
      meta: { 'task.path': path.join(sb.dir, 'sess2.tasks.json') }, // no plan.path
    } as never as Context;
    await taskTool.execute(
      {
        action: 'replace',
        tasks: [{ id: 't1', title: 'Y', type: 'feature', priority: 'low', status: 'pending' }],
      },
      noPlanCtx,
      { signal: newSignal() },
    );
    const out = await taskTool.execute({ action: 'planify', target: 't1' }, noPlanCtx, {
      signal: newSignal(),
    });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/Plan storage path not configured/);
  });

  it('promote leaves a completed task status unchanged', async () => {
    (sb.ctx as never as { state: { replaceTodos: (t: unknown[]) => void } }).state = {
      replaceTodos() {},
    };
    await taskTool.execute(
      {
        action: 'replace',
        tasks: [{ id: 't1', title: 'Done task', type: 'feature', priority: 'low', status: 'completed' }],
      },
      sb.ctx,
      { signal: newSignal() },
    );
    await taskTool.execute({ action: 'promote', target: 't1' }, sb.ctx, { signal: newSignal() });
    const onDisk = await readTasksOnDisk(sb.taskPath);
    expect(onDisk[0]?.status).toBe('completed'); // not flipped to in_progress
  });

  // -------------------------------------------------------------------
  // kanban live mirror
  // -------------------------------------------------------------------
  it('mirrors the task list onto a session:<id> kanban board when enabled', async () => {
    // Opt back IN for this test (beforeEach disabled it) and drive the mirror
    // directly so we can await the projection rather than the fire-and-forget
    // path (which would race the assertion).
    delete process.env.WRONGSTACK_KANBAN_TASK_MIRROR;
    const { projectSessionTasksToKanban } = await import('../src/session-kanban.js');
    const { listBoards } = await import('@wrongstack/kanban');

    await taskTool.execute(
      {
        action: 'replace',
        tasks: [
          { id: 't1', title: 'First', type: 'feature', priority: 'high', status: 'pending' },
          { id: 't2', title: 'Second', type: 'bugfix', priority: 'low', status: 'pending', dependsOn: ['t1'] },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );

    const file = JSON.parse(await fs.readFile(sb.taskPath, 'utf8')) as { tasks: unknown[] };
    const board = await projectSessionTasksToKanban(sb.dir, file.tasks as never, 'sess');
    expect(board).not.toBeNull();
    expect(board?.tags).toContain('session:sess');
    expect(board?.tasks.length).toBe(2);

    // Re-running is idempotent — same board, not a duplicate.
    const boardsBefore = await listBoards(sb.dir);
    await projectSessionTasksToKanban(sb.dir, file.tasks as never, 'sess');
    const boardsAfter = await listBoards(sb.dir);
    expect(boardsAfter.length).toBe(boardsBefore.length);
  });
});

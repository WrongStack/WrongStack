import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context, TodoItem } from '@wrongstack/core/agent';
import { createBoard, getBoard } from '@wrongstack/kanban';
import { addTask } from '@wrongstack/kanban/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { todoTool } from '../src/todo.js';
import { newSignal } from './fixtures.js';

/** Session that owns the board events these tests write. */
const TEST_CONTEXT_SESSION_ID = '2026-08-26/sess_01TESTTOOLSCONTEXT0000000';

/**
 * The whole loop, as it is actually lived: todo rows ARE Kanban cards, one row
 * is worked at a time, finishing it promotes the next, and the plan changes
 * mid-flight — cards get added, split, merged and deleted while work is
 * running.
 *
 * The invariant under test is not "every gate passes". It is that the run is
 * never STUCK: the todo surface may warn, demote, or refuse to apply a
 * contradictory row, but it must always return successfully and always leave a
 * way forward. A tool that throws, or that reports a state the board will not
 * accept and offers no remedy, is the failure this file exists to catch.
 */
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-flow-'));
});

function makeCtx(): Context {
  const todos: TodoItem[] = [];
  const ctx = {
    eventSessionId: () => TEST_CONTEXT_SESSION_ID,
    projectRoot: dir,
    session: { id: 'flow-session' },
    agentId: 'agent-1',
    meta: {} as Record<string, unknown>,
    todos,
    currentKanbanBoardId: undefined as string | undefined,
    currentKanbanTaskId: undefined as string | undefined,
    setCurrentKanbanTask(taskId?: string, boardId?: string) {
      ctx.currentKanbanTaskId = taskId;
      ctx.currentKanbanBoardId = boardId;
    },
    state: {
      replaceTodos(next: TodoItem[]) {
        ctx.todos.splice(0, ctx.todos.length, ...next);
      },
      setMeta(key: string, value: unknown) {
        ctx.meta[key] = value;
      },
    },
  } as unknown as Context & { todos: TodoItem[] };
  return ctx;
}

const kanban = (ctx: Context, input: Record<string, unknown>) =>
  kanbanTool.execute(input as never, ctx, { signal: newSignal() });

const todo = (ctx: Context, todos: TodoItem[]) =>
  todoTool.execute({ todos } as never, ctx, { signal: newSignal() });

async function managedBoard(): Promise<string> {
  const board = await createBoard(dir, {
    title: 'Flow board',
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
  return board.id;
}

const seedCard = (boardId: string, title: string) =>
  addTask(dir, boardId, { title, description: `${title} description`, assignee: 'agent-1' });

const row = (
  id: string,
  content: string,
  status: TodoItem['status'],
  boardId: string,
  taskId: string,
): TodoItem =>
  ({
    id,
    content,
    status,
    activeForm: content,
    kanbanBoardId: boardId,
    kanbanTaskId: taskId,
  }) as TodoItem;

describe('todo ↔ kanban flow never strands the run', () => {
  it('walks three cards to completion, one in progress at a time', async () => {
    const ctx = makeCtx();
    const boardId = await managedBoard();
    ctx.currentKanbanBoardId = boardId;
    const a = (await seedCard(boardId, 'First'))!.task.id;
    const b = (await seedCard(boardId, 'Second'))!.task.id;
    const c = (await seedCard(boardId, 'Third'))!.task.id;
    for (const id of [a, b, c]) {
      await kanban(ctx, {
        action: 'add_check',
        boardId,
        taskId: id,
        checkDescription: 'Behaviour verified',
        checkStatus: 'passed',
      });
    }

    // Start on the first row.
    let result = await todo(ctx, [
      row('1', 'First', 'in_progress', boardId, a),
      row('2', 'Second', 'pending', boardId, b),
      row('3', 'Third', 'pending', boardId, c),
    ]);
    expect(result.in_progress).toBe(1);

    // Finish it and promote the next in the SAME full-list update — the
    // documented way to advance.
    result = await todo(ctx, [
      row('1', 'First', 'completed', boardId, a),
      row('2', 'Second', 'in_progress', boardId, b),
      row('3', 'Third', 'pending', boardId, c),
    ]);
    expect(result.in_progress).toBe(1);

    result = await todo(ctx, [
      row('1', 'First', 'completed', boardId, a),
      row('2', 'Second', 'completed', boardId, b),
      row('3', 'Third', 'in_progress', boardId, c),
    ]);
    result = await todo(ctx, [
      row('1', 'First', 'completed', boardId, a),
      row('2', 'Second', 'completed', boardId, b),
      row('3', 'Third', 'completed', boardId, c),
    ]);

    // Every card actually moved on the board — the list did not just claim it.
    const board = await getBoard(dir, boardId);
    for (const id of [a, b, c]) {
      const task = board!.tasks.find((t) => t.id === id);
      expect(['completed', 'review']).toContain(task?.status);
    }
  });

  it('omitting an unfinished row does not cancel it, and never errors', async () => {
    const ctx = makeCtx();
    const boardId = await managedBoard();
    ctx.currentKanbanBoardId = boardId;
    const a = (await seedCard(boardId, 'Kept'))!.task.id;
    const b = (await seedCard(boardId, 'Dropped from the list'))!.task.id;

    await todo(ctx, [
      row('1', 'Kept', 'in_progress', boardId, a),
      row('2', 'Dropped from the list', 'pending', boardId, b),
    ]);

    // A shorter list arrives. Omission is not a cancellation mechanism.
    const result = await todo(ctx, [row('1', 'Kept', 'in_progress', boardId, a)]);
    expect(result.count).toBeGreaterThanOrEqual(2);
    expect(ctx.todos.some((item) => item.kanbanTaskId === b)).toBe(true);
  });

  it('a card added mid-run joins the list without interrupting the current one', async () => {
    const ctx = makeCtx();
    const boardId = await managedBoard();
    ctx.currentKanbanBoardId = boardId;
    const a = (await seedCard(boardId, 'Running work'))!.task.id;
    await kanban(ctx, {
      action: 'add_check',
      boardId,
      taskId: a,
      checkDescription: 'Behaviour verified',
    });
    await todo(ctx, [row('1', 'Running work', 'in_progress', boardId, a)]);

    // Work discovered mid-task.
    const created = await kanban(ctx, {
      action: 'add_task',
      boardId,
      title: 'Discovered follow-up',
      description: 'Found while implementing',
      assignee: 'agent-1',
    });
    expect(created.ok).toBe(true);

    const result = await todo(ctx, [
      row('1', 'Running work', 'in_progress', boardId, a),
      row('2', 'Discovered follow-up', 'pending', boardId, created.task!.id),
    ]);
    expect(result.in_progress).toBe(1);
    expect(ctx.todos).toHaveLength(2);
  });

  it('a row the board will not start is demoted WITH the reason, never silently', async () => {
    // The dangerous shape is not the refusal — it is a list that quietly shows
    // nothing in progress while the caller has no idea why. The row must come
    // back pending AND the board's own reason must reach the caller.
    const ctx = makeCtx();
    const boardId = await managedBoard();
    ctx.currentKanbanBoardId = boardId;
    const a = (await seedCard(boardId, 'Missing its criteria'))!.task.id;

    const result = await todo(ctx, [row('1', 'Missing its criteria', 'in_progress', boardId, a)]);

    expect(result.in_progress).toBe(0);
    const warnings = (result.kanban_warnings ?? []).join(' ');
    expect(warnings).toContain('acceptance criterion');

    // And the remedy the warning names actually clears it.
    await kanban(ctx, {
      action: 'add_check',
      boardId,
      taskId: a,
      checkDescription: 'Behaviour verified',
    });
    const retried = await todo(ctx, [row('1', 'Missing its criteria', 'in_progress', boardId, a)]);
    expect(retried.in_progress).toBe(1);
  });

  it('splitting the card being worked leaves a usable list, not a stuck one', async () => {
    const ctx = makeCtx();
    const boardId = await managedBoard();
    ctx.currentKanbanBoardId = boardId;
    const parent = (await seedCard(boardId, 'Too big'))!.task.id;
    await todo(ctx, [row('1', 'Too big', 'in_progress', boardId, parent)]);

    const split = await kanban(ctx, {
      action: 'split_atomic',
      boardId,
      taskId: parent,
      childTitles: ['Half one', 'Half two'],
    });
    expect(split.ok).toBe(true);

    // The projection still resolves and the tool still succeeds.
    const result = await todo(ctx, ctx.todos);
    expect(result.count).toBeGreaterThan(0);

    // And the parent is not stranded: it can be made a leaf again if the split
    // turns out to be the wrong call.
    const relaxed = await kanban(ctx, {
      action: 'update_task',
      boardId,
      taskId: parent,
      atomic: false,
    });
    expect(relaxed.ok).toBe(true);
  });

  it('deleting the active card clears the binding instead of stranding the run', async () => {
    const ctx = makeCtx();
    const boardId = await managedBoard();
    const a = (await seedCard(boardId, 'Abandoned work'))!.task.id;
    await kanban(ctx, {
      action: 'add_check',
      boardId,
      taskId: a,
      checkDescription: 'Would have been verified',
    });
    await kanban(ctx, {
      action: 'start_task',
      boardId,
      taskId: a,
      author: 'agent-1',
      transitionComment: 'Starting.',
    });
    expect(ctx.currentKanbanTaskId).toBe(a);

    const deleted = await kanban(ctx, { action: 'delete_task', boardId, taskId: a });
    expect(deleted.ok).toBe(true);
    // A binding pointing at a card that no longer exists is what governance
    // reads as "active task not found" and refuses every mutation on.
    expect(ctx.currentKanbanTaskId).toBeUndefined();
    expect(ctx.currentKanbanBoardId).toBe(boardId);
  });

  it('merging two cards mid-run keeps the surface answerable', async () => {
    const ctx = makeCtx();
    const boardId = await managedBoard();
    ctx.currentKanbanBoardId = boardId;
    const a = (await seedCard(boardId, 'Overlap one'))!.task.id;
    const b = (await seedCard(boardId, 'Overlap two'))!.task.id;
    await todo(ctx, [
      row('1', 'Overlap one', 'in_progress', boardId, a),
      row('2', 'Overlap two', 'pending', boardId, b),
    ]);

    const merged = await kanban(ctx, {
      action: 'merge_tasks',
      boardId,
      taskIds: [a, b],
      title: 'Merged work',
    });
    expect(merged.ok).toBe(true);

    // The list still applies without error after lineage changed underneath it.
    const result = await todo(ctx, ctx.todos);
    expect(result).toBeDefined();
  });

  it('a completed todo whose card was never started is walked forward, not stranded', async () => {
    // The bug: a todo arrives already `completed` but its card was never
    // dispatched (still in Backlog or Todo). Without a pre-step the card sits
    // in its original stage with a 'completed' assignment that the lifecycle
    // gate never picks up — the todo surface shows completed while the board
    // card is stuck, and the next board projection reverts the todo.
    const ctx = makeCtx();
    const boardId = await managedBoard();
    ctx.currentKanbanBoardId = boardId;
    const a = (await seedCard(boardId, 'Never started'))!.task.id;
    await kanban(ctx, {
      action: 'add_check',
      boardId,
      taskId: a,
      checkDescription: 'Behaviour verified',
      checkStatus: 'passed',
    });

    // Mark it completed without ever starting it.
    const result = await todo(ctx, [row('1', 'Never started', 'completed', boardId, a)]);
    expect(result.count).toBeGreaterThanOrEqual(1);

    // The card must have advanced past its original stage — either to Review
    // or Completed, not still sitting in Backlog/Todo.
    const board = await getBoard(dir, boardId);
    const task = board!.tasks.find((t) => t.id === a);
    expect(['review', 'completed']).toContain(task?.status);
  });

  it('a review card with completed assignment does not revert the todo to in_progress', async () => {
    // The rewind loop: todo marks row completed → card reaches Review →
    // board projection reverts row to in_progress → model re-completes it.
    // A Review card whose assignment is 'completed' must project as completed.
    const ctx = makeCtx();
    const boardId = await managedBoard();
    ctx.currentKanbanBoardId = boardId;
    const a = (await seedCard(boardId, 'Loop-prone'))!.task.id;
    await kanban(ctx, {
      action: 'add_check',
      boardId,
      taskId: a,
      checkDescription: 'Behaviour verified',
      checkStatus: 'passed',
    });

    // Start and complete it through the normal flow.
    await todo(ctx, [row('1', 'Loop-prone', 'in_progress', boardId, a)]);
    await todo(ctx, [row('1', 'Loop-prone', 'completed', boardId, a)]);

    // The card should be in Review or Completed with a completed assignment.
    const board = await getBoard(dir, boardId);
    const task = board!.tasks.find((t) => t.id === a);
    expect(['review', 'completed']).toContain(task?.status);

    // Now re-apply the same completed list — the todo surface must not revert
    // the row to in_progress. If the projection is broken, the todo tool
    // would see the card in review and map it back to in_progress.
    const result = await todo(ctx, [row('1', 'Loop-prone', 'completed', boardId, a)]);
    expect(result.count).toBeGreaterThanOrEqual(1);

    // Verify the todo list itself reflects completed, not in_progress.
    const completedRow = ctx.todos.find((t) => t.kanbanTaskId === a);
    expect(completedRow?.status).toBe('completed');
  });

  it('a contradictory row is reported, never thrown', async () => {
    // Asking to reopen a Done card cannot be honoured — Done is terminal on a
    // managed board. The tool must say so and carry on, not fail the turn.
    const ctx = makeCtx();
    const boardId = await managedBoard();
    ctx.currentKanbanBoardId = boardId;
    const a = (await seedCard(boardId, 'Finished'))!.task.id;
    await kanban(ctx, {
      action: 'add_check',
      boardId,
      taskId: a,
      checkDescription: 'Verified',
      checkStatus: 'passed',
    });
    await todo(ctx, [row('1', 'Finished', 'completed', boardId, a)]);

    const result = await todo(ctx, [row('1', 'Finished', 'in_progress', boardId, a)]);
    expect(result).toBeDefined();
    expect(result.count).toBeGreaterThan(0);
  });
});

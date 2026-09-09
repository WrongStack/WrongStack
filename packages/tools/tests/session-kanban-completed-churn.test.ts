import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context, TodoItem } from '@wrongstack/core/agent';
import type { KanbanBoard } from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mailboxMocks = vi.hoisted(() => ({
  send: vi.fn(async (_input: unknown) => ({ id: 'message-id' })),
}));

vi.mock('@wrongstack/core/coordination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/core/coordination')>()),
  getSharedProjectMailbox: () => ({ send: mailboxMocks.send }),
}));

import {
  applyManagedKanbanBoardToTodos,
  applySessionKanbanBoardToTodos,
} from '../src/session-kanban-sync.js';

/**
 * A finished board must go quiet.
 *
 * `ConversationState.replaceTodos` auto-clears an all-completed list to `[]`.
 * The managed projection compared `context.todos` against the UNCOLLAPSED
 * projection, so once every card was done the comparison could never match:
 * every board event replaced the todos again, folded another
 * "[KANBAN TODO UPDATE] … reassess your current plan" turn into the
 * conversation and re-broadcast the mailbox status. On a completed managed
 * board that is self-sustaining — the agent is told the board changed for ever
 * and never stops working it, which is why finished cards appeared to reopen
 * and loop. The session projection already carried the collapse guard; the
 * managed one did not.
 */

function boardWith(
  statuses: Array<'todo' | 'completed'>,
  extra: Partial<KanbanBoard> = {},
): KanbanBoard {
  return {
    id: 'board-1',
    title: 'Managed board',
    tags: [],
    lifecycle: { mode: 'managed' },
    columns: [{ id: 'col-1', title: 'Todo', order: 0 }],
    tasks: statuses.map((status, index) => ({
      id: `task-${index + 1}`,
      title: `Task ${index + 1}`,
      columnId: 'col-1',
      status,
      priority: 'medium',
      order: index,
      createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    })),
    ...extra,
  } as never as KanbanBoard;
}

describe('completed Kanban board stops re-notifying', () => {
  let dir: string;
  let replaced: TodoItem[][];
  let appended: string[];

  beforeEach(async () => {
    mailboxMocks.send.mockClear();
    replaced = [];
    appended = [];
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-churn-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /**
   * Faithful `replaceTodos`: mirrors ConversationState's auto-clear of an
   * all-completed list. A mock without that collapse cannot reproduce the churn.
   */
  function makeContext(initial: TodoItem[] = []): Context {
    const todos: TodoItem[] = [...initial];
    return {
      agentId: 'leader',
      projectRoot: dir,
      todos,
      meta: {},
      session: { id: 'session-a' },
      currentKanbanBoardId: 'board-1',
      state: {
        revision: 1,
        replaceTodos(next: TodoItem[]) {
          const allDone = next.length > 0 && next.every((t) => t.status === 'completed');
          const effective = allDone ? [] : next;
          replaced.push([...next]);
          todos.splice(0, todos.length, ...effective);
        },
        appendBlockToLastUserMessage(block: { text: string }) {
          appended.push(block.text);
          return true;
        },
      },
    } as never as Context;
  }

  it('does not re-project a fully completed managed board on every board event', () => {
    const context = makeContext();
    const board = boardWith(['completed', 'completed']);

    for (let event = 0; event < 5; event++) {
      applyManagedKanbanBoardToTodos(context, board, new WeakSet());
    }

    expect(replaced).toEqual([]);
    expect(appended).toEqual([]);
    expect(mailboxMocks.send).not.toHaveBeenCalled();
  });

  it('notifies exactly once when the last card completes, then goes quiet', () => {
    const context = makeContext();

    // The board is still in progress: this projection is real work.
    applyManagedKanbanBoardToTodos(context, boardWith(['todo', 'todo']), new WeakSet());
    expect(replaced).toHaveLength(1);
    expect(appended).toHaveLength(1);

    // The last card completes. One notification, and the auto-clear empties todos.
    const finished = boardWith(['completed', 'completed']);
    applyManagedKanbanBoardToTodos(context, finished, new WeakSet());
    expect(replaced).toHaveLength(2);
    expect(appended).toHaveLength(2);
    expect(context.todos).toEqual([]);

    // Every subsequent board event must be a no-op.
    for (let event = 0; event < 5; event++) {
      applyManagedKanbanBoardToTodos(context, finished, new WeakSet());
    }
    expect(replaced).toHaveLength(2);
    expect(appended).toHaveLength(2);
    expect(mailboxMocks.send).toHaveBeenCalledTimes(2);
  });

  it('still projects a board that has unfinished work', () => {
    const context = makeContext();
    applyManagedKanbanBoardToTodos(context, boardWith(['completed', 'todo']), new WeakSet());
    expect(replaced).toHaveLength(1);
    expect(context.todos).toHaveLength(2);

    // Re-applying the same board is idempotent.
    applyManagedKanbanBoardToTodos(context, boardWith(['completed', 'todo']), new WeakSet());
    expect(replaced).toHaveLength(1);
  });

  it('holds the same line for the session projection when todos were not auto-cleared', () => {
    const board = boardWith(['completed', 'completed'], {
      tags: ['session:session-a'],
      lifecycle: { mode: 'session' },
    } as Partial<KanbanBoard>);
    // Rows still present verbatim — the state that the collapse-only guard missed.
    const context = makeContext([
      { id: 'task-1', content: 'Task 1', status: 'completed' },
      { id: 'task-2', content: 'Task 2', status: 'completed' },
    ] as TodoItem[]);

    for (let event = 0; event < 5; event++) {
      applySessionKanbanBoardToTodos(context, board, {
        sessionIdFromTags: () => 'session-a',
        isOwnedSessionBoard: () => true,
        hasInFlightTodoMirror: () => false,
        suppressedTodoMirrors: new WeakSet(),
      });
    }

    expect(replaced).toEqual([]);
    expect(appended).toEqual([]);
  });
});

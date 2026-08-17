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

import { applyManagedKanbanBoardToTodos } from '../src/session-kanban-sync.js';

/** Mirrors sessionIdFromTags in session-kanban.ts — the `session:<id>` tag. */
function sessionOwnerFromTags(tags: readonly string[] | undefined): string | null {
  const tag = tags?.find((candidate) => candidate.startsWith('session:'));
  return tag?.slice('session:'.length) || null;
}

function makeBoard(tags: string[]): KanbanBoard {
  return {
    id: 'board-1',
    title: 'Managed board',
    tags,
    lifecycle: { mode: 'managed' },
    columns: [{ id: 'col-1', title: 'Todo', order: 0 }],
    tasks: [{ id: 'task-1', title: 'Projection task', columnId: 'col-1', status: 'todo' }],
  } as never as KanbanBoard;
}

describe('managed board session-ownership guard', () => {
  let dir: string;
  let replaced: TodoItem[][];

  beforeEach(async () => {
    mailboxMocks.send.mockClear();
    replaced = [];
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-guard-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeContext(sessionId: string): Context {
    const todos: TodoItem[] = [];
    return {
      agentId: 'leader',
      projectRoot: dir,
      todos,
      meta: {},
      session: { id: sessionId },
      currentKanbanBoardId: 'board-1',
      state: {
        revision: 3,
        replaceTodos(next: TodoItem[]) {
          replaced.push([...next]);
          todos.splice(0, todos.length, ...next);
        },
      },
    } as never as Context;
  }

  it('blocks projection when the board is tagged as owned by another session', () => {
    const context = makeContext('session-a');
    const result = applyManagedKanbanBoardToTodos(
      context,
      makeBoard(['session:session-b']),
      new WeakSet(),
      { sessionOwnerFromTags },
    );
    // The bleed: a foreign session's board must not project into this
    // session's todo list, even when it is this context's active board.
    expect(result).toEqual([]);
    expect(replaced).toEqual([]);
    expect(context.todos).toEqual([]);
  });

  it('projects a board owned by this session', () => {
    const context = makeContext('session-a');
    applyManagedKanbanBoardToTodos(
      context,
      makeBoard(['session', 'session:session-a']),
      new WeakSet(),
      { sessionOwnerFromTags },
    );
    expect(replaced).toHaveLength(1);
    expect(replaced[0]![0]!.kanbanTaskId).toBe('task-1');
  });

  it('still projects an untagged shared project board', () => {
    const context = makeContext('session-a');
    applyManagedKanbanBoardToTodos(context, makeBoard([]), new WeakSet(), {
      sessionOwnerFromTags,
    });
    expect(replaced).toHaveLength(1);
  });

  it('is inert without an injected extractor — the production wrapper always injects', () => {
    const context = makeContext('session-a');
    applyManagedKanbanBoardToTodos(context, makeBoard(['session:session-b']), new WeakSet());
    expect(replaced).toHaveLength(1);
  });
});

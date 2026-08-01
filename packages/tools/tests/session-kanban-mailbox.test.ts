import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context, TodoItem } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mailboxMocks = vi.hoisted(() => ({
  send: vi.fn(async (_input: unknown) => ({ id: 'message-id' })),
}));

vi.mock('@wrongstack/core/coordination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/core/coordination')>()),
  getSharedProjectMailbox: () => ({ send: mailboxMocks.send }),
}));

import {
  applySessionKanbanBoardToTodos,
  projectSessionTodosToKanban,
} from '../src/session-kanban.js';

describe('session Kanban mailbox awareness', () => {
  let dir: string;

  beforeEach(async () => {
    mailboxMocks.send.mockClear();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-session-kanban-mailbox-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('broadcasts a compact invalidation instead of retaining the complete todo list', async () => {
    const todos: TodoItem[] = [
      { id: 'pending', content: 'A'.repeat(32_000), status: 'pending' },
      { id: 'active', content: 'B'.repeat(32_000), status: 'in_progress' },
      { id: 'done', content: 'C'.repeat(32_000), status: 'completed' },
    ];
    const board = await projectSessionTodosToKanban(dir, todos, 'session-id');
    const current: TodoItem[] = [];
    const context = {
      agentId: 'leader',
      projectRoot: dir,
      todos: current,
      meta: {},
      session: { id: 'session-id' },
      state: {
        revision: 17,
        replaceTodos(next: TodoItem[]) {
          current.splice(0, current.length, ...next);
        },
      },
    } as never as Context;

    applySessionKanbanBoardToTodos(context, board!);

    expect(mailboxMocks.send).toHaveBeenCalledOnce();
    const sent = mailboxMocks.send.mock.calls[0]![0] as {
      body: string;
      ttlMs?: number;
    };
    expect(JSON.parse(sent.body)).toEqual({
      kind: 'kanban.todos.updated',
      sessionId: 'session-id',
      revision: 17,
      todoCount: 3,
      statusCounts: { pending: 1, inProgress: 1, completed: 1 },
    });
    expect(sent.body.length).toBeLessThan(256);
    expect(sent).not.toHaveProperty('ttlMs');
  });
});

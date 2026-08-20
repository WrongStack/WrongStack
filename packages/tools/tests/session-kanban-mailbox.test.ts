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

  it('broadcasts a human-readable summary instead of the complete todo list or a JSON envelope', async () => {
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
      to?: string;
      type?: string;
      body: string;
      ttlMs?: number;
    };
    // Session-targeted, never `to: '*'` — a project-wide fan-out delivered
    // this session's projection into every other session's mailbox (the
    // cross-session todo bleed). `status` is legal for the `@session:` form.
    expect(sent.to).toBe('@session:session-id');
    expect(sent.type).toBe('status');
    // Human-readable summary only: the body is prose an agent reads in
    // context, never a JSON envelope it must mentally deserialize. The
    // identity data the old JSON carried is redundant here — the session is
    // the `@session:` recipient, the count is in the subject line.
    expect(sent.body.startsWith('{')).toBe(false);
    expect(sent.body).toContain('3 items');
    expect(sent.body).toContain('1 completed');
    expect(sent.body).toContain('1 in progress');
    expect(sent.body).toContain('1 pending');
    expect(sent.body.length).toBeLessThan(256);
    expect(sent).not.toHaveProperty('ttlMs');
  });
});

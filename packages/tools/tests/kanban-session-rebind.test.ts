import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { createBoard, touchKanbanPresence } from '@wrongstack/kanban';
import { addTask, updateTaskAssignment } from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rebindSessionKanbanTask } from '../src/session-kanban.js';

/** Session that owns the board events these tests write. */
const TEST_CONTEXT_SESSION_ID = '2026-08-26/sess_01TESTTOOLSCONTEXT0000000';

/**
 * A resumed session must come back knowing which card it is on.
 *
 * The `start_task` binding lives in `ctx.meta.kanban` — conversation state that
 * nothing restores. So after a restart the card still sat in Running on the
 * board while the run had no binding: file events lost their task attribution,
 * and under `tools.kanbanGovernance` the session was un-bound until the model
 * happened to call `start_task` again.
 *
 * Board presence is the durable anchor — keyed `<sessionId>:<agentId>`,
 * carrying the taskId, stored on the board record.
 */
describe('rebindSessionKanbanTask', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-rebind-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const futureLease = () => new Date(Date.now() + 15 * 60_000).toISOString();

  function makeCtx(sessionId: string, overrides: Partial<Context> = {}) {
    const setCurrentKanbanTask = vi.fn();
    const ctx = {
      eventSessionId: () => TEST_CONTEXT_SESSION_ID,
      projectRoot: dir,
      session: { id: sessionId },
      setCurrentKanbanTask,
      ...overrides,
    } as unknown as Context;
    return { ctx, setCurrentKanbanTask };
  }

  async function seedRunningCard(sessionId: string, opts: { leaseExpiresAt?: string } = {}) {
    const board = await createBoard(dir, {
      title: 'Project board',
      columns: [{ id: 'todo', title: 'Todo', order: 0 }],
    });
    const added = await addTask(dir, board.id, { title: 'Work in flight' });
    const taskId = added!.task.id;
    await updateTaskAssignment(dir, board.id, taskId, {
      status: 'running',
      agentId: 'agent-1',
      leaseId: 'lease-1',
      leaseExpiresAt: opts.leaseExpiresAt ?? futureLease(),
    });
    await touchKanbanPresence(dir, board.id, { sessionId, agentId: 'agent-1', taskId });
    return { boardId: board.id, taskId };
  }

  it('rebinds the running card this session was last seen on', async () => {
    const { boardId, taskId } = await seedRunningCard('session-a');
    const { ctx, setCurrentKanbanTask } = makeCtx('session-a');

    const result = await rebindSessionKanbanTask(ctx);

    expect(result).toEqual({ boardId, taskId });
    expect(setCurrentKanbanTask).toHaveBeenCalledWith(taskId, boardId);
  });

  it('ignores a card another session was working', async () => {
    await seedRunningCard('session-a');
    const { ctx, setCurrentKanbanTask } = makeCtx('session-b');

    expect(await rebindSessionKanbanTask(ctx)).toBeNull();
    expect(setCurrentKanbanTask).not.toHaveBeenCalled();
  });

  it('skips an expired lease, which recover_stale may have reassigned', async () => {
    await seedRunningCard('session-a', {
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const { ctx, setCurrentKanbanTask } = makeCtx('session-a');

    expect(await rebindSessionKanbanTask(ctx)).toBeNull();
    expect(setCurrentKanbanTask).not.toHaveBeenCalled();
  });

  it('never overrides a binding this process already has', async () => {
    await seedRunningCard('session-a');
    const { ctx, setCurrentKanbanTask } = makeCtx('session-a', {
      currentKanbanTaskId: 'already-bound',
    } as Partial<Context>);

    expect(await rebindSessionKanbanTask(ctx)).toBeNull();
    expect(setCurrentKanbanTask).not.toHaveBeenCalled();
  });

  it('does nothing when the session has no running card', async () => {
    const board = await createBoard(dir, {
      title: 'Idle board',
      columns: [{ id: 'todo', title: 'Todo', order: 0 }],
    });
    const added = await addTask(dir, board.id, { title: 'Never started' });
    await touchKanbanPresence(dir, board.id, {
      sessionId: 'session-a',
      agentId: 'agent-1',
      taskId: added!.task.id,
    });
    const { ctx, setCurrentKanbanTask } = makeCtx('session-a');

    expect(await rebindSessionKanbanTask(ctx)).toBeNull();
    expect(setCurrentKanbanTask).not.toHaveBeenCalled();
  });

  it('is a no-op without a session id', async () => {
    await seedRunningCard('session-a');
    const setCurrentKanbanTask = vi.fn();
    const ctx = {
      eventSessionId: () => TEST_CONTEXT_SESSION_ID,
      projectRoot: dir,
      setCurrentKanbanTask,
    } as unknown as Context;

    expect(await rebindSessionKanbanTask(ctx)).toBeNull();
    expect(setCurrentKanbanTask).not.toHaveBeenCalled();
  });
});

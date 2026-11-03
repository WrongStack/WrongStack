import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addTask,
  createBoard,
  listKanbanEvents,
  TEST_EVENT_CONTEXT,
  updateTask,
} from '../src/test-support.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kanban-bound-context-'));
  roots.push(root);
  const board = await createBoard(root, { title: 'Bound session' });
  const added = await addTask(root, board.id, { title: 'Original title' });
  if (!added) throw new Error('Task fixture missing');
  return { root, boardId: board.id, taskId: added.task.id, updatedAt: added.task.updatedAt };
}

describe('session-bound updateTask', () => {
  it('accepts an omitted context and attributes the change to the test session', async () => {
    const { root, boardId, taskId } = await fixture();
    const board = await updateTask(root, boardId, taskId, { title: 'Edited title' });
    expect(board?.tasks[0]?.title).toBe('Edited title');
    const events = await listKanbanEvents(root, boardId);
    expect(events.at(-1)?.sessionId).toBe(TEST_EVENT_CONTEXT.sessionId);
  });

  it('binds an undefined context while preserving optimistic concurrency options', async () => {
    const { root, boardId, taskId, updatedAt } = await fixture();
    await expect(
      updateTask(root, boardId, taskId, { title: 'Edited title' }, undefined, {
        expectedUpdatedAt: updatedAt,
      }),
    ).resolves.toMatchObject({ tasks: [expect.objectContaining({ title: 'Edited title' })] });
    await expect(
      updateTask(root, boardId, taskId, { title: 'Stale edit' }, undefined, {
        expectedUpdatedAt: 'stale-version',
      }),
    ).rejects.toThrow('KANBAN_TASK_CONFLICT');
  });

  it('preserves explicit attribution and options', async () => {
    const { root, boardId, taskId, updatedAt } = await fixture();
    await updateTask(
      root,
      boardId,
      taskId,
      { title: 'Explicit session edit' },
      { sessionId: 'explicit-test-session' },
      { expectedUpdatedAt: updatedAt },
    );
    const events = await listKanbanEvents(root, boardId);
    expect(events.at(-1)?.sessionId).toBe('explicit-test-session');
  });
});

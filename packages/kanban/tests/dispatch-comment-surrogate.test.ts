import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeProjectFixtureDirectory } from './helpers/remove-fixture-directory.js';
import {
  addTask,
  completeKanbanDispatch,
  createBoard,
  getBoard,
  reserveKanbanDispatch,
  startKanbanDispatch,
  transitionTask,
  updateTask,
} from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-dispatch-surrogate-'));
});

afterEach(async () => {
  await removeProjectFixtureDirectory(tmpDir, { maxRetries: 5, retryDelay: 25 });
});

const COLS = [
  { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 },
  { id: 'todo', title: 'To Do', order: 1, wipLimit: 0 },
  { id: 'in-progress', title: 'In Progress', order: 2, wipLimit: 0 },
  { id: 'review', title: 'Review', order: 3, wipLimit: 0 },
  { id: 'done', title: 'Done', order: 4, wipLimit: 0 },
];

async function completeManagedDispatch(result: string): Promise<string | undefined> {
  const board = await createBoard(tmpDir, {
    title: 'Managed',
    columns: COLS,
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
  const added = await addTask(tmpDir, board.id, {
    title: 'Managed Task',
    description: 'Detailed scope.',
  });
  const taskId = added!.task.id;
  await updateTask(tmpDir, board.id, taskId, {
    assignee: 'agent-1',
    dueDate: '2027-12-01T00:00:00.000Z',
    labels: ['test'],
    childTaskIds: ['child-1'],
    successCriteria: [{ id: 'c1', description: 'Pass', type: 'manual', status: 'pending' }],
  });
  await transitionTask(tmpDir, board.id, taskId, { to: 'todo', actor: 'agent', comment: 'Ready.' });
  const reserved = await reserveKanbanDispatch(tmpDir, { boardId: board.id });
  expect(reserved).not.toBeNull();
  await startKanbanDispatch(tmpDir, {
    boardId: board.id,
    taskId,
    leaseId: reserved!.lease.leaseId,
    actor: 'agent',
  });
  const completed = await completeKanbanDispatch(tmpDir, {
    boardId: board.id,
    taskId,
    leaseId: reserved!.lease.leaseId,
    actor: 'agent',
    result,
  });
  expect(completed?.task.lifecycle?.currentStage).toBe('review');
  const persisted = await getBoard(tmpDir, board.id);
  const history = persisted?.tasks.find((task) => task.id === taskId)?.lifecycle?.history;
  const last = history?.at(-1);
  expect(last?.to).toBe('review');
  return last?.comment;
}

/**
 * F1481: the managed running -> review transition records the worker result as
 * its comment, cut to 1000 UTF-16 code units. A raw slice that ends between the
 * halves of a surrogate pair persisted a lone high surrogate in the card's
 * lifecycle history.
 */
describe('completeKanbanDispatch comment cut (F1481)', () => {
  it('never persists a lone surrogate when the 1000-unit cut falls inside an astral character', async () => {
    const emoji = String.fromCodePoint(0x1f600);
    const comment = await completeManagedDispatch(`${'a'.repeat(999)}${emoji} more output`);
    expect(comment).toBe('a'.repeat(999));
    expect(comment?.isWellFormed()).toBe(true);
  });

  it('keeps an astral character that ends exactly at the limit', async () => {
    const emoji = String.fromCodePoint(0x1f600);
    const comment = await completeManagedDispatch(`${'a'.repeat(998)}${emoji}tail`);
    expect(comment).toBe(`${'a'.repeat(998)}${emoji}`);
  });

  it('still cuts plain text at 1000 code units', async () => {
    const comment = await completeManagedDispatch(`${'a'.repeat(1000)}${'b'.repeat(20)}`);
    expect(comment).toBe('a'.repeat(1000));
  });
});

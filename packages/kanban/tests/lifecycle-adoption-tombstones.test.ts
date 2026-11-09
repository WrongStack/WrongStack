import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createManagedLifecyclePolicy } from '../src/manager/lifecycle.js';
import {
  addTask,
  adoptManagedLifecycle,
  createBoard,
  getBoard,
  listReadyTasks,
} from './helpers/session-manager.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kanban-adoption-tombstones-'));
  roots.push(root);
  const board = await createBoard(root, { title: 'Legacy work' });
  return { root, boardId: board.id };
}

const adoption = {
  columns: createManagedLifecyclePolicy().columns,
  actor: 'operator',
  comment: 'Adopt existing live work.',
};

it.each(['backlog', 'todo', 'in-progress', 'review'])(
  'preserves an archived legacy card in %s without making it claimable',
  async (columnId) => {
    const { root, boardId } = await fixture();
    const added = await addTask(root, boardId, {
      id: 'retired',
      title: 'Retired work',
      status: 'archived',
      columnId,
      description: 'Complete specification',
      assignee: 'worker',
      dueDate: '2026-12-31T00:00:00Z',
      labels: ['archived'],
      successCriteria: [
        { id: 'c1', description: 'Reviewed output', type: 'manual', status: 'pending' },
      ],
    });
    if (!added) throw new Error('Archived task was not created');
    const before = (await getBoard(root, boardId))?.tasks.find((task) => task.id === 'retired');
    expect(before?.status).toBe('archived');
    await adoptManagedLifecycle(root, boardId, adoption);
    expect((await getBoard(root, boardId))?.tasks.find((task) => task.id === 'retired')).toEqual(
      before,
    );
    expect(
      (await listReadyTasks(root, { boardId })).some((entry) => entry.task.id === 'retired'),
    ).toBe(false);
  },
);

it('adopts live cards and preserves tombstones on repeated adoption', async () => {
  const { root, boardId } = await fixture();
  await addTask(root, boardId, { id: 'live', title: 'Live work', status: 'pending' });
  await addTask(root, boardId, { id: 'retired', title: 'Retired work', status: 'archived' });
  const before = (await getBoard(root, boardId))?.tasks.find((task) => task.id === 'retired');
  for (let attempt = 0; attempt < 2; attempt++) {
    const adopted = await adoptManagedLifecycle(root, boardId, adoption);
    expect(adopted?.lifecycle?.mode).toBe('managed');
    expect(adopted?.tasks.find((task) => task.id === 'live')?.lifecycle?.currentStage).toBe(
      'backlog',
    );
    expect(adopted?.tasks.find((task) => task.id === 'retired')).toEqual(before);
  }
});

it('control: keeps the established normalization of archived legacy Done cards', async () => {
  const { root, boardId } = await fixture();
  await addTask(root, boardId, {
    id: 'old-done',
    title: 'Finished work',
    status: 'archived',
    columnId: 'done',
  });
  const adopted = await adoptManagedLifecycle(root, boardId, adoption);
  expect(adopted?.tasks.find((task) => task.id === 'old-done')).toMatchObject({
    id: 'old-done',
    status: 'completed',
    columnId: 'done',
    lifecycle: { currentStage: 'done' },
  });
  expect(
    (await listReadyTasks(root, { boardId })).some((entry) => entry.task.id === 'old-done'),
  ).toBe(false);
});

it('control: adopts an active legacy card without changing its identity', async () => {
  const { root, boardId } = await fixture();
  await addTask(root, boardId, {
    id: 'live',
    title: 'Live work',
    status: 'ready',
    columnId: 'todo',
  });
  const adopted = await adoptManagedLifecycle(root, boardId, adoption);
  expect(adopted?.tasks.find((task) => task.id === 'live')).toMatchObject({
    id: 'live',
    status: 'ready',
    columnId: 'todo',
    lifecycle: { currentStage: 'todo' },
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { managementTaskVersion } from '../src/management-fence.js';
import type { UpdateKanbanGoalMetricInput } from '../src/types-operations.js';
import {
  addGoalMetricToTask,
  addTask,
  claimBoardManagement,
  createBoard,
  getBoard,
  renewBoardManagement,
  updateGoalMetricOnTask,
} from './helpers/session-manager.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kanban-manager-metrics-'));
  roots.push(root);
  const board = await createBoard(root, { title: 'Metric review' });
  const added = await addTask(root, board.id, {
    title: 'Active task',
    goalMetrics: [
      {
        id: 'metric-1',
        name: 'Coverage',
        status: 'pending',
        target: 10,
        current: 1,
        direction: 'at_least',
        unit: 'cases',
        notes: 'Initial',
        updatedAt: '2000-01-01T00:00:00Z',
      },
    ],
  });
  if (!added) throw new Error('Task was not created');
  expect(
    await claimBoardManagement(root, board.id, {
      token: 'manager',
      fingerprint: 'review',
      cooldownMs: 0,
    }),
  ).toBe(true);
  const read = await getBoard(root, board.id);
  const task = read?.tasks.find((entry) => entry.id === added.task.id);
  if (!read || !task) throw new Error('Board was not persisted');
  return {
    root,
    boardId: board.id,
    taskId: task.id,
    fence: {
      sessionId: 'manager-session',
      expectedManagementToken: 'manager',
      expectedManagementTaskVersions: { [task.id]: managementTaskVersion(read, task) },
    },
  };
}

const changes: Array<[string, UpdateKanbanGoalMetricInput]> = [
  ['target', { target: 20 }],
  ['current', { current: 2 }],
  ['name', { name: 'Revised coverage' }],
  ['status', { status: 'met' }],
  ['direction', { direction: 'at_most' }],
  ['unit', { unit: 'percent' }],
  ['notes', { notes: 'Human clarification' }],
];

it.each(changes)(
  'rejects a stale manager after a human changes metric %s',
  async (_field, patch) => {
    const { root, boardId, taskId, fence } = await fixture();
    await updateGoalMetricOnTask(root, boardId, taskId, 'metric-1', patch);
    const before = await getBoard(root, boardId);
    await expect(
      updateGoalMetricOnTask(root, boardId, taskId, 'metric-1', { target: 99 }, fence),
    ).rejects.toThrow('changed');
    expect(await getBoard(root, boardId)).toEqual(before);
  },
);

it('invalidates an older read when a human adds a metric', async () => {
  const { root, boardId, taskId, fence } = await fixture();
  await addGoalMetricToTask(root, boardId, taskId, { name: 'Latency', target: 50 });
  const before = await getBoard(root, boardId);
  await expect(
    updateGoalMetricOnTask(root, boardId, taskId, 'metric-1', { target: 99 }, fence),
  ).rejects.toThrow('changed');
  expect(await getBoard(root, boardId)).toEqual(before);
});

it('allows a fresh manager read and ignores metric timestamp-only refreshes and lease renewal', async () => {
  const { root, boardId, taskId, fence } = await fixture();
  await updateGoalMetricOnTask(root, boardId, taskId, 'metric-1', { current: 1 });
  await renewBoardManagement(root, boardId, 'manager');
  expect(
    await updateGoalMetricOnTask(root, boardId, taskId, 'metric-1', { target: 12 }, fence),
  ).not.toBeNull();
  const stored = await getBoard(root, boardId);
  expect(stored?.tasks.find((task) => task.id === taskId)?.goalMetrics?.[0]?.target).toBe(12);
});

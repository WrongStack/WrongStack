import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutateBoard } from '../src/storage.js';
import {
  addGoalMetricToTask,
  addTask,
  createBoard,
  createManagedLifecyclePolicy,
  getBoard,
  updateGoalMetricOnTask,
} from './helpers/session-manager.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-done-metric-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(managed = true) {
  const board = await createBoard(root, {
    title: 'Accepted metric definition',
    ...(managed ? { lifecycle: createManagedLifecyclePolicy() } : {}),
  });
  const added = await addTask(root, board.id, {
    title: 'Accepted work',
    description: 'Original scope',
    goalMetrics: [{ id: 'metric', name: 'Coverage', target: 1, current: 1, status: 'met' }],
  });
  if (!added) throw new Error('Fixture task missing');
  // Match persisted Done fixtures used by concurrent-contract.test.ts.
  await mutateBoard(root, board.id, (current) => {
    const task = current.tasks[0];
    if (!task) throw new Error('Fixture task missing');
    task.status = 'completed';
    task.columnId = current.lifecycle?.columns.done ?? 'done';
    if (managed)
      task.lifecycle = { currentStage: 'done', stageEnteredAt: task.updatedAt, history: [] };
  });
  return { boardId: board.id, taskId: added.task.id };
}

describe('goal metric writes on accepted managed work', () => {
  it.each([
    { target: 2 },
    { current: 0 },
    { direction: 'at_most' as const },
    { name: 'Changed metric' },
    { unit: '%' },
  ])('rejects definition change %j atomically', async (patch) => {
    const { boardId, taskId } = await fixture();
    const before = await getBoard(root, boardId);
    await expect(updateGoalMetricOnTask(root, boardId, taskId, 'metric', patch)).rejects.toThrow(
      /Done acceptance contract is immutable/,
    );
    expect(await getBoard(root, boardId)).toEqual(before);
  });

  it('rejects adding a new metric atomically after Done', async () => {
    const { boardId, taskId } = await fixture();
    const before = await getBoard(root, boardId);
    await expect(
      addGoalMetricToTask(root, boardId, taskId, { name: 'New scope', target: 2 }),
    ).rejects.toThrow(/Done acceptance contract is immutable/);
    expect(await getBoard(root, boardId)).toEqual(before);
  });

  it('allows unchanged values and noncontract metric notes', async () => {
    const { boardId, taskId } = await fixture();
    const updated = await updateGoalMetricOnTask(root, boardId, taskId, 'metric', {
      target: 1,
      current: 1,
      notes: 'Audit context',
    });
    expect(updated?.tasks[0]?.goalMetrics?.[0]).toMatchObject({
      target: 1,
      current: 1,
      notes: 'Audit context',
    });
    expect(updated?.tasks[0]?.status).toBe('completed');
  });

  it('keeps legacy completed metrics editable', async () => {
    const { boardId, taskId } = await fixture(false);
    await updateGoalMetricOnTask(root, boardId, taskId, 'metric', { target: 2 });
    const updated = await addGoalMetricToTask(root, boardId, taskId, {
      name: 'Allowed legacy metric',
    });
    expect(updated?.tasks[0]?.goalMetrics).toHaveLength(2);
    expect(updated?.tasks[0]?.goalMetrics?.[0]?.target).toBe(2);
  });
});

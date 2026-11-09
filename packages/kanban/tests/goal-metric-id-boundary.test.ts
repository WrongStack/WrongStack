import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findGoalMetric } from '../src/manager/task-chain-internal.js';
import {
  addGoalMetricToTask,
  addTask,
  createBoard,
  getBoard,
  updateGoalMetricOnTask,
} from './helpers/session-manager.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const metric = { id: 'metric-1', name: 'Coverage', status: 'pending' as const };

describe('goal metric ID boundaries', () => {
  it.each(['', ' \t\n'])('does not resolve a blank ID %j at any metric count', (id) => {
    expect(findGoalMetric([], id)).toBeUndefined();
    expect(findGoalMetric([metric], id)).toBeUndefined();
    expect(findGoalMetric([metric, { ...metric, id: 'metric-2' }], id)).toBeUndefined();
  });

  it('preserves exact IDs, unique prefixes and ambiguous-prefix rejection', () => {
    expect(findGoalMetric([metric], 'metric-1')).toBe(metric);
    expect(findGoalMetric([metric], 'metric-')).toBe(metric);
    expect(findGoalMetric([metric], 'missing')).toBeUndefined();
    expect(() => findGoalMetric([metric, { ...metric, id: 'metric-2' }], 'metric-')).toThrow(
      'Ambiguous kanban goal metric id',
    );
  });

  it('refuses an empty update ID without changing persisted state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-metric-id-'));
    roots.push(root);
    const board = await createBoard(root, { title: 'Metric boundary' });
    const added = await addTask(root, board.id, { title: 'Coverage', columnId: 'backlog' });
    if (!added) throw new Error('Fixture task was not created');
    const withMetric = await addGoalMetricToTask(root, board.id, added.task.id, {
      name: 'Coverage',
      current: 50,
      target: 80,
    });
    const createdMetric = withMetric?.tasks.find((task) => task.id === added.task.id)
      ?.goalMetrics?.[0];
    if (!createdMetric) throw new Error('Fixture metric was not created');
    const valid = await updateGoalMetricOnTask(root, board.id, added.task.id, createdMetric.id, {
      current: 60,
    });
    expect(valid?.tasks.find((task) => task.id === added.task.id)?.goalMetrics?.[0]?.current).toBe(
      60,
    );
    const before = await getBoard(root, board.id);
    expect(await updateGoalMetricOnTask(root, board.id, added.task.id, '', { current: 99 })).toBe(
      null,
    );
    expect(await getBoard(root, board.id)).toEqual(before);
  });
});

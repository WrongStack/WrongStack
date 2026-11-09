import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KanbanAtomicityAssessment } from '../src/types.js';
import { createBoard, getBoard, listReadyTasks } from './helpers/session-manager.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-batch-atomicity-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const policy = {
  mode: 'enforce' as const,
  decomposition: 'propose' as const,
  config: {
    weights: {
      effort: 1,
      'file-scope': 1,
      'dependency-fan-in': 1,
      'single-verifiable-output': 1,
      'description-scope': 1,
    },
  },
};
const prerequisites = Array.from({ length: 6 }, (_, index) => ({
  id: `dependency-${index}-full`,
  title: `Dependency ${index}`,
  status: 'completed' as const,
}));

async function fixture(
  count: number,
  options: { prefixes?: boolean; assessment?: KanbanAtomicityAssessment } = {},
) {
  return createBoard(root, {
    title: 'Batch assessment',
    atomicity: policy,
    tasks: [
      ...prerequisites,
      {
        id: 'main',
        title: 'Scoped task',
        description: 'then then then',
        dependsOn: prerequisites
          .slice(0, count)
          .flatMap((task) =>
            options.prefixes ? [task.id.replace('-full', ''), task.id] : [task.id],
          ),
        ...(options.assessment ? { atomicityAssessment: options.assessment } : {}),
      },
    ],
  });
}

describe('batch creation assesses resolved dependency shapes', () => {
  it.each([
    [0, 0.62, 'borderline'],
    [3, 0.62, 'borderline'],
    [4, 0.553, 'borderline'],
    [6, 0.42, 'needs_decomposition'],
  ] as const)(
    'scores %s dependencies at the actual fan-in boundary',
    async (count, score, verdict) => {
      const created = await fixture(count);
      const stored = await getBoard(root, created.id);
      const main = stored?.tasks.find((task) => task.id === 'main');
      expect(main?.atomicityAssessment?.score).toBe(score);
      expect(main?.atomicityAssessment?.verdict).toBe(verdict);
      const ready = await listReadyTasks(root, { boardId: created.id });
      expect(ready.some((entry) => entry.task.id === 'main')).toBe(
        verdict !== 'needs_decomposition',
      );
    },
  );

  it('scores canonical deduplicated dependencies rather than raw references', async () => {
    const created = await fixture(6, { prefixes: true });
    const stored = await getBoard(root, created.id);
    const main = stored?.tasks.find((task) => task.id === 'main');
    expect(main?.dependsOn).toEqual(prerequisites.map((task) => task.id));
    expect(main?.atomicityAssessment?.score).toBe(0.42);
    expect(main?.atomicityAssessment?.verdict).toBe('needs_decomposition');
  });

  it('preserves an explicitly supplied assessment', async () => {
    const assessment: KanbanAtomicityAssessment = {
      verdict: 'atomic',
      score: 0.9,
      criteria: [],
      assessedAt: '2026-01-01T00:00:00.000Z',
      assessedBy: 'human',
    };
    const board = await fixture(6, { assessment });
    expect(board.tasks.find((task) => task.id === 'main')?.atomicityAssessment).toEqual(assessment);
  });

  it('keeps automatic assessment disabled when board policy is off', async () => {
    const board = await createBoard(root, {
      title: 'Disabled assessment',
      atomicity: { mode: 'off', decomposition: 'propose' },
      tasks: [{ id: 'main', title: 'No assessment' }],
    });
    expect(board.tasks[0]?.atomicityAssessment).toBeUndefined();
  });
});

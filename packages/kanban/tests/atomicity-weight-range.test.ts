import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { assessAtomicity } from '../src/atomicity/assess.js';
import type { AtomicityCandidate } from '../src/atomicity/criteria.js';
import { addTask, createBoard, getBoard, listReadyTasks } from './helpers/session-manager.js';

const ids = [
  'effort',
  'file-scope',
  'dependency-fan-in',
  'single-verifiable-output',
  'description-scope',
];
const weights = (scale: number) => Object.fromEntries(ids.map((id) => [id, scale]));
const candidate: AtomicityCandidate = {
  title: 'Scoped task',
  description: 'then then then',
  dependencyCount: 6,
  successCriteriaCount: 0,
  hasVerifiableOutput: false,
  childCount: 0,
};

it.each([1, 1e308, Number.MIN_VALUE])(
  'keeps proportional equal weights stable at scale %s',
  (scale) => {
    const result = assessAtomicity(candidate, { weights: weights(scale) });
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBe(0.42);
    expect(result.verdict).toBe('needs_decomposition');
  },
);

it('preserves the built-in rule fallback when all weights are zero', () => {
  const normal = assessAtomicity(candidate);
  const fallback = assessAtomicity(candidate, { weights: weights(0) });
  expect(fallback.score).toBe(normal.score);
  expect(fallback.verdict).toBe(normal.verdict);
  expect(fallback.criteria).toEqual(normal.criteria);
});

it('does not round a single subnormal-weighted axis up to a perfect score', () => {
  const result = assessAtomicity(candidate, {
    weights: { ...weights(0), effort: Number.MIN_VALUE },
  });
  expect(result.score).toBe(0.6);
  expect(result.verdict).toBe('borderline');
});

it('persists finite assessments and keeps decomposition-required work out of the ready queue', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-weight-range-'));
  try {
    const prerequisites = Array.from({ length: 6 }, (_, index) => ({
      id: `dependency-${index}`,
      title: `Dependency ${index}`,
      status: 'completed' as const,
    }));
    const board = await createBoard(root, {
      title: 'Enforced atomicity',
      tasks: prerequisites,
      atomicity: { mode: 'enforce', decomposition: 'propose', config: { weights: weights(1e308) } },
    });
    const added = await addTask(root, board.id, {
      title: candidate.title,
      description: candidate.description,
      dependsOn: prerequisites.map((task) => task.id),
    });
    if (!added) throw new Error('Fixture task missing');
    const stored = await getBoard(root, board.id);
    const task = stored?.tasks.find((entry) => entry.id === added.task.id);
    expect(task?.atomicityAssessment?.score).toBe(0.42);
    expect(task?.atomicityAssessment?.verdict).toBe('needs_decomposition');
    const ready = await listReadyTasks(root, { boardId: board.id });
    expect(ready.some((entry) => entry.task.id === added.task.id)).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

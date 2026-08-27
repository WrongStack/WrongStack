import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AtomicityCandidate } from '../src/atomicity/index.js';
import {
  assessAtomicity,
  candidateFromKanbanTask,
  countScopeMarkers,
  hashAtomicityConfig,
  resolveAtomicityConfig,
} from '../src/atomicity/index.js';
import { readKanbanEvents } from '../src/storage.js';
import type { KanbanTask } from '../src/types.js';
import {
  addTask,
  assessTaskAtomicity,
  createBoard,
  listReadyTasks,
  splitTask,
} from './helpers/session-manager.js';

function candidate(overrides: Partial<AtomicityCandidate> = {}): AtomicityCandidate {
  return {
    title: 'Fix the login bug',
    dependencyCount: 0,
    successCriteriaCount: 1,
    hasVerifiableOutput: true,
    childCount: 0,
    ...overrides,
  };
}

describe('assessAtomicity', () => {
  it('scores a small verifiable task as atomic', () => {
    const assessment = assessAtomicity(candidate({ estimatedHours: 2 }));
    expect(assessment.verdict).toBe('atomic');
    expect(assessment.score).toBeGreaterThanOrEqual(0.7);
    expect(assessment.assessedBy).toBe('rules');
    expect(assessment.criteria.length).toBeGreaterThan(0);
  });

  it('is deterministic for identical input and config', () => {
    const input = candidate({ estimatedHours: 3, dependencyCount: 1 });
    const a = assessAtomicity(input);
    const b = assessAtomicity(input);
    expect(a.verdict).toBe(b.verdict);
    expect(a.score).toBe(b.score);
    expect(a.criteria).toEqual(b.criteria);
    expect(a.configHash).toBe(b.configHash);
  });

  it('returns needs_decomposition for a large, vague, unverifiable task', () => {
    const assessment = assessAtomicity(
      candidate({
        title: 'Build auth and then add billing; also migrate the database and update docs',
        description:
          '1. add login\n2. add signup\n3. add billing plans and then invoices; after that migrate schema',
        estimatedHours: 24,
        dependencyCount: 6,
        expectedFileChangeCount: 30,
        successCriteriaCount: 0,
        hasVerifiableOutput: false,
      }),
    );
    expect(assessment.verdict).toBe('needs_decomposition');
    expect(assessment.score).toBeLessThan(0.45);
  });

  it('hard-overrides to composite when the task already has children', () => {
    const assessment = assessAtomicity(
      candidate({ childCount: 3, estimatedHours: 100, successCriteriaCount: 0 }),
    );
    expect(assessment.verdict).toBe('composite');
    expect(assessment.criteria).toHaveLength(1);
    expect(assessment.criteria[0]?.id).toBe('already-decomposed');
  });

  it('returns borderline between the thresholds', () => {
    // No estimate (0.6), no file scope (0.7), no criteria (0.3) pull the
    // weighted score into the borderline band.
    const assessment = assessAtomicity(
      candidate({ successCriteriaCount: 0, hasVerifiableOutput: false }),
    );
    expect(assessment.verdict).toBe('borderline');
    expect(assessment.score).toBeGreaterThanOrEqual(0.45);
    expect(assessment.score).toBeLessThan(0.7);
  });

  it('honors config threshold and weight overrides', () => {
    const input = candidate({ estimatedHours: 2 });
    const strict = assessAtomicity(input, { atomicThreshold: 0.99, decomposeThreshold: 0.98 });
    expect(strict.verdict).not.toBe('atomic');

    const effortOnly = assessAtomicity(candidate({ estimatedHours: 40 }), {
      weights: {
        effort: 1,
        'file-scope': 0,
        'dependency-fan-in': 0,
        'single-verifiable-output': 0,
        'description-scope': 0,
      },
    });
    expect(effortOnly.verdict).toBe('needs_decomposition');

    // Zeroing every weight expresses no opinion at all. It must not collapse to
    // the most permissive verdict — that would silently switch decomposition
    // off for an obviously over-sized task.
    const allZero = assessAtomicity(candidate({ estimatedHours: 40 }), {
      weights: {
        effort: 0,
        'file-scope': 0,
        'dependency-fan-in': 0,
        'single-verifiable-output': 0,
        'description-scope': 0,
      },
    });
    expect(allZero.verdict).toBe(assessAtomicity(candidate({ estimatedHours: 40 })).verdict);
    expect(allZero.verdict).not.toBe('atomic');
    expect(Number.isFinite(allZero.score)).toBe(true);
  });

  it('penalizes effort above the ceiling but stays atomic at the boundary', () => {
    const atBoundary = assessAtomicity(candidate({ estimatedHours: 4 }));
    const above = assessAtomicity(candidate({ estimatedHours: 8 }));
    expect(atBoundary.score).toBeGreaterThan(above.score);
  });

  it('changes configHash when config changes', () => {
    expect(hashAtomicityConfig()).toBe(hashAtomicityConfig());
    expect(hashAtomicityConfig()).not.toBe(hashAtomicityConfig({ maxEstimatedHours: 9 }));
  });
});

describe('countScopeMarkers', () => {
  it('counts conjunctions and enumerations', () => {
    expect(countScopeMarkers('Do X')).toBe(0);
    expect(countScopeMarkers('Do X then Y; after that Z')).toBeGreaterThanOrEqual(3);
    expect(countScopeMarkers('- item one\n- item two\n1. three')).toBe(3);
  });
});

describe('resolveAtomicityConfig', () => {
  it('applies defaults and overrides', () => {
    const resolved = resolveAtomicityConfig({ maxEstimatedHours: 6 });
    expect(resolved.maxEstimatedHours).toBe(6);
    expect(resolved.atomicThreshold).toBe(0.7);
    expect(resolved.decomposeThreshold).toBe(0.45);
  });
});

describe('candidateFromKanbanTask', () => {
  it('maps task fields including deterministic-check detection', () => {
    const now = new Date().toISOString();
    const task: KanbanTask = {
      id: 't1',
      title: 'Task',
      description: 'Desc',
      columnId: 'backlog',
      order: 0,
      priority: 'medium',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      estimatedHours: 3,
      dependsOn: ['a', 'b'],
      childTaskIds: ['c'],
      expectedFileChanges: [{ path: 'src/x.ts', operation: 'modify' }],
      successCriteria: [
        { id: 'c1', description: 'manual look', type: 'manual', status: 'pending' },
        { id: 'c2', description: 'tests pass', type: 'test', status: 'pending' },
      ],
    };
    const mapped = candidateFromKanbanTask(task);
    expect(mapped).toMatchObject({
      title: 'Task',
      estimatedHours: 3,
      dependencyCount: 2,
      expectedFileChangeCount: 1,
      successCriteriaCount: 2,
      hasVerifiableOutput: true,
      childCount: 1,
    });

    const manualOnly = candidateFromKanbanTask({
      ...task,
      successCriteria: [task.successCriteria![0]!],
    });
    expect(manualOnly.hasVerifiableOutput).toBe(false);
  });
});

describe('board integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-atomicity-'));
  });

  it('stamps an assessment on addTask by default and skips when mode is off', async () => {
    const board = await createBoard(tmpDir, { title: 'Default board' });
    const added = await addTask(tmpDir, board.id, { title: 'Small task', estimatedHours: 1 });
    expect(added?.task.atomicityAssessment).toBeDefined();
    expect(added?.task.atomicityAssessment?.verdict).toBeDefined();

    const offBoard = await createBoard(tmpDir, {
      title: 'Off board',
      atomicity: { mode: 'off', decomposition: 'auto' },
    });
    const offAdded = await addTask(tmpDir, offBoard.id, { title: 'Small task' });
    expect(offAdded?.task.atomicityAssessment).toBeUndefined();
  });

  it('re-stamps parent as composite and stamps children on splitTask', async () => {
    const board = await createBoard(tmpDir, { title: 'Split board' });
    const added = await addTask(tmpDir, board.id, { title: 'Big task', estimatedHours: 20 });
    expect(added).not.toBeNull();
    const split = await splitTask(tmpDir, board.id, added!.task.id, {
      titles: ['Part one', 'Part two'],
    });
    expect(split).not.toBeNull();
    expect(split!.parent.atomicityAssessment?.verdict).toBe('composite');
    for (const child of split!.children) {
      expect(child.atomicityAssessment).toBeDefined();
      expect(child.atomicityAssessment?.verdict).not.toBe('composite');
    }
  });

  it('enforce mode blocks childless needs_decomposition leaves from readiness', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Enforce board',
      atomicity: { mode: 'enforce', decomposition: 'propose' },
    });
    const big = await addTask(tmpDir, board.id, {
      title: 'Build auth and then billing; also migrate the database and then update docs',
      description: '1. login\n2. signup\n3. billing; after that migrate schema as well as docs',
      estimatedHours: 40,
    });
    expect(big!.task.atomicityAssessment?.verdict).toBe('needs_decomposition');

    const readyBefore = await listReadyTasks(tmpDir, { boardId: board.id });
    expect(readyBefore.some((entry) => entry.task.id === big!.task.id)).toBe(false);

    const split = await splitTask(tmpDir, board.id, big!.task.id, {
      titles: ['Add login', 'Add billing'],
    });
    const readyAfter = await listReadyTasks(tmpDir, { boardId: board.id });
    const childIds = new Set(split!.children.map((child) => child.id));
    expect(readyAfter.some((entry) => childIds.has(entry.task.id))).toBe(true);
  });

  it('assessTaskAtomicity persists the assessment and emits an event', async () => {
    const board = await createBoard(tmpDir, { title: 'Assess board' });
    const added = await addTask(tmpDir, board.id, { title: 'Some task' });
    const result = await assessTaskAtomicity(tmpDir, board.id, added!.task.id, {
      assessedBy: 'agent',
    });
    expect(result).not.toBeNull();
    expect(result!.assessment.assessedBy).toBe('agent');
    expect(result!.task.atomicityAssessment).toEqual(result!.assessment);

    const events = await readKanbanEvents(tmpDir, board.id);
    const assessed = events.filter((event) => event.type === 'task.atomicity.assessed');
    expect(assessed.length).toBe(1);
    expect((assessed[0]?.after as { verdict?: string } | undefined)?.verdict).toBe(
      result!.assessment.verdict,
    );
  });
});

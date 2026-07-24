import { describe, expect, it } from 'vitest';
import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import {
  buildTaskTree,
  flattenTaskTree,
  selectVerificationSummary,
  verificationStateOf,
} from '../../src/lib/kanban-verification';

let seq = 0;
function task(overrides: Partial<KanbanTask> = {}): KanbanTask {
  seq += 1;
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `t-${seq}`,
    title: `Task ${seq}`,
    columnId: 'backlog',
    order: seq,
    priority: 'medium',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as KanbanTask;
}

function board(tasks: KanbanTask[]): KanbanBoard {
  const now = new Date().toISOString();
  return {
    id: 'b-1',
    title: 'Board',
    columns: [{ id: 'backlog', title: 'Backlog', order: 0 }],
    tasks,
    createdAt: now,
    updatedAt: now,
    version: 1,
  } as KanbanBoard;
}

function report(verdict: 'passed' | 'failed' | 'needs_human' | 'incomplete') {
  return {
    taskId: 't',
    taskTitle: 'T',
    boardId: 'b-1',
    startedAt: '',
    completedAt: '',
    verdict,
    checks: [],
    markdownSummary: '',
    attachments: [],
  };
}

describe('verificationStateOf', () => {
  it('maps activity, report verdict, and absence correctly', () => {
    const plain = task();
    expect(verificationStateOf(plain)).toBe('unverified');
    expect(verificationStateOf(plain, { startedAt: 1 })).toBe('running');
    expect(verificationStateOf(task({ verificationReport: report('passed') }))).toBe('passed');
    expect(verificationStateOf(task({ verificationReport: report('needs_human') }))).toBe(
      'needs_human',
    );
  });
});

describe('selectVerificationSummary', () => {
  it('counts graded verdicts, failing checks, and decomposition state', () => {
    const failedCheck = {
      checkId: 'c1',
      description: 'broken',
      type: 'test' as const,
      status: 'failed' as const,
      evidence: {},
    };
    const unbackedAgentCheck = {
      checkId: 'c2',
      description: 'agent says ok',
      type: 'agent' as const,
      status: 'passed' as const,
      evidence: {},
    };
    const summary = selectVerificationSummary(
      board([
        task({ status: 'completed', verificationReport: { ...report('passed'), checks: [] } }),
        task({
          status: 'review',
          verificationReport: { ...report('failed'), checks: [failedCheck, unbackedAgentCheck] },
        }),
        task({ status: 'completed' }), // graded but unverified
        task({
          status: 'pending',
          atomicityAssessment: {
            verdict: 'needs_decomposition',
            score: 0.2,
            criteria: [],
            assessedAt: '',
            assessedBy: 'rules',
          },
        }),
        task({
          status: 'pending',
          decomposition: {
            id: 'p1',
            taskId: 'x',
            status: 'proposed',
            mode: 'approval',
            proposedSubtasks: [],
            proposedAt: '',
          },
        }),
        task({ status: 'archived' }), // ignored entirely
      ]),
    );
    expect(summary.gradedTasks).toBe(3);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.unverified).toBe(1);
    expect(summary.failingChecks).toHaveLength(1);
    expect(summary.missingEvidence).toHaveLength(1);
    expect(summary.needsDecomposition).toHaveLength(1);
    expect(summary.pendingProposals).toHaveLength(1);
  });
});

describe('buildTaskTree', () => {
  it('builds the parent/child forest and flattens depth-first', () => {
    const parent = task({ id: 'p', childTaskIds: ['c1', 'c2'] });
    const childOne = task({ id: 'c1', parentTaskId: 'p', childTaskIds: ['g1'] });
    const childTwo = task({ id: 'c2', parentTaskId: 'p' });
    const grandchild = task({ id: 'g1', parentTaskId: 'c1' });
    const loner = task({ id: 'solo' });
    const tree = buildTaskTree(board([parent, childOne, childTwo, grandchild, loner]));
    expect(tree.map((node) => node.task.id)).toEqual(['p', 'solo']);
    const rows = flattenTaskTree(tree);
    expect(rows.map((row) => `${row.depth}:${row.task.id}`)).toEqual([
      '0:p',
      '1:c1',
      '2:g1',
      '1:c2',
      '0:solo',
    ]);
  });

  it('breaks cycles instead of hanging', () => {
    const a = task({ id: 'a', childTaskIds: ['b'], parentTaskId: 'b' });
    const b = task({ id: 'b', childTaskIds: ['a'], parentTaskId: 'a' });
    const tree = buildTaskTree(board([a, b]));
    // Both have (resolvable) parents → no roots; must not infinite-loop.
    expect(tree).toEqual([]);
  });
});

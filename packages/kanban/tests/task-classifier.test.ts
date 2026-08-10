import { describe, expect, it } from 'vitest';
import { validateManagedTaskTransition } from '../src/manager/lifecycle.js';
import { classifyTaskForQueue } from '../src/manager/task-classifier.js';
import type { KanbanBoard, KanbanTask } from '../src/types.js';

const NOW = '2026-08-01T00:00:00.000Z';
const FUTURE = '2026-08-01T00:10:00.000Z';
const PAST = '2026-07-31T23:59:00.000Z';

function board(overrides: Partial<KanbanBoard> = {}): KanbanBoard {
  return {
    id: 'board-1',
    title: 'Board',
    columns: [
      { id: 'backlog', title: 'Backlog', order: 0 },
      { id: 'todo', title: 'Todo', order: 1 },
      { id: 'in-progress', title: 'Running', order: 2 },
      { id: 'review', title: 'Review', order: 3 },
      { id: 'done', title: 'Done', order: 4 },
    ],
    tasks: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function managedBoard(tasks: KanbanTask[] = []): KanbanBoard {
  return board({
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
    tasks,
  });
}

function task(overrides: Partial<KanbanTask> & { id?: string } = {}): KanbanTask {
  return {
    id: overrides.id ?? 'task-1',
    title: 'Task',
    columnId: 'backlog',
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('classifyTaskForQueue', () => {
  it('classifies a legacy pending task with met dependencies as claimable', () => {
    const t = task();
    const b = board({ tasks: [t] });

    expect(classifyTaskForQueue(b, t, { now: NOW })).toMatchObject({
      bucket: 'claimable',
      claimable: true,
      reasons: [],
    });
  });

  it('classifies unmet dependencies before generic claimability', () => {
    const blocker = task({ id: 'blocker', status: 'pending' });
    const blocked = task({ id: 'blocked', status: 'ready', dependsOn: [blocker.id] });
    const b = board({ tasks: [blocker, blocked] });

    const classification = classifyTaskForQueue(b, blocked, { now: NOW });

    expect(classification.bucket).toBe('dependency_blocked');
    expect(classification.claimable).toBe(false);
    expect(classification.reasons).toContain('Task has unmet dependencies.');
  });

  it('classifies managed backlog tasks as stage blocked', () => {
    const t = task({ lifecycle: { currentStage: 'backlog', stageEnteredAt: NOW, history: [] } });
    const b = managedBoard([t]);

    const classification = classifyTaskForQueue(b, t, { now: NOW });

    expect(classification.bucket).toBe('stage_blocked');
    expect(classification.managedStage).toBe('backlog');
    expect(classification.reasons[0]).toContain('not todo');
  });

  it('classifies managed todo tasks missing required details as detail incomplete', () => {
    const t = task({
      status: 'ready',
      columnId: 'todo',
      lifecycle: { currentStage: 'todo', stageEnteredAt: NOW, history: [] },
    });
    const b = managedBoard([t]);

    const classification = classifyTaskForQueue(b, t, { now: NOW });

    expect(classification.bucket).toBe('detail_incomplete');
    expect(classification.claimable).toBe(false);
    expect(classification.reasons[0]).toContain('description');
    expect(classification.reasons[0]).toContain('successCriteria');
  });

  // Regression guard for the classifier/lifecycle split: `validateRequiredCardDetails`
  // (manager/lifecycle.ts) and `evaluateContractGraphReadiness` (contract-graph.ts)
  // both dropped `dueDate`/`labels`, but the classifier kept demanding them — so
  // `start_task` accepted a card that `queue_health` reported as unclaimable.
  // The fixture deliberately omits both fields.
  it('classifies a managed todo task without dueDate or labels as claimable', () => {
    const t = task({
      status: 'ready',
      columnId: 'todo',
      description: 'Detailed work scope.',
      assignee: 'agent',
      successCriteria: [
        { id: 'check-1', description: 'Acceptance criterion', type: 'manual', status: 'pending' },
      ],
      lifecycle: { currentStage: 'todo', stageEnteredAt: NOW, history: [] },
    });
    const b = managedBoard([t]);

    expect(classifyTaskForQueue(b, t, { now: NOW })).toMatchObject({
      bucket: 'claimable',
      claimable: true,
      managedStage: 'todo',
      reasons: [],
    });
  });

  it('still requires childTaskIds on an atomic managed parent', () => {
    const t = task({
      status: 'ready',
      columnId: 'todo',
      description: 'Composite scope.',
      assignee: 'agent',
      atomic: true,
      successCriteria: [
        { id: 'check-1', description: 'Acceptance criterion', type: 'manual', status: 'pending' },
      ],
      lifecycle: { currentStage: 'todo', stageEnteredAt: NOW, history: [] },
    });
    const b = managedBoard([t]);

    const classification = classifyTaskForQueue(b, t, { now: NOW });

    expect(classification.bucket).toBe('detail_incomplete');
    expect(classification.reasons[0]).toContain('childTaskIds');
  });

  it('classifies running leases by health', () => {
    const live = task({
      status: 'in_progress',
      assignment: { status: 'running', leaseId: 'lease', leaseExpiresAt: FUTURE },
    });
    const expired = task({
      id: 'expired',
      status: 'in_progress',
      assignment: { status: 'running', leaseId: 'lease', leaseExpiresAt: PAST },
    });
    const noLease = task({
      id: 'no-lease',
      status: 'in_progress',
      assignment: { status: 'running' },
    });
    const b = board({ tasks: [live, expired, noLease] });

    expect(classifyTaskForQueue(b, live, { now: NOW }).bucket).toBe('running_live');
    expect(classifyTaskForQueue(b, expired, { now: NOW }).bucket).toBe('running_expired');
    expect(classifyTaskForQueue(b, noLease, { now: NOW }).bucket).toBe('running_no_lease');
  });

  it('classifies retryable and terminal failures separately', () => {
    const retryable = task({
      status: 'failed',
      assignment: { status: 'failed', attempt: 1, maxAttempts: 2 },
    });
    const terminal = task({
      id: 'terminal',
      status: 'failed',
      assignment: { status: 'failed', attempt: 2, maxAttempts: 2 },
    });
    const b = board({ tasks: [retryable, terminal] });

    expect(classifyTaskForQueue(b, retryable, { now: NOW }).bucket).toBe('failed_retryable');
    expect(classifyTaskForQueue(b, terminal, { now: NOW }).bucket).toBe('failed_terminal');
  });
});

/**
 * The dispatch gate (`missingManagedDispatchDetails`, task-classifier.ts) and the
 * lifecycle gate (`validateRequiredCardDetails`, manager/lifecycle.ts) are two
 * hand-maintained copies of the same card-detail contract. They drifted once:
 * the classifier kept demanding `dueDate`/`labels` after lifecycle dropped them,
 * so `queue_health` called a card unclaimable while `start_task` accepted it.
 *
 * This asserts they AGREE across a corpus rather than pinning either one's
 * verdict, so tightening or relaxing the shared contract only has to be done
 * twice — never once.
 */
describe('managed card-detail contract — classifier vs lifecycle', () => {
  /** Field names owned by the card-detail contract. */
  const DETAIL_FIELDS = new Set(['description', 'assignee', 'childTaskIds', 'successCriteria']);

  const criteria = [
    {
      id: 'check-1',
      description: 'Acceptance criterion',
      type: 'manual' as const,
      status: 'pending' as const,
    },
  ];
  const base = {
    status: 'ready' as const,
    columnId: 'todo',
    lifecycle: { currentStage: 'todo' as const, stageEnteredAt: NOW, history: [] },
  };

  const CORPUS: Array<{ label: string; task: KanbanTask }> = [
    {
      label: 'complete card',
      task: task({ ...base, description: 'Scope.', assignee: 'agent', successCriteria: criteria }),
    },
    {
      label: 'no dueDate, no labels',
      task: task({ ...base, description: 'Scope.', assignee: 'agent', successCriteria: criteria }),
    },
    {
      label: 'dueDate and labels present',
      task: task({
        ...base,
        description: 'Scope.',
        assignee: 'agent',
        dueDate: '2026-08-02T00:00:00.000Z',
        labels: ['kanban'],
        successCriteria: criteria,
      }),
    },
    {
      label: 'no description',
      task: task({ ...base, assignee: 'agent', successCriteria: criteria }),
    },
    {
      label: 'no assignee',
      task: task({ ...base, description: 'Scope.', successCriteria: criteria }),
    },
    {
      label: 'no successCriteria',
      task: task({ ...base, description: 'Scope.', assignee: 'agent' }),
    },
    {
      label: 'blank successCriteria description',
      task: task({
        ...base,
        description: 'Scope.',
        assignee: 'agent',
        successCriteria: [{ id: 'c', description: '  ', type: 'manual', status: 'pending' }],
      }),
    },
    {
      label: 'atomic parent without children',
      task: task({
        ...base,
        description: 'Scope.',
        assignee: 'agent',
        atomic: true,
        successCriteria: criteria,
      }),
    },
    {
      label: 'atomic parent with children',
      task: task({
        ...base,
        description: 'Scope.',
        assignee: 'agent',
        atomic: true,
        childTaskIds: ['child-1'],
        successCriteria: criteria,
      }),
    },
  ];

  for (const { label, task: card } of CORPUS) {
    it(`agrees on: ${label}`, () => {
      const b = managedBoard([card]);

      const classifierComplete =
        classifyTaskForQueue(b, card, { now: NOW }).bucket !== 'detail_incomplete';

      // `to: 'running'` is the forward transition that runs the detail guard.
      // It ALSO runs the ownership guard, which reports `task-detail-missing`
      // for field `assignment` — that is execution state, not card detail, so
      // it is filtered out here.
      const lifecycleComplete = !validateManagedTaskTransition(b, card, {
        to: 'running',
        actor: 'tester',
        comment: 'parity probe',
      }).some(
        (issue) => issue.code === 'task-detail-missing' && DETAIL_FIELDS.has(issue.field ?? ''),
      );

      expect(classifierComplete, `card-detail verdict diverged for "${label}"`).toBe(
        lifecycleComplete,
      );
    });
  }

  it('neither gate asks for dueDate or labels', () => {
    const card = task({
      ...base,
      description: 'Scope.',
      assignee: 'agent',
      successCriteria: criteria,
    });
    const b = managedBoard([card]);

    expect(classifyTaskForQueue(b, card, { now: NOW }).bucket).toBe('claimable');
    const fields = validateManagedTaskTransition(b, card, {
      to: 'running',
      actor: 'tester',
      comment: 'parity probe',
    }).map((issue) => issue.field);
    expect(fields).not.toContain('dueDate');
    expect(fields).not.toContain('labels');
  });
});

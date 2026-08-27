/**
 * Edge-case tests for manager/_internal.ts functions not covered by
 * existing tests in internal-helpers.test.ts.
 *
 * Coverage targets:
 * - normalizeColumns: dedup id generation, empty input uses defaults
 * - createTaskObject: boundary policy normalization, atomicity assessment
 * - buildAssignment: all optional fields
 * - cloneChecks: generates new UUIDs
 * - cloneGoalMetrics: generates new UUIDs and sets updatedAt
 * - stampAtomicityAssessment: off mode skips, enforce mode stamps
 * - reconcileTaskColumns: handles missing column references
 * - normalizeAllColumnTaskOrders: calls normalize for each column
 * - createKanbanEvent: builds event with task metadata
 * - emitKanbanEvent: swallows errors (observability-only)
 * - assignmentEventType: maps all status values
 * - setChainMetadata: builds chain refs with previous/next
 * - normalizeDependencyIds: validates refs
 * - addDependencyToTask: handles self and cycle detection
 */
import { describe, expect, it } from 'vitest';
import {
  addDependencyToTask,
  assignmentEventType,
  buildAssignment,
  cloneChecks,
  cloneGoalMetrics,
  createKanbanEvent,
  emitKanbanEvent,
  normalizeAllColumnTaskOrders,
  normalizeColumns,
  normalizeDependencyIds,
  reconcileTaskColumns,
  setChainMetadata,
  stampAtomicityAssessment,
} from '../src/manager/_internal.js';
import type { KanbanBoard, KanbanTask } from '../src/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

function task(overrides: Partial<KanbanTask> & { id: string }): KanbanTask {
  const now = '2026-07-17T00:00:00.000Z';
  return {
    title: overrides.title ?? overrides.id,
    columnId: overrides.columnId ?? 'backlog',
    order: overrides.order ?? 0,
    priority: overrides.priority ?? 'medium',
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
}

function board(tasks: KanbanTask[], columns?: KanbanBoard['columns']): KanbanBoard {
  return {
    id: 'board-1',
    title: 'Test',
    columns: columns ?? [
      { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 },
      { id: 'todo', title: 'To Do', order: 1, wipLimit: 0 },
      { id: 'in-progress', title: 'In Progress', order: 2, wipLimit: 0 },
      { id: 'review', title: 'Review', order: 3, wipLimit: 0 },
      { id: 'done', title: 'Done', order: 4, wipLimit: 0 },
      { id: 'blocked', title: 'Blocked', order: 5, wipLimit: 0 },
    ],
    tasks,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    version: 1,
  };
}

// ── normalizeColumns ─────────────────────────────────────────────────────

describe('normalizeColumns', () => {
  // Columns are locked to the 5 standard columns. normalizeColumns always
  // returns DEFAULT_COLUMNS regardless of input — the former dedup/slug/sort
  // behaviour no longer applies because callers can no longer supply custom
  // column arrays in production.
  it('always returns the 5 standard DEFAULT_COLUMNS', () => {
    const result = normalizeColumns([]);
    expect(result).toHaveLength(5);
    expect(result.map((c) => c.id)).toEqual(['backlog', 'todo', 'in-progress', 'review', 'done']);
    expect(result.map((c) => c.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('ignores caller-supplied columns', () => {
    const result = normalizeColumns([
      { id: 'col', title: 'First', order: 0 },
      { id: 'col', title: 'Second', order: 1 },
    ]);
    expect(result).toHaveLength(5);
    expect(result[0]!.id).toBe('backlog');
  });

  it('returns DEFAULT_COLUMNS for undefined input', () => {
    const result = normalizeColumns(undefined);
    expect(result).toHaveLength(5);
  });
});

// ── buildAssignment ───────────────────────────────────────────────────────

describe('buildAssignment', () => {
  it('builds minimal assignment with just status', () => {
    const result = buildAssignment({ status: 'assigned' });
    expect(result.status).toBe('assigned');
  });

  it('includes all optional fields when provided', () => {
    const result = buildAssignment({
      status: 'running',
      agentId: 'agent-1',
      name: 'Test Agent',
      role: 'developer',
      provider: 'anthropic',
      model: 'claude-3',
      modelRouting: 'fixed',
      fallbackProfile: 'fp1',
      fallbackModels: ['model-a', 'model-b'],
      skills: ['typescript', 'testing'],
      tools: ['read', 'write'],
      allowedCapabilities: ['filesystem', 'network'],
      leaseId: 'lease-1',
      claimedAt: '2026-01-01T00:00:00Z',
      heartbeatAt: '2026-01-01T00:05:00Z',
      leaseExpiresAt: '2026-01-01T00:10:00Z',
      attempt: 1,
      maxAttempts: 3,
      costCeilingUsd: 5.0,
      retryPolicy: 'exponential',
      lastFailureKind: 'timeout',
    });

    expect(result.agentId).toBe('agent-1');
    expect(result.name).toBe('Test Agent');
    expect(result.role).toBe('developer');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-3');
    expect(result.skills).toEqual(['typescript', 'testing']);
    expect(result.leaseId).toBe('lease-1');
    expect(result.costCeilingUsd).toBe(5.0);
    expect(result.retryPolicy).toBe('exponential');
    expect(result.lastFailureKind).toBe('timeout');
  });
});

// ── cloneChecks / cloneGoalMetrics ───────────────────────────────────────

describe('cloneChecks', () => {
  it('creates new check objects with new UUIDs', () => {
    const checks = [
      {
        id: 'original-1',
        description: 'Check 1',
        type: 'manual' as const,
        status: 'pending' as const,
      },
    ];
    const cloned = cloneChecks(checks);
    expect(cloned).toHaveLength(1);
    expect(cloned[0]!.id).not.toBe('original-1');
    expect(cloned[0]!.description).toBe('Check 1');
  });

  it('returns empty array for empty input', () => {
    expect(cloneChecks([])).toEqual([]);
  });
});

describe('cloneGoalMetrics', () => {
  it('creates new metric objects with new UUIDs and updatedAt', () => {
    const metrics = [{ id: 'm1', name: 'Metric 1', status: 'pending' as const }];
    const cloned = cloneGoalMetrics(metrics);
    expect(cloned).toHaveLength(1);
    expect(cloned[0]!.id).not.toBe('m1');
    expect(cloned[0]!.name).toBe('Metric 1');
    expect(cloned[0]!.updatedAt).toBeTruthy();
  });

  it('returns empty array for empty input', () => {
    expect(cloneGoalMetrics([])).toEqual([]);
  });
});

// ── stampAtomicityAssessment ─────────────────────────────────────────────

describe('stampAtomicityAssessment', () => {
  it('is a no-op when board policy mode is off', () => {
    const b = board([task({ id: 't1', title: 'A long task with many requirements' })]);
    b.atomicity = { mode: 'off', decomposition: 'auto' };
    stampAtomicityAssessment(b, b.tasks[0]!);
    // Should not have atomicityAssessment because mode is off
    expect(b.tasks[0]!.atomicityAssessment).toBeUndefined();
  });

  it('stamps an assessment when mode is enforce', () => {
    const b = board([task({ id: 't1', title: 'A long task with many requirements' })]);
    b.atomicity = { mode: 'enforce', decomposition: 'auto' };
    stampAtomicityAssessment(b, b.tasks[0]!);
    expect(b.tasks[0]!.atomicityAssessment).toBeDefined();
    expect(b.tasks[0]!.atomicityAssessment!.assessedBy).toBe('rules');
  });
});

// ── reconcileTaskColumns ─────────────────────────────────────────────────

describe('reconcileTaskColumns', () => {
  it('reassigns tasks to fallback column when their column is missing', () => {
    const b = board(
      [task({ id: 't1', columnId: 'missing-col', status: 'in_progress' })],
      [{ id: 'fallback', title: 'Fallback', order: 0, wipLimit: 0 }],
    );
    reconcileTaskColumns(b, '2026-07-17T00:00:00Z');
    expect(b.tasks[0]!.columnId).toBe('fallback');
  });

  it('does not change tasks with valid columns', () => {
    const b = board([task({ id: 't1', columnId: 'backlog', status: 'pending' })]);
    reconcileTaskColumns(b, '2026-07-17T00:00:00Z');
    expect(b.tasks[0]!.columnId).toBe('backlog');
  });

  it('returns early when there is no fallback column', () => {
    const b = board([task({ id: 't1', columnId: 'missing' })]);
    b.columns = [];
    // Should not crash
    reconcileTaskColumns(b, '2026-07-17T00:00:00Z');
    expect(b.tasks[0]!.columnId).toBe('missing');
  });
});

// ── normalizeAllColumnTaskOrders ─────────────────────────────────────────

describe('normalizeAllColumnTaskOrders', () => {
  it('normalizes orders for every column', () => {
    const b = board([
      task({ id: 't1', columnId: 'backlog', order: 10 }),
      task({ id: 't2', columnId: 'backlog', order: 5 }),
      task({ id: 't3', columnId: 'done', order: 99 }),
    ]);
    normalizeAllColumnTaskOrders(b);
    // Tasks are returned from filter in original array order, but their order values are normalized
    const backlogOrders = b.tasks
      .filter((t) => t.columnId === 'backlog')
      .sort((a, b) => a.order - b.order)
      .map((t) => t.order);
    expect(backlogOrders).toEqual([0, 1]);
    const doneOrder = b.tasks.find((t) => t.columnId === 'done')!.order;
    expect(doneOrder).toBe(0);
  });
});

// ── createKanbanEvent ────────────────────────────────────────────────────

describe('createKanbanEvent', () => {
  it('creates an event with the required fields', () => {
    const t = task({ id: 't1', assignment: { status: 'running', agentId: 'agent-1' } });
    const event = createKanbanEvent('board-1', t, 'task.created', {
      sessionId: '2026-08-26/sess_01TESTSESSION',
    });
    expect(event.id).toBeTruthy();
    expect(event.boardId).toBe('board-1');
    expect(event.taskId).toBe('t1');
    expect(event.type).toBe('task.created');
    expect(event.ts).toBeTruthy();
    expect(event.sessionId).toBe('2026-08-26/sess_01TESTSESSION');
    expect(event.actor).toBe('agent-1');
  });

  it('rejects an event without an owning session id', () => {
    const t = task({ id: 't1' });

    expect(() => createKanbanEvent('board-1', t, 'task.created')).toThrow(
      expect.objectContaining({ code: 'SESSION_ID_REQUIRED' }),
    );
  });

  it('includes details when provided', () => {
    const t = task({ id: 't1' });
    const event = createKanbanEvent('board-1', t, 'task.moved', {
      sessionId: '2026-08-26/sess_01TESTSESSION',
      before: { columnId: 'backlog' },
      after: { columnId: 'in-progress' },
    });
    expect(event.before).toEqual({ columnId: 'backlog' });
    expect(event.after).toEqual({ columnId: 'in-progress' });
  });

  it('includes subagentId and runTaskId when present', () => {
    const t = task({
      id: 't1',
      assignment: { status: 'running', subagentId: 'sub-1', runTaskId: 'run-1', agentId: 'a1' },
    });
    const event = createKanbanEvent('board-1', t, 'task.claimed', {
      sessionId: '2026-08-26/sess_01TESTSESSION',
    });
    expect(event.subagentId).toBe('sub-1');
    expect(event.runTaskId).toBe('run-1');
  });
});

// ── emitKanbanEvent ──────────────────────────────────────────────────────

describe('emitKanbanEvent', () => {
  it('swallows errors (observability-only)', async () => {
    // Should not throw even with an invalid path
    await expect(
      emitKanbanEvent('/non/existent/path', {
        id: 'e1',
        boardId: 'b1',
        taskId: 't1',
        type: 'test',
        ts: 'now',
        sessionId: '2026-08-26/sess_01TESTSESSION',
      }),
    ).resolves.toBeUndefined();
  });
});

// ── assignmentEventType ──────────────────────────────────────────────────

describe('assignmentEventType', () => {
  it('returns task.assignment.completed for completed status', () => {
    expect(assignmentEventType('completed')).toBe('task.assignment.completed');
  });

  it('returns task.assignment.failed for failed status', () => {
    expect(assignmentEventType('failed')).toBe('task.assignment.failed');
  });

  it('returns task.assignment.running for running status', () => {
    expect(assignmentEventType('running')).toBe('task.assignment.running');
  });

  it('returns task.assignment.cancelled for cancelled status', () => {
    expect(assignmentEventType('cancelled')).toBe('task.assignment.cancelled');
  });

  it('returns task.assignment.updated for other statuses', () => {
    expect(assignmentEventType('assigned')).toBe('task.assignment.updated');
    expect(assignmentEventType('queued')).toBe('task.assignment.updated');
  });
});

// ── setChainMetadata ─────────────────────────────────────────────────────

describe('setChainMetadata', () => {
  it('sets chain with previous/next references', () => {
    const b = board([task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]);
    setChainMetadata(b, [b.tasks[0]!, b.tasks[1]!, b.tasks[2]!], 'chain-1', false);

    expect(b.tasks[0]!.chain).toMatchObject({
      chainId: 'chain-1',
      order: 0,
      nextTaskId: 'b',
    });
    expect(b.tasks[0]!.chain!.previousTaskId).toBeUndefined();

    expect(b.tasks[1]!.chain).toMatchObject({
      chainId: 'chain-1',
      order: 1,
      previousTaskId: 'a',
      nextTaskId: 'c',
    });

    expect(b.tasks[2]!.chain).toMatchObject({
      chainId: 'chain-1',
      order: 2,
      previousTaskId: 'b',
    });
    expect(b.tasks[2]!.chain!.nextTaskId).toBeUndefined();
  });

  it('adds dependencies when enforceDependencies is true', () => {
    const b = board([task({ id: 'a' }), task({ id: 'b' })]);
    setChainMetadata(b, [b.tasks[0]!, b.tasks[1]!], 'chain-1', true);
    expect(b.tasks[1]!.dependsOn).toContain('a');
  });
});

// ── addDependencyToTask ──────────────────────────────────────────────────

describe('addDependencyToTask', () => {
  it('throws when task depends on itself', () => {
    const b = board([task({ id: 't1' })]);
    expect(() => addDependencyToTask(b, b.tasks[0]!, b.tasks[0]!)).toThrow(
      'cannot depend on itself',
    );
  });

  it('throws when adding a cycle', () => {
    const b = board([task({ id: 'a', dependsOn: ['b'] }), task({ id: 'b', dependsOn: ['a'] })]);
    expect(() => addDependencyToTask(b, b.tasks[0]!, b.tasks[1]!)).toThrow(
      'would create a dependency cycle',
    );
  });

  it('adds the dependency id to the task', () => {
    const b = board([task({ id: 'a' }), task({ id: 'b' })]);
    addDependencyToTask(b, b.tasks[0]!, b.tasks[1]!);
    expect(b.tasks[0]!.dependsOn).toContain('b');
  });
});

// ── normalizeDependencyIds ───────────────────────────────────────────────

describe('normalizeDependencyIds', () => {
  it('resolves refs and returns their ids', () => {
    const b = board([task({ id: 'a' }), task({ id: 'b' })]);
    const result = normalizeDependencyIds(b, '', ['a', 'b']);
    expect(result).toEqual(['a', 'b']);
  });

  it('deduplicates repeated ids', () => {
    const b = board([task({ id: 'a' })]);
    const result = normalizeDependencyIds(b, '', ['a', 'a']);
    expect(result).toEqual(['a']);
  });

  it('throws for missing dependency', () => {
    const b = board([task({ id: 'a' })]);
    expect(() => normalizeDependencyIds(b, '', ['missing'])).toThrow('Dependency task not found');
  });

  it('throws for self-dependency', () => {
    const b = board([task({ id: 'a' })]);
    expect(() => normalizeDependencyIds(b, 'a', ['a'])).toThrow('cannot depend on itself');
  });

  it('throws for circular dependency', () => {
    const b = board([task({ id: 'a', dependsOn: ['b'] }), task({ id: 'b' })]);
    expect(() => normalizeDependencyIds(b, 'b', ['a'])).toThrow('would create a dependency cycle');
  });
});

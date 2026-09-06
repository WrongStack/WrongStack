import { describe, expect, it } from 'vitest';
import type {
  KanbanAgentAssignment,
  KanbanBoard,
  KanbanRecoveryPolicy,
  KanbanTask,
} from '../src/types.js';
import { areDependenciesMet, findBlockedTasks } from '../src/manager/dependencies.js';
import {
  assertNoDependencyCycles,
  buildTaskGraphMetadata,
  clampOrder,
  columnIdForKanbanStatus,
  columnIdForTaskGraphStatus,
  compareTasksForWork,
  findGoalMetric,
  findTask,
  hasDependencyPath,
  inferTaskType,
  isAssignmentHeartbeatDue,
  isTaskFromGraph,
  isTaskReadyForWork,
  kanbanStatusToTaskGraphStatus,
  later,
  matchesKanbanSearch,
  mergedTaskDescription,
  highestPriority,
  msUntilExpiry,
  optionalArray,
  parseIsoTimestamp,
  isoFromTimestamp,
  remapIdList,
  remapTaskReferences,
  resolveTaskRefs,
  rewireDependents,
  selectRecoveryMode,
  slugify,
  statusForColumn,
  taskGraphStatusToKanbanStatus,
  taskGraphEdgesFromBoard,
  tasksInChain,
  uniqueColumnId,
  uniqueIdFromSet,
  uniqueStrings,
} from '../src/manager/_internal.js';

// ── Test fixtures ────────────────────────────────────────────────────

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

// ── isAssignmentHeartbeatDue ─────────────────────────────────────────

describe('isAssignmentHeartbeatDue', () => {
  const base: KanbanAgentAssignment = { status: 'running' };

  it('returns false when heartbeat or lease expiry is missing', () => {
    expect(isAssignmentHeartbeatDue({ status: 'running' }, '2026-07-17T00:00:00Z')).toBe(false);
    expect(
      isAssignmentHeartbeatDue(
        { status: 'running', heartbeatAt: '2026-07-17T00:00:00Z' },
        '2026-07-17T00:00:00Z',
      ),
    ).toBe(false);
  });

  it('returns true when the lease window is non-positive (expiry <= heartbeat)', () => {
    expect(
      isAssignmentHeartbeatDue(
        {
          ...base,
          heartbeatAt: '2026-07-17T00:05:00Z',
          leaseExpiresAt: '2026-07-17T00:05:00Z', // lease == 0
        },
        '2026-07-17T00:05:00Z',
      ),
    ).toBe(true);
    expect(
      isAssignmentHeartbeatDue(
        {
          ...base,
          heartbeatAt: '2026-07-17T00:05:00Z',
          leaseExpiresAt: '2026-07-17T00:04:00Z', // lease < 0
        },
        '2026-07-17T00:05:00Z',
      ),
    ).toBe(true);
  });

  it('returns true when now is past half the lease since the last heartbeat', () => {
    // heartbeat=00:00, expiry=00:10 => lease=10min; half=5min; now=00:05 => due
    expect(
      isAssignmentHeartbeatDue(
        {
          ...base,
          heartbeatAt: '2026-07-17T00:00:00Z',
          leaseExpiresAt: '2026-07-17T00:10:00Z',
        },
        '2026-07-17T00:05:00Z',
      ),
    ).toBe(true);
  });

  it('returns false when now is within the first half of the lease', () => {
    expect(
      isAssignmentHeartbeatDue(
        {
          ...base,
          heartbeatAt: '2026-07-17T00:00:00Z',
          leaseExpiresAt: '2026-07-17T00:10:00Z',
        },
        '2026-07-17T00:04:59Z',
      ),
    ).toBe(false);
  });
});

// ── selectRecoveryMode ───────────────────────────────────────────────

describe('selectRecoveryMode', () => {
  const noPolicy: KanbanRecoveryPolicy | undefined = undefined;
  const policy: KanbanRecoveryPolicy = {
    failWhenCostCeilingSet: true,
    releaseOnFailureKinds: ['oom'],
    releaseOnHeartbeatDue: true,
    retryPolicyOverride: 'exponential',
  };

  it('short-circuits to the requested mode when not auto', () => {
    const t = task({ id: 't1' });
    expect(
      selectRecoveryMode({ requested: 'release', task: t, isHeartbeatDue: true, policy }),
    ).toBe('release');
    expect(selectRecoveryMode({ requested: 'fail', task: t, isHeartbeatDue: false, policy })).toBe(
      'fail',
    );
    expect(
      selectRecoveryMode({ requested: 'retry', task: t, isHeartbeatDue: false, policy: noPolicy }),
    ).toBe('retry');
  });

  it('defaults to retry when task has no assignment', () => {
    expect(
      selectRecoveryMode({
        requested: 'auto',
        task: task({ id: 't1' }),
        isHeartbeatDue: false,
        policy,
      }),
    ).toBe('retry');
  });

  it('fails when the assignment opted out of retries', () => {
    expect(
      selectRecoveryMode({
        requested: 'auto',
        task: task({
          id: 't1',
          assignment: { status: 'running', retryPolicy: 'off' },
        }),
        isHeartbeatDue: false,
        policy: noPolicy,
      }),
    ).toBe('fail');
  });

  it('releases when the last failure kind matches the policy release list', () => {
    expect(
      selectRecoveryMode({
        requested: 'auto',
        task: task({
          id: 't1',
          assignment: { status: 'running', lastFailureKind: 'oom' },
        }),
        isHeartbeatDue: false,
        policy: { releaseOnFailureKinds: ['oom'] },
      }),
    ).toBe('release');
  });

  it('does not release when failure kind is absent even if policy lists kinds', () => {
    expect(
      selectRecoveryMode({
        requested: 'auto',
        task: task({ id: 't1', assignment: { status: 'running' } }),
        isHeartbeatDue: false,
        policy: { releaseOnFailureKinds: ['oom'] },
      }),
    ).toBe('retry');
  });

  it('fails when cost ceiling is set and the policy says so', () => {
    expect(
      selectRecoveryMode({
        requested: 'auto',
        task: task({
          id: 't1',
          assignment: { status: 'running', costCeilingUsd: 5 },
        }),
        isHeartbeatDue: false,
        policy: { failWhenCostCeilingSet: true },
      }),
    ).toBe('fail');
  });

  it('releases when heartbeat is due and the policy says so', () => {
    expect(
      selectRecoveryMode({
        requested: 'auto',
        task: task({ id: 't1', assignment: { status: 'running' } }),
        isHeartbeatDue: true,
        policy: { releaseOnHeartbeatDue: true },
      }),
    ).toBe('release');
  });

  it('fails when the next attempt would exceed maxAttempts', () => {
    // (attempt ?? 0) + 1 > maxAttempts  =>  3 + 1 > 3  => true
    expect(
      selectRecoveryMode({
        requested: 'auto',
        task: task({
          id: 't1',
          assignment: { status: 'running', attempt: 3, maxAttempts: 3 },
        }),
        isHeartbeatDue: false,
        policy: noPolicy,
      }),
    ).toBe('fail');
  });

  it('does not fail when the next attempt equals maxAttempts (boundary)', () => {
    // 2 + 1 > 3 => false => retry
    expect(
      selectRecoveryMode({
        requested: 'auto',
        task: task({
          id: 't1',
          assignment: { status: 'running', attempt: 2, maxAttempts: 3 },
        }),
        isHeartbeatDue: false,
        policy: noPolicy,
      }),
    ).toBe('retry');
  });

  it('defaults to retry when none of the policy rules fire', () => {
    expect(
      selectRecoveryMode({
        requested: 'auto',
        task: task({ id: 't1', assignment: { status: 'running', attempt: 0, maxAttempts: 3 } }),
        isHeartbeatDue: false,
        policy: noPolicy,
      }),
    ).toBe('retry');
  });
});

// ── later / msUntilExpiry ────────────────────────────────────────────

describe('later', () => {
  it('returns b when a is undefined', () => {
    expect(later(undefined, '2026-07-17T00:00:00Z')).toBe('2026-07-17T00:00:00Z');
  });
  it('returns a when a >= b', () => {
    expect(later('2026-07-17T00:00:01Z', '2026-07-17T00:00:00Z')).toBe('2026-07-17T00:00:01Z');
  });
  it('returns b when b > a', () => {
    expect(later('2026-07-17T00:00:00Z', '2026-07-17T00:00:01Z')).toBe('2026-07-17T00:00:01Z');
  });
});

describe('msUntilExpiry', () => {
  it('computes the millisecond delta', () => {
    expect(msUntilExpiry('2026-07-17T00:00:10Z', '2026-07-17T00:00:00Z')).toBe(10_000);
    expect(msUntilExpiry('2026-07-17T00:00:00Z', '2026-07-17T00:00:05Z')).toBe(-5_000);
  });
});

// ── compareTasksForWork ──────────────────────────────────────────────

describe('compareTasksForWork', () => {
  it('orders by priority first', () => {
    expect(
      compareTasksForWork(
        task({ id: 'a', priority: 'critical' }),
        task({ id: 'b', priority: 'low' }),
      ),
    ).toBeLessThan(0);
  });
  it('falls back to columnId locale compare', () => {
    expect(
      compareTasksForWork(
        task({ id: 'a', priority: 'high', columnId: 'backlog' }),
        task({ id: 'b', priority: 'high', columnId: 'todo' }),
      ),
    ).toBeLessThan(0);
  });
  it('falls back to order when priority and column match', () => {
    expect(
      compareTasksForWork(
        task({ id: 'a', priority: 'high', columnId: 'backlog', order: 0 }),
        task({ id: 'b', priority: 'high', columnId: 'backlog', order: 1 }),
      ),
    ).toBeLessThan(0);
  });
  it('falls back to createdAt when the rest are equal', () => {
    expect(
      compareTasksForWork(
        task({
          id: 'a',
          priority: 'high',
          columnId: 'backlog',
          order: 0,
          createdAt: '2026-01-01T00:00:00Z',
        }),
        task({
          id: 'b',
          priority: 'high',
          columnId: 'backlog',
          order: 0,
          createdAt: '2026-01-02T00:00:00Z',
        }),
      ),
    ).toBeLessThan(0);
  });
});

// ── matchesKanbanSearch ──────────────────────────────────────────────

describe('matchesKanbanSearch', () => {
  const b = board([task({ id: 't1', title: 'Fix login' })]);

  it('returns false on assignedAgent mismatch', () => {
    expect(matchesKanbanSearch(b, b.tasks[0]!, { assignedAgent: 'someone-else' })).toBe(false);
  });
  it('returns false on status mismatch', () => {
    expect(matchesKanbanSearch(b, b.tasks[0]!, { status: 'completed' })).toBe(false);
  });
  it('returns false on priority mismatch', () => {
    expect(matchesKanbanSearch(b, b.tasks[0]!, { priority: 'critical' })).toBe(false);
  });
  it('returns false on label mismatch', () => {
    expect(matchesKanbanSearch(b, b.tasks[0]!, { label: 'missing' })).toBe(false);
  });
  it('returns false on chainId mismatch', () => {
    expect(matchesKanbanSearch(b, b.tasks[0]!, { chainId: 'nope' })).toBe(false);
  });
  it('returns false on readyOnly when the task is not ready', () => {
    // A blocked task is never ready-for-work.
    const bd = board([task({ id: 't1', title: 'Fix login', status: 'blocked' })]);
    expect(matchesKanbanSearch(bd, bd.tasks[0]!, { readyOnly: true })).toBe(false);
  });
  it('returns true when query is empty (no other filters)', () => {
    expect(matchesKanbanSearch(b, b.tasks[0]!, {})).toBe(true);
  });
  it('matches by case-insensitive title substring', () => {
    expect(matchesKanbanSearch(b, b.tasks[0]!, { query: 'LOGIN' })).toBe(true);
  });
  it('matches on description', () => {
    const bd = board([task({ id: 't1', title: 'X', description: 'special detail' })]);
    expect(matchesKanbanSearch(bd, bd.tasks[0]!, { query: 'detail' })).toBe(true);
  });
  it('matches on labels', () => {
    const bd = board([task({ id: 't1', title: 'X', labels: ['urgent'] })]);
    expect(matchesKanbanSearch(bd, bd.tasks[0]!, { query: 'urgent' })).toBe(true);
  });
  it('matches on assignedAgent and assignee', () => {
    const bd = board([task({ id: 't1', title: 'X', assignedAgent: 'bot', assignee: 'ada' })]);
    expect(matchesKanbanSearch(bd, bd.tasks[0]!, { query: 'bot' })).toBe(true);
    expect(matchesKanbanSearch(bd, bd.tasks[0]!, { query: 'ada' })).toBe(true);
  });
});

// ── findTask / resolveTaskRefs / findGoalMetric ──────────────────────

describe('findTask', () => {
  const b = board([task({ id: 'abc123' }), task({ id: 'abc456' })]);

  it('finds an exact id', () => {
    expect(findTask(b, 'abc123')?.id).toBe('abc123');
  });
  it('finds a unique prefix', () => {
    expect(findTask(b, 'abc12')?.id).toBe('abc123');
    expect(findTask(b, 'abc45')?.id).toBe('abc456');
  });
  it('throws on ambiguous prefix', () => {
    expect(() => findTask(b, 'abc')).toThrow('Ambiguous kanban task id');
  });
  it('returns undefined when nothing matches', () => {
    expect(findTask(b, 'zzz')).toBeUndefined();
  });
  it('returns undefined for empty or whitespace-only taskId', () => {
    expect(findTask(b, '')).toBeUndefined();
    expect(findTask(b, '   ')).toBeUndefined();
    const single = board([task({ id: 'only-one' })]);
    expect(findTask(single, '')).toBeUndefined();
  });
});

describe('resolveTaskRefs', () => {
  it('resolves a list of refs and throws on missing or duplicate', () => {
    const b = board([task({ id: 't1' }), task({ id: 't2' })]);
    const resolved = resolveTaskRefs(b, ['t1', 't2']);
    expect(resolved.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(() => resolveTaskRefs(b, ['missing'])).toThrow('Kanban task not found');
    expect(() => resolveTaskRefs(b, ['t1', 't1'])).toThrow('Duplicate kanban task id');
  });
});

describe('findGoalMetric', () => {
  const metrics = [
    { id: 'm1', name: 'A', status: 'pending' as const },
    { id: 'm2', name: 'B', status: 'pending' as const },
    { id: 'mx1', name: 'C', status: 'pending' as const },
    { id: 'mx2', name: 'D', status: 'pending' as const },
  ];

  it('finds an exact id', () => {
    expect(findGoalMetric(metrics, 'm1')?.id).toBe('m1');
  });
  it('finds a unique prefix', () => {
    expect(findGoalMetric(metrics, 'm2')?.id).toBe('m2');
  });
  it('throws on ambiguous prefix', () => {
    expect(() => findGoalMetric(metrics, 'mx')).toThrow('Ambiguous kanban goal metric id');
  });
  it('returns undefined when nothing matches', () => {
    expect(findGoalMetric(metrics, 'zz')).toBeUndefined();
  });
});

// ── hasDependencyPath / assertNoDependencyCycles ─────────────────────

describe('hasDependencyPath', () => {
  it('returns true when from === to (trivial cycle)', () => {
    expect(hasDependencyPath(board([]), 'x', 'x')).toBe(true);
  });
  it('returns false for a task with no dependency chain', () => {
    const b = board([task({ id: 'a' }), task({ id: 'b' })]);
    expect(hasDependencyPath(b, 'a', 'b')).toBe(false);
  });
  it('walks the chain and finds a path', () => {
    // c -> b -> a
    const b = board([
      task({ id: 'a' }),
      task({ id: 'b', dependsOn: ['a'] }),
      task({ id: 'c', dependsOn: ['b'] }),
    ]);
    expect(hasDependencyPath(b, 'c', 'a')).toBe(true);
    expect(hasDependencyPath(b, 'a', 'c')).toBe(false);
  });
  it('terminates on a visited node', () => {
    // a -> b -> a (cycle), asking a -> c which doesn't exist
    const b = board([task({ id: 'a', dependsOn: ['b'] }), task({ id: 'b', dependsOn: ['a'] })]);
    expect(hasDependencyPath(b, 'a', 'c')).toBe(false);
  });
});

describe('assertNoDependencyCycles', () => {
  it('passes on an acyclic board', () => {
    const b = board([task({ id: 'a' }), task({ id: 'b', dependsOn: ['a'] })]);
    expect(() => assertNoDependencyCycles(b)).not.toThrow();
  });
  it('throws on a self-dependency', () => {
    const b = board([task({ id: 'a', dependsOn: ['a'] })]);
    expect(() => assertNoDependencyCycles(b)).toThrow('cannot depend on itself');
  });
  it('throws on a cycle', () => {
    const b = board([task({ id: 'a', dependsOn: ['b'] }), task({ id: 'b', dependsOn: ['a'] })]);
    expect(() => assertNoDependencyCycles(b)).toThrow('dependency cycle detected');
  });
});

// ── uniqueColumnId / uniqueIdFromSet ─────────────────────────────────

describe('uniqueColumnId', () => {
  it('returns the slug when it is unique', () => {
    expect(uniqueColumnId(board([]), 'New Column')).toBe('new-column');
  });
  it('appends a suffix when the slug collides', () => {
    const b = board([], [{ id: 'new-column', title: 'Existing', order: 0, wipLimit: 0 }]);
    expect(uniqueColumnId(b, 'New Column')).toBe('new-column-2');
    expect(
      uniqueColumnId(
        board(
          [],
          [
            { id: 'new-column', title: 'A', order: 0, wipLimit: 0 },
            { id: 'new-column-2', title: 'B', order: 1, wipLimit: 0 },
          ],
        ),
        'New Column',
      ),
    ).toBe('new-column-3');
  });
  it('falls back to "column" when slug is empty', () => {
    expect(uniqueColumnId(board([]), '!!!')).toBe('column');
  });
});

describe('uniqueIdFromSet', () => {
  it('returns the requested id when not used', () => {
    expect(uniqueIdFromSet(new Set(), 'a')).toBe('a');
  });
  it('appends a suffix when the id is taken', () => {
    expect(uniqueIdFromSet(new Set(['a']), 'a')).toBe('a-2');
  });
  it('records the chosen id in the set', () => {
    const used = new Set<string>();
    uniqueIdFromSet(used, 'a');
    expect(used.has('a')).toBe(true);
  });
  it('falls back to "item" when blank', () => {
    expect(uniqueIdFromSet(new Set(), '')).toBe('item');
  });
});

// ── uniqueStrings / optionalArray ────────────────────────────────────

describe('uniqueStrings', () => {
  it('dedupes and drops falsy entries', () => {
    expect(uniqueStrings(['a', '', 'b', 'a', ''])).toEqual(['a', 'b']);
    expect(uniqueStrings([])).toEqual([]);
  });
});

describe('optionalArray', () => {
  it('returns an object with the array when non-empty', () => {
    expect(optionalArray('k', [1])).toEqual({ k: [1] });
  });
  it('returns an empty record when the array is empty', () => {
    expect(optionalArray('k', [])).toEqual({});
  });
});

// ── mergedTaskDescription / highestPriority ──────────────────────────

describe('mergedTaskDescription', () => {
  it('joins title, description, and note contents', () => {
    const desc = mergedTaskDescription([
      task({
        id: 'a',
        title: 'A',
        description: 'desc-a',
        notes: [{ id: 'n1', author: 'x', content: 'note-a', createdAt: 'now' }],
      }),
      task({ id: 'b', title: 'B' }),
    ]);
    expect(desc).toContain('## A');
    expect(desc).toContain('desc-a');
    expect(desc).toContain('note-a');
    expect(desc).toContain('## B');
  });
});

describe('highestPriority', () => {
  it('returns the most severe priority across tasks', () => {
    expect(
      highestPriority([task({ id: 'a', priority: 'low' }), task({ id: 'b', priority: 'high' })]),
    ).toBe('high');
    expect(highestPriority([task({ id: 'a', priority: 'low' })])).toBe('low');
    expect(highestPriority([])).toBe('low');
  });
});

// ── isTaskReadyForWork ───────────────────────────────────────────────

describe('isTaskReadyForWork', () => {
  it('returns false for non-pending/ready statuses', () => {
    const b = board([]);
    for (const status of [
      'in_progress',
      'review',
      'completed',
      'failed',
      'archived',
      'blocked',
    ] as const) {
      expect(isTaskReadyForWork(b, task({ id: 't', status }))).toBe(false);
    }
  });
  it('returns false when an active assignment exists', () => {
    const b = board([]);
    expect(
      isTaskReadyForWork(b, task({ id: 't', status: 'pending', assignment: { status: 'queued' } })),
    ).toBe(false);
    expect(
      isTaskReadyForWork(
        b,
        task({ id: 't', status: 'pending', assignment: { status: 'running' } }),
      ),
    ).toBe(false);
  });
  it('returns false when the task is merged', () => {
    const b = board([]);
    expect(
      isTaskReadyForWork(b, task({ id: 't', status: 'pending', mergedIntoTaskId: 'other' })),
    ).toBe(false);
  });
  it('returns false when dependencies are unmet', () => {
    const b = board([
      task({ id: 't', status: 'pending', dependsOn: ['dep'] }),
      task({ id: 'dep', status: 'pending' }),
    ]);
    expect(isTaskReadyForWork(b, b.tasks[0]!)).toBe(false);
  });
  it('returns true for a dependency-free pending task', () => {
    const b = board([task({ id: 't', status: 'pending' })]);
    expect(isTaskReadyForWork(b, b.tasks[0]!)).toBe(true);
  });
});

// ── status mappers ───────────────────────────────────────────────────

describe('taskGraphStatusToKanbanStatus', () => {
  it('maps every task-graph status', () => {
    expect(taskGraphStatusToKanbanStatus('in_progress')).toBe('in_progress');
    expect(taskGraphStatusToKanbanStatus('completed')).toBe('completed');
    expect(taskGraphStatusToKanbanStatus('review')).toBe('review');
    expect(taskGraphStatusToKanbanStatus('blocked')).toBe('blocked');
    expect(taskGraphStatusToKanbanStatus('failed')).toBe('failed');
    expect(taskGraphStatusToKanbanStatus('pending')).toBe('pending');
  });
});

describe('kanbanStatusToTaskGraphStatus', () => {
  it('prefers assignment status, then maps kanban status', () => {
    expect(
      kanbanStatusToTaskGraphStatus(
        task({ id: 't', status: 'pending', assignment: { status: 'running' } }),
      ),
    ).toBe('in_progress');
    expect(
      kanbanStatusToTaskGraphStatus(
        task({ id: 't', status: 'pending', assignment: { status: 'failed' } }),
      ),
    ).toBe('failed');
    expect(kanbanStatusToTaskGraphStatus(task({ id: 't', status: 'ready' }))).toBe('pending');
    expect(kanbanStatusToTaskGraphStatus(task({ id: 't', status: 'archived' }))).toBe('pending');
    expect(kanbanStatusToTaskGraphStatus(task({ id: 't', status: 'in_progress' }))).toBe(
      'in_progress',
    );
    expect(kanbanStatusToTaskGraphStatus(task({ id: 't', status: 'completed' }))).toBe('completed');
    expect(kanbanStatusToTaskGraphStatus(task({ id: 't', status: 'review' }))).toBe('review');
    expect(kanbanStatusToTaskGraphStatus(task({ id: 't', status: 'blocked' }))).toBe('blocked');
    expect(kanbanStatusToTaskGraphStatus(task({ id: 't', status: 'failed' }))).toBe('failed');
  });
});

// ── metadata.kanban.status preservation (A3) ─────────────────────────
//
// kanbanStatusToTaskGraphStatus collapses `ready` and `archived` to `pending`
// (pinned above) because the core TaskGraph union has only 6 statuses. That
// lossy mapping is intentional, but it means a Kanban `ready` task exported
// to a TaskGraph and re-imported would silently demote to `pending`.
//
// The mitigation is the metadata channel: buildTaskGraphMetadata stashes the
// original Kanban status verbatim under `metadata.kanban.status`, so the
// information round-trips through the graph even though the node's `status`
// field cannot represent it. These tests pin that preservation channel so a
// future change to either mapper cannot silently widen the data loss.

describe('buildTaskGraphMetadata preserves kanban status for all 8 statuses', () => {
  const ALL_KANBAN_STATUSES = [
    'pending',
    'ready',
    'in_progress',
    'blocked',
    'review',
    'completed',
    'failed',
    'archived',
  ] as const;

  for (const status of ALL_KANBAN_STATUSES) {
    it(`preserves metadata.kanban.status === '${status}' even though the graph node status may collapse`, () => {
      const t = task({ id: `t-${status}`, status });
      const b = board([t]);
      const metadata = buildTaskGraphMetadata(b, t);
      const kanbanMeta = metadata.kanban as { status: string };
      expect(kanbanMeta.status).toBe(status);
    });
  }
});

// ── column mappers ───────────────────────────────────────────────────

describe('statusForColumn', () => {
  it('maps column id substrings to statuses', () => {
    expect(statusForColumn('done')).toBe('completed');
    expect(statusForColumn('my-complete-col')).toBe('completed');
    expect(statusForColumn('in-progress')).toBe('in_progress');
    expect(statusForColumn('doing')).toBe('in_progress');
    expect(statusForColumn('review')).toBe('review');
    expect(statusForColumn('blocked')).toBe('blocked');
    expect(statusForColumn('ready-col')).toBe('ready');
    expect(statusForColumn('backlog')).toBe('pending');
    expect(statusForColumn('todo')).toBe('pending');
  });
});

describe('columnIdForKanbanStatus', () => {
  const b = board([]);
  it('finds a column for each status, preferring idiomatic names', () => {
    expect(columnIdForKanbanStatus(b, 'completed')).toBe('done');
    expect(columnIdForKanbanStatus(b, 'in_progress')).toBe('in-progress');
    expect(columnIdForKanbanStatus(b, 'review')).toBe('review');
    expect(columnIdForKanbanStatus(b, 'failed')).toBe('review');
    expect(columnIdForKanbanStatus(b, 'blocked')).toBe('blocked');
    expect(columnIdForKanbanStatus(b, 'ready')).toBe('todo');
    expect(columnIdForKanbanStatus(b, 'archived')).toBe('done');
    expect(columnIdForKanbanStatus(b, 'pending')).toBe('todo');
  });
  it('falls back to the first column when none match', () => {
    const bd = board([], [{ id: 'only', title: 'Only', order: 0, wipLimit: 0 }]);
    expect(columnIdForKanbanStatus(bd, 'pending')).toBe('only');
  });
});

describe('columnIdForTaskGraphStatus', () => {
  const b = board([]);
  it('maps each task-graph status to a column', () => {
    expect(columnIdForTaskGraphStatus(b, 'completed')).toBe('done');
    expect(columnIdForTaskGraphStatus(b, 'in_progress')).toBe('in-progress');
    expect(columnIdForTaskGraphStatus(b, 'review')).toBe('review');
    expect(columnIdForTaskGraphStatus(b, 'failed')).toBe('review');
    expect(columnIdForTaskGraphStatus(b, 'blocked')).toBe('blocked');
    expect(columnIdForTaskGraphStatus(b, 'pending')).toBe('backlog');
  });
});

// ── slugify / clampOrder / timestamps ────────────────────────────────

describe('slugify', () => {
  it('lowercases, trims, and replaces non-alphanumerics', () => {
    expect(slugify('  Hello, World!  ')).toBe('hello-world');
    expect(slugify('___trim___')).toBe('trim');
    expect(slugify('a b c')).toBe('a-b-c');
  });
  it('returns empty for all-symbol input', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('clampOrder', () => {
  it('returns max for non-finite or undefined order', () => {
    expect(clampOrder(undefined, 5)).toBe(5);
    expect(clampOrder(Number.NaN, 5)).toBe(5);
    expect(clampOrder(Number.POSITIVE_INFINITY, 5)).toBe(5);
  });
  it('clamps into [0, max] and truncates', () => {
    expect(clampOrder(-1, 5)).toBe(0);
    expect(clampOrder(3, 5)).toBe(3);
    expect(clampOrder(99, 5)).toBe(5);
    expect(clampOrder(3.9, 5)).toBe(3);
  });
});

describe('parseIsoTimestamp', () => {
  it('returns the parsed epoch when valid', () => {
    expect(parseIsoTimestamp('2026-07-17T00:00:00Z', 0)).toBe(Date.parse('2026-07-17T00:00:00Z'));
  });
  it('returns the fallback when value is falsy', () => {
    expect(parseIsoTimestamp(undefined, 42)).toBe(42);
    expect(parseIsoTimestamp('', 42)).toBe(42);
  });
  it('returns the fallback when the value is unparseable', () => {
    expect(parseIsoTimestamp('not-a-date', 42)).toBe(42);
  });
});

describe('isoFromTimestamp', () => {
  it('returns an ISO string for a finite timestamp', () => {
    expect(isoFromTimestamp(0, 'fallback')).toBe(new Date(0).toISOString());
  });
  it('returns the fallback for undefined or non-finite', () => {
    expect(isoFromTimestamp(undefined, 'fallback')).toBe('fallback');
    expect(isoFromTimestamp(Number.NaN, 'fallback')).toBe('fallback');
  });
});

// ── inferTaskType ────────────────────────────────────────────────────

describe('inferTaskType', () => {
  const cases: Array<[string, ReturnType<typeof inferTaskType>]> = [
    ['Fix the login bug', 'bugfix'],
    ['Refactor the parser', 'refactor'],
    ['Update README docs', 'docs'],
    ['Add a unit test', 'test'],
    ['Bump deps for maintenance', 'chore'],
    ['Build a new dashboard', 'feature'],
  ];
  for (const [title, expected] of cases) {
    it(`infers ${expected} from "${title}"`, () => {
      expect(inferTaskType(task({ id: 't', title }))).toBe(expected);
    });
  }
});

// ── isTaskFromGraph / buildTaskGraphMetadata ─────────────────────────

describe('isTaskFromGraph', () => {
  it('matches graph id and optional phase', () => {
    const t = task({ id: 't', origin: { system: 'x', graphId: 'g1', phaseId: 'p1' } });
    expect(isTaskFromGraph(t, 'g1', undefined)).toBe(true);
    expect(isTaskFromGraph(t, 'g1', 'p1')).toBe(true);
    expect(isTaskFromGraph(t, 'g1', 'p2')).toBe(false);
    expect(isTaskFromGraph(t, 'g2', undefined)).toBe(false);
  });
});

describe('buildTaskGraphMetadata', () => {
  it('always emits the kanban envelope and conditionally the nested fields', () => {
    const b = board([]);
    expect(buildTaskGraphMetadata(b, task({ id: 't' }))).toEqual({
      kanban: { boardId: 'board-1', taskId: 't', columnId: 'backlog', status: 'pending' },
    });
    const full = buildTaskGraphMetadata(
      b,
      task({
        id: 't',
        assignment: { status: 'running' },
        chain: { chainId: 'c', order: 0 },
        successCriteria: [{ id: 'c1', description: 'd', type: 'manual', status: 'pending' }],
        goalMetrics: [{ id: 'm1', name: 'n', status: 'pending' }],
        links: [{ url: 'u', type: 'url' }],
        notes: [{ id: 'n1', author: 'a', content: 'c', createdAt: 'now' }],
        origin: { system: 's', graphId: 'g' },
      }),
    );
    expect(full.kanban).toHaveProperty('assignment');
    expect(full.kanban).toHaveProperty('chain');
    expect(full.kanban).toHaveProperty('successCriteria');
    expect(full.kanban).toHaveProperty('goalMetrics');
    expect(full.kanban).toHaveProperty('links');
    expect(full.kanban).toHaveProperty('notes');
    expect(full.kanban).toHaveProperty('origin');
  });
});

// ── tasksInChain / rewireDependents ──────────────────────────────────

describe('tasksInChain', () => {
  it('returns chain tasks ordered by chain order then createdAt', () => {
    const b = board([
      task({ id: 'a', chain: { chainId: 'c', order: 1 }, createdAt: '2026-01-01T00:00:00Z' }),
      task({ id: 'b', chain: { chainId: 'c', order: 0 }, createdAt: '2026-01-02T00:00:00Z' }),
      task({ id: 'x' }),
    ]);
    expect(tasksInChain(b, 'c').map((t) => t.id)).toEqual(['b', 'a']);
  });
  it('returns empty when no task is in that chain', () => {
    expect(tasksInChain(board([task({ id: 'a' })]), 'missing')).toEqual([]);
  });
});

describe('rewireDependents', () => {
  it('rewires dependents of removed tasks onto the replacement set', () => {
    // The replacement targets (newA, newB) must exist on the board because
    // rewireDependents routes through normalizeDependencyIds which validates refs.
    const b = board([
      task({ id: 'parent', dependsOn: [] }),
      task({ id: 'newA' }),
      task({ id: 'newB' }),
      task({ id: 'other' }),
      task({ id: 'childA', dependsOn: ['parent'] }),
      task({ id: 'childB', dependsOn: ['parent', 'other'] }),
    ]);
    rewireDependents(b, 'parent', ['newA', 'newB']);
    expect(b.tasks.find((t) => t.id === 'childA')?.dependsOn).toEqual(['newA', 'newB']);
    // childB keeps 'other' and gains the new ids; parent is dropped
    expect(b.tasks.find((t) => t.id === 'childB')?.dependsOn).toEqual(['other', 'newA', 'newB']);
  });
  it('accepts arrays for from and exclude', () => {
    const b = board([task({ id: 'c', dependsOn: ['a', 'b'] })]);
    rewireDependents(b, ['a', 'b'], ['r'], ['c']);
    // excluded, no change
    expect(b.tasks[0]!.dependsOn).toEqual(['a', 'b']);
  });
  it('drops dependsOn when it becomes empty', () => {
    const b = board([task({ id: 'c', dependsOn: ['a'] })]);
    rewireDependents(b, 'a', []);
    expect(b.tasks[0]!.dependsOn).toBeUndefined();
  });
});

// ── remapIdList / remapTaskReferences ────────────────────────────────

describe('remapIdList', () => {
  it('returns remapped ids, filtering misses, undefined when empty', () => {
    const map = new Map([
      ['a', 'A'],
      ['b', 'B'],
    ]);
    expect(remapIdList(['a', 'b', 'c'], map)).toEqual(['A', 'B']);
    expect(remapIdList(['c'], map)).toBeUndefined();
    expect(remapIdList(undefined, map)).toBeUndefined();
  });
});

describe('remapTaskReferences', () => {
  it('remaps dependency/parent/merge/chain references via the id map', () => {
    const original = task({
      id: 'old',
      dependsOn: ['d1'],
      parentTaskId: 'p1',
      childTaskIds: ['c1'],
      mergedIntoTaskId: 'm1',
      mergedFromTaskIds: ['f1'],
      chain: { chainId: 'ch', order: 0, previousTaskId: 'prev', nextTaskId: 'next' },
    });
    const cloned = task({
      id: 'new',
      dependsOn: ['d1'],
      parentTaskId: 'p1',
      childTaskIds: ['c1'],
      mergedIntoTaskId: 'm1',
      mergedFromTaskIds: ['f1'],
      chain: { chainId: 'ch', order: 0, previousTaskId: 'prev', nextTaskId: 'next' },
    });
    const map = new Map([
      ['d1', 'd2'],
      ['p1', 'p2'],
      ['c1', 'c2'],
      ['m1', 'm2'],
      ['f1', 'f2'],
      ['prev', 'prev2'],
      ['next', 'next2'],
    ]);
    remapTaskReferences(cloned, original, map);
    expect(cloned.dependsOn).toEqual(['d2']);
    expect(cloned.parentTaskId).toBe('p2');
    expect(cloned.childTaskIds).toEqual(['c2']);
    expect(cloned.mergedIntoTaskId).toBe('m2');
    expect(cloned.mergedFromTaskIds).toEqual(['f2']);
    expect(cloned.chain).toMatchObject({ previousTaskId: 'prev2', nextTaskId: 'next2' });
  });
  it('deletes references that have no mapping', () => {
    const original = task({
      id: 'old',
      dependsOn: ['x'],
      parentTaskId: 'y',
      mergedIntoTaskId: 'z',
    });
    const cloned = task({ id: 'new', dependsOn: ['x'], parentTaskId: 'y', mergedIntoTaskId: 'z' });
    remapTaskReferences(cloned, original, new Map());
    expect(cloned.dependsOn).toBeUndefined();
    expect(cloned.parentTaskId).toBeUndefined();
    expect(cloned.mergedIntoTaskId).toBeUndefined();
  });
});

// ── taskGraphEdgesFromBoard ──────────────────────────────────────────

describe('taskGraphEdgesFromBoard', () => {
  it('emits depends_on edges and skips duplicates / self-edges / unmapped', () => {
    const b = board([
      task({ id: 'a', dependsOn: ['b'] }),
      task({ id: 'b', chain: { chainId: 'c', order: 0, nextTaskId: 'a' } }),
    ]);
    const map = new Map([
      ['a', 'na'],
      ['b', 'nb'],
    ]);
    const edges = taskGraphEdgesFromBoard(b.tasks, map);
    // one from dependsOn, one from chain.nextTaskId; both resolve to nb->na
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: 'nb', to: 'na', type: 'depends_on' });
  });
  it('skips edges entirely when ids are missing from the map', () => {
    const b = board([task({ id: 'a', dependsOn: ['b'] })]);
    expect(taskGraphEdgesFromBoard(b.tasks, new Map())).toEqual([]);
  });
});

// ── dependency helpers from dependencies.ts ──────────────────────────

describe('areDependenciesMet + findBlockedTasks together', () => {
  const b = board([
    task({ id: 'a' }),
    task({ id: 'b', dependsOn: ['a'] }), // a not completed => blocked
    task({ id: 'c', status: 'completed', dependsOn: ['a'], completedAt: 'now' }), // completed, still depends on a but done
  ]);
  it('returns false when a dependency is incomplete', () => {
    expect(areDependenciesMet(b, 'b')).toBe(false);
  });
  it('returns true when no deps', () => {
    expect(areDependenciesMet(b, 'a')).toBe(true);
  });
  it('returns the non-completed dependents in findBlockedTasks', () => {
    expect(findBlockedTasks(b, 'a').map((t) => t.id)).toEqual(['b']);
  });
  it('returns [] for an unknown task', () => {
    expect(findBlockedTasks(b, 'nope')).toEqual([]);
  });
});

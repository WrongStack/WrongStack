/**
 * Gap-closing tests for:
 *   - _internal.ts: findTask prefix ambiguity, selectRecoveryMode rule edges,
 *     existingColumnId ambiguity, normalizeDependencyIds cycle detection,
 *     reconcileTaskColumns, columnIdForTaskGraphStatus fallback
 *   - tasks.ts: various uncovered branches
 *   - boards.ts: board-level operations uncovered branches
 */
import { describe, expect, it } from 'vitest';
import {
  findTask,
  existingColumnId,
  selectRecoveryMode,
  normalizeDependencyIds,
  reconcileTaskColumns,
  columnIdForTaskGraphStatus,
  isTaskReadyForWork,
  addDependencyToTask,
  assertNoDependencyCycles,
} from '../src/manager/_internal.js';
import type { KanbanBoard, KanbanTask, KanbanRecoveryMode } from '../src/types.js';

// ── findTask: prefix ambiguity ──────────────────────────────────
describe('findTask - prefix matching', () => {
  function boardWithTasks(): KanbanBoard {
    return {
      id: 'b1',
      title: 'Test',
      columns: [{ id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 }],
      tasks: [
        {
          id: 'abc-111',
          title: 'Task 1',
          columnId: 'backlog',
          order: 0,
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'abc-222',
          title: 'Task 2',
          columnId: 'backlog',
          order: 1,
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      revision: 0,
    } as KanbanBoard;
  }

  it('finds by exact id', () => {
    const board = boardWithTasks();
    const task = findTask(board, 'abc-111');
    expect(task).toBeDefined();
    expect(task!.id).toBe('abc-111');
  });

  it('finds by unique prefix', () => {
    const board = boardWithTasks();
    // 'abc-11' only matches abc-111, not abc-222
    const task = findTask(board, 'abc-11');
    expect(task).toBeDefined();
    expect(task!.id).toBe('abc-111');
  });

  it('throws on ambiguous prefix', () => {
    const board = boardWithTasks();
    // Both tasks start with 'abc-'
    expect(() => findTask(board, 'abc-')).toThrow('Ambiguous kanban task id');
  });

  it('returns undefined for non-matching', () => {
    const board = boardWithTasks();
    const task = findTask(board, 'xyz');
    expect(task).toBeUndefined();
  });
});

// ── existingColumnId: prefix ambiguity ──────────────────────────
describe('existingColumnId - prefix matching', () => {
  function boardWithColumns(): KanbanBoard {
    return {
      id: 'b1',
      title: 'Test',
      columns: [
        { id: 'in-progress', title: 'In Progress', order: 0, wipLimit: 5 },
        { id: 'in-review', title: 'In Review', order: 1, wipLimit: 5 },
        { id: 'done', title: 'Done', order: 2, wipLimit: 0 },
      ],
      tasks: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      revision: 0,
    } as KanbanBoard;
  }

  it('finds by exact id', () => {
    expect(existingColumnId(boardWithColumns(), 'done')).toBe('done');
  });

  it('finds by unique prefix', () => {
    expect(existingColumnId(boardWithColumns(), 'in-re')).toBe('in-review');
  });

  it('returns undefined for non-matching', () => {
    expect(existingColumnId(boardWithColumns(), 'nonexistent')).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(existingColumnId(boardWithColumns(), undefined)).toBeUndefined();
  });

  it('throws on ambiguous prefix', () => {
    expect(() => existingColumnId(boardWithColumns(), 'in-')).toThrow('Ambiguous kanban column id');
  });
});

// ── selectRecoveryMode: rule edges ──────────────────────────────
describe('selectRecoveryMode - rule edges', () => {
  const baseArgs = {
    requested: 'auto' as KanbanRecoveryMode,
    task: {
      assignment: {
        status: 'running' as const,
        claimedAt: '2026-01-01T00:00:00.000Z',
      },
    } as KanbanTask,
    isHeartbeatDue: false,
    policy: undefined,
  };

  it('returns requested mode when not auto', () => {
    const result = selectRecoveryMode({ ...baseArgs, requested: 'retry' });
    expect(result).toBe('retry');
  });

  it('returns retry when no assignment', () => {
    const result = selectRecoveryMode({
      ...baseArgs,
      task: {} as KanbanTask,
    });
    expect(result).toBe('retry');
  });

  it('returns fail when retryPolicy is off', () => {
    const result = selectRecoveryMode({
      ...baseArgs,
      task: { assignment: { ...baseArgs.task.assignment!, retryPolicy: 'off' } } as KanbanTask,
    });
    expect(result).toBe('fail');
  });

  it('returns release when failureKind matches policy', () => {
    const result = selectRecoveryMode({
      ...baseArgs,
      task: {
        assignment: {
          ...baseArgs.task.assignment!,
          lastFailureKind: 'timeout',
        },
      } as KanbanTask,
      policy: {
        releaseOnFailureKinds: ['timeout'],
        failWhenCostCeilingSet: false,
        releaseOnHeartbeatDue: false,
      },
    });
    expect(result).toBe('release');
  });

  it('returns fail when cost ceiling set and policy says fail', () => {
    const result = selectRecoveryMode({
      ...baseArgs,
      task: {
        assignment: {
          ...baseArgs.task.assignment!,
          costCeilingUsd: 5,
        },
      } as KanbanTask,
      policy: { failWhenCostCeilingSet: true, releaseOnHeartbeatDue: false },
    });
    expect(result).toBe('fail');
  });

  it('returns release when heartbeat due and policy says release', () => {
    const result = selectRecoveryMode({
      ...baseArgs,
      isHeartbeatDue: true,
      policy: { releaseOnHeartbeatDue: true, failWhenCostCeilingSet: false },
    });
    expect(result).toBe('release');
  });

  it('returns fail when maxAttempts exceeded', () => {
    const result = selectRecoveryMode({
      ...baseArgs,
      task: {
        assignment: {
          ...baseArgs.task.assignment!,
          maxAttempts: 3,
          attempt: 3,
        },
      } as KanbanTask,
    });
    expect(result).toBe('fail');
  });

  it('returns retry as default', () => {
    const result = selectRecoveryMode(baseArgs);
    expect(result).toBe('retry');
  });
});

// ── addDependencyToTask: cycle detection ────────────────────────
describe('addDependencyToTask - cycle detection', () => {
  function simpleBoard(): KanbanBoard {
    return {
      id: 'b1',
      title: 'Test',
      columns: [{ id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 }],
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          columnId: 'backlog',
          order: 0,
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 't2',
          title: 'Task 2',
          columnId: 'backlog',
          order: 1,
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      revision: 0,
    } as KanbanBoard;
  }

  it('throws on self-dependency', () => {
    const board = simpleBoard();
    expect(() => addDependencyToTask(board, board.tasks[0]!, board.tasks[0]!)).toThrow(
      'cannot depend on itself',
    );
  });

  it('throws on circular dependency', () => {
    const board = simpleBoard();
    // t1 depends on t2
    addDependencyToTask(board, board.tasks[0]!, board.tasks[1]!);
    // t2 depending on t1 would create a cycle
    expect(() => addDependencyToTask(board, board.tasks[1]!, board.tasks[0]!)).toThrow(
      'dependency cycle',
    );
  });
});

// ── reconcileTaskColumns ────────────────────────────────────────
describe('reconcileTaskColumns', () => {
  it('reassigns tasks in non-existent columns to fallback', () => {
    const board = {
      id: 'b1',
      title: 'Test',
      columns: [{ id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 }],
      tasks: [
        {
          id: 't1',
          title: 'Orphaned',
          columnId: 'deleted-col',
          order: 0,
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      revision: 0,
    } as KanbanBoard;
    reconcileTaskColumns(board, '2026-06-01T00:00:00.000Z');
    expect(board.tasks[0]!.columnId).toBe('backlog');
    expect(board.tasks[0]!.status).toBe('pending');
  });
});

// ── columnIdForTaskGraphStatus fallback ─────────────────────────
describe('columnIdForTaskGraphStatus fallback', () => {
  it('uses first column when no preferred match found', () => {
    const board = {
      id: 'b1',
      title: 'Test',
      columns: [{ id: 'sprint-backlog', title: 'Sprint Backlog', order: 0, wipLimit: 0 }],
      tasks: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      revision: 0,
    } as KanbanBoard;
    // completed status looks for 'done' or 'completed' - both absent
    const colId = columnIdForTaskGraphStatus(board, 'completed');
    expect(colId).toBe('sprint-backlog');
  });
});

// ── assertNoDependencyCycles ────────────────────────────────────
describe('assertNoDependencyCycles', () => {
  it('throws on self-referencing dependency', () => {
    const board = {
      id: 'b1',
      title: 'Test',
      columns: [{ id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 }],
      tasks: [
        {
          id: 't1',
          title: 'Self-dep',
          columnId: 'backlog',
          order: 0,
          status: 'pending',
          priority: 'medium',
          dependsOn: ['t1'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      revision: 0,
    } as KanbanBoard;
    expect(() => assertNoDependencyCycles(board)).toThrow('cannot depend on itself');
  });
});

// ── isTaskReadyForWork edges ────────────────────────────────────
describe('isTaskReadyForWork edges', () => {
  const baseTask = {
    id: 't1',
    title: 'Task',
    columnId: 'backlog',
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as KanbanTask;

  function board(task: KanbanTask): KanbanBoard {
    return {
      id: 'b1',
      title: 'Test',
      columns: [{ id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 }],
      tasks: [task],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      revision: 0,
    } as KanbanBoard;
  }

  it('returns false when task has active assignment in queued/running', () => {
    const task = { ...baseTask, status: 'ready', assignment: { status: 'queued' } } as KanbanTask;
    expect(isTaskReadyForWork(board(task), task)).toBe(false);
  });

  it('returns false when task is merged into another', () => {
    const task = { ...baseTask, status: 'ready', mergedIntoTaskId: 'other-task' } as KanbanTask;
    expect(isTaskReadyForWork(board(task), task)).toBe(false);
  });
});

// ── normalizeDependencyIds cycle detection ──────────────────────
describe('normalizeDependencyIds', () => {
  function simpleBoard(): KanbanBoard {
    return {
      id: 'b1',
      title: 'Test',
      columns: [{ id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 }],
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          columnId: 'backlog',
          order: 0,
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 't2',
          title: 'Task 2',
          columnId: 'backlog',
          order: 1,
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      revision: 0,
    } as KanbanBoard;
  }

  it('throws when dependency not found', () => {
    expect(() => normalizeDependencyIds(simpleBoard(), 't1', ['nonexistent'])).toThrow(
      'Dependency task not found',
    );
  });

  it('throws on self-dependency', () => {
    expect(() => normalizeDependencyIds(simpleBoard(), 't1', ['t1'])).toThrow(
      'cannot depend on itself',
    );
  });

  it('throws on cycle', () => {
    const board = simpleBoard();
    // Set up t1 depending on t2 directly on the task object
    board.tasks[0]!.dependsOn = ['t2'];
    // Now trying to make t2 depend on t1 creates a cycle
    // (t2 would depend on t1, which depends on t2)
    expect(() => normalizeDependencyIds(board, 't2', ['t1'])).toThrow('dependency cycle');
  });
});

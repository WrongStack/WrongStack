import { describe, expect, it } from 'vitest';
import { buildKanbanWorkbench } from '../src/test-support.js';
import type {
  KanbanBoardSummary,
  KanbanTask,
} from '../src/types.js';
import type { KanbanOrchestrationSnapshot, KanbanSearchResult } from '../src/types-operations.js';

const NOW = '2026-08-09T12:00:00.000Z';

function board(id: string, kind: KanbanBoardSummary['kind'] = 'project'): KanbanBoardSummary {
  return {
    id,
    title: `Board ${id}`,
    kind,
    columnCount: 5,
    taskCount: 10,
    completedTaskCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function task(id: string, overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id,
    title: `Task ${id}`,
    columnId: 'todo',
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function result(
  boardSummary: KanbanBoardSummary,
  currentTask: KanbanTask,
  contractStatus?: KanbanSearchResult['contractStatus'],
): KanbanSearchResult {
  return {
    board: boardSummary,
    task: currentTask,
    ...(contractStatus ? { contractStatus } : {}),
  };
}

describe('Kanban workbench projection', () => {
  it('bounds lanes, explains placement, preserves source kind, and rolls up children', () => {
    const managed = board('managed');
    const session = board('session', 'session_mirror');
    const childDone = result(managed, task('child-done', { status: 'completed' }));
    const childOpen = result(managed, task('child-open'));
    const parent = result(
      managed,
      task('parent', {
        title: 'Parent task',
        status: 'blocked',
        childTaskIds: ['child-done', 'child-open'],
        dependsOn: ['child-open'],
      }),
    );
    const running = result(
      session,
      task('running', {
        title: 'Live session work',
        status: 'in_progress',
        priority: 'critical',
        assignment: { status: 'running', leaseExpiresAt: '2026-08-09T11:59:00.000Z' },
      }),
    );
    const readyA = result(
      managed,
      task('ready-a', { title: 'Duplicate work', priority: 'critical' }),
      {
        enforcement: 'strict',
        startReady: false,
        setupGaps: 2,
        completionOpen: 4,
        closed: false,
      },
    );
    const readyB = result(managed, task('ready-b', { title: ' duplicate   work ' }));
    const snapshot: KanbanOrchestrationSnapshot = {
      generatedAt: NOW,
      boards: [managed, session],
      ready: [childOpen, readyA, readyB],
      queued: [],
      running: [running],
      blocked: [parent],
      review: [],
      failed: [],
      completed: [childDone],
    };

    const workbench = buildKanbanWorkbench(snapshot, {
      limitPerLane: 1,
      alertLimit: 1,
      now: NOW,
    });

    expect(workbench.boardCount).toBe(2);
    expect(workbench.lanes.next).toMatchObject({ total: 3, omitted: 2 });
    expect(workbench.lanes.now.items[0]).toMatchObject({
      source: 'session',
      reason: 'Live agent execution',
    });
    expect(workbench.lanes.blocked.items[0]).toMatchObject({
      blockedBy: 1,
      childProgress: { completed: 1, total: 2 },
      reason: '1 unresolved dependency',
    });
    expect(workbench.lanes.next.items[0]?.contractStatus).toMatchObject({
      startReady: false,
      setupGaps: 2,
      completionOpen: 4,
    });
    expect(workbench.alertTotal).toBe(2);
    expect(workbench.alerts).toHaveLength(1);
    expect(workbench.alerts[0]?.kind).toBe('stale_running');
    expect(workbench.alertsOmitted).toBe(1);
  });

  it('clamps requested response limits so callers cannot request an unbounded surface', () => {
    const summary = board('bounded');
    const ready = Array.from({ length: 70 }, (_, index) =>
      result(summary, task(`task-${index}`, { title: `Unique task ${index}` })),
    );
    const snapshot: KanbanOrchestrationSnapshot = {
      generatedAt: NOW,
      boards: [summary],
      ready,
      queued: [],
      running: [],
      blocked: [],
      review: [],
      failed: [],
      completed: [],
    };

    const workbench = buildKanbanWorkbench(snapshot, { limitPerLane: 10_000 });
    expect(workbench.lanes.next.items).toHaveLength(50);
    expect(workbench.lanes.next.omitted).toBe(20);
  });
});

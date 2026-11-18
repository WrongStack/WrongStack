import type {
  KanbanBoard,
  KanbanBoardHistoryEntry,
  KanbanColumn,
  KanbanQueueHealth,
  KanbanSupervisorSnapshot,
  KanbanTask,
} from '@wrongstack/kanban';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetKanbanStore, useKanbanStore } from '../src/kanban/kanban-store';

const NOW = '2026-11-18T12:00:00.000Z';

function makeTask(id: string, title: string): KanbanTask {
  return {
    id,
    title,
    columnId: 'backlog',
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeBoard(id: string, tasks: KanbanTask[] = []): KanbanBoard {
  return {
    id,
    title: `Board ${id}`,
    columns: [{ id: 'backlog', title: 'Backlog', order: 0 }],
    tasks,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  };
}

function makeHealth(boardId: string, startable: number): KanbanQueueHealth {
  return {
    generatedAt: NOW,
    boardIds: [boardId],
    counts: {
      ready: 0,
      startable,
      queued: 0,
      running: 0,
      review: 0,
      failed: 0,
      completed: 0,
      pending: startable,
      archived: 0,
      blocked: 0,
    },
    dependencyBlocked: { count: 0, tasks: [] },
    staleAssignments: { count: 0, tasks: [] },
    failedRetryable: { count: 0, tasks: [] },
    heartbeatDue: { count: 0, tasks: [] },
  };
}

describe('useKanbanStore stale board switch & cross-board reply fencing (F533)', () => {
  beforeEach(() => {
    resetKanbanStore();
  });

  it('clears mismatched activeBoard on board switch/deselect and drops delayed supervisor, health, and history replies from the previous board', () => {
    const b1 = makeBoard('b1', [makeTask('t1', 'Task 1')]);
    useKanbanStore.getState().setActiveBoardId('b1');
    useKanbanStore.getState().handleResult('kanban.get', { success: true, data: b1 });
    useKanbanStore.getState().setActiveBoardId('b1');
    expect(useKanbanStore.getState().activeBoard?.id).toBe('b1');

    // Switch to b2 before kanban.get('b2') arrives: activeBoard must be cleared immediately.
    useKanbanStore.getState().setActiveBoardId('b2');
    expect(useKanbanStore.getState().activeBoard).toBeNull();

    useKanbanStore.getState().handleResult('kanban.task.get', {
      success: true,
      data: makeTask('t-stale', 'Stale bare task'),
    });
    useKanbanStore.getState().handleResult('kanban.column.add', {
      success: true,
      data: [{ id: 'done', title: 'Done', order: 1 } satisfies KanbanColumn],
    });
    expect(useKanbanStore.getState().activeBoard).toBeNull();

    const b2 = makeBoard('b2', [makeTask('t2', 'Task 2')]);
    useKanbanStore.getState().handleResult('kanban.get', { success: true, data: b2 });

    // Stale b1 supervisor, health, and history replies must be ignored.
    useKanbanStore.getState().handleResult('kanban.supervisor.status', {
      success: true,
      data: {
        boardId: 'b1',
        status: 'error',
        mode: 'agentic',
        reconciledTaskIds: [],
        staleRecoveredTaskIds: [],
        anomalyCount: 4,
      } satisfies KanbanSupervisorSnapshot,
    });
    useKanbanStore.getState().handleResult('kanban.health', {
      success: true,
      data: makeHealth('b1', 9),
    });
    useKanbanStore.getState().handleResult('kanban.board.history', {
      success: true,
      data: [
        {
          id: 'h1',
          boardId: 'b1',
          type: 'board.created',
          timestamp: NOW,
        } as unknown as KanbanBoardHistoryEntry,
      ],
    });

    expect(useKanbanStore.getState().supervisorSnapshot).toBeNull();
    expect(useKanbanStore.getState().queueHealth).toBeNull();
    expect(useKanbanStore.getState().boardHistory).toEqual([]);

    // Matching b2 replies populate state.
    useKanbanStore.getState().handleResult('kanban.supervisor.audit', {
      success: true,
      data: {
        boardId: 'b2',
        status: 'healthy',
        mode: 'deterministic',
        reconciledTaskIds: [],
        staleRecoveredTaskIds: [],
        anomalyCount: 0,
      } satisfies KanbanSupervisorSnapshot,
    });
    useKanbanStore.getState().handleResult('kanban.health', {
      success: true,
      data: makeHealth('b2', 2),
    });
    useKanbanStore.getState().handleResult('kanban.board.history', {
      success: true,
      data: [
        {
          id: 'h2',
          boardId: 'b2',
          type: 'board.created',
          timestamp: NOW,
        } as unknown as KanbanBoardHistoryEntry,
      ],
    });

    expect(useKanbanStore.getState().supervisorSnapshot?.boardId).toBe('b2');
    expect(useKanbanStore.getState().queueHealth?.boardIds).toEqual(['b2']);
    expect(useKanbanStore.getState().boardHistory).toHaveLength(1);

    // Deselecting clears activeBoard too.
    useKanbanStore.getState().setActiveBoardId(null);
    expect(useKanbanStore.getState().activeBoard).toBeNull();
  });
});

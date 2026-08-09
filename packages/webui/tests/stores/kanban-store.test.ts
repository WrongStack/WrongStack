import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { beforeEach, describe, expect, it } from 'vitest';
import { useKanbanStore } from '../../src/stores/kanban-store.js';

const now = '2026-07-06T00:00:00.000Z';

function task(id: string, title: string, columnId = 'backlog'): KanbanTask {
  return {
    id,
    title,
    columnId,
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
}

function board(id: string, tasks: KanbanTask[] = []): KanbanBoard {
  return {
    id,
    title: `Board ${id}`,
    columns: [{ id: 'backlog', title: 'Backlog', order: 0 }],
    tasks,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

describe('kanban-store', () => {
  beforeEach(() => {
    useKanbanStore.setState({
      boards: [],
      activeBoardId: null,
      activeBoard: null,
      loading: false,
      error: null,
    });
  });

  it('updates active board summaries when task results arrive', () => {
    const active = board('b1');
    useKanbanStore.setState({
      boards: [
        {
          id: active.id,
          title: active.title,
          createdAt: active.createdAt,
          updatedAt: active.updatedAt,
          columnCount: 1,
          taskCount: 0,
          completedTaskCount: 0,
        },
      ],
      activeBoardId: active.id,
      activeBoard: active,
    });

    useKanbanStore.getState().handleResult('kanban.task.add', {
      success: true,
      data: task('t1', 'New task'),
    });

    const state = useKanbanStore.getState();
    expect(state.activeBoard?.tasks.map((item) => item.title)).toEqual(['New task']);
    expect(state.boards[0]?.taskCount).toBe(1);
  });

  it('removes the requested board instead of whichever board is currently active', () => {
    const first = board('b1');
    const second = board('b2');
    useKanbanStore.getState().handleResult('kanban.list', {
      success: true,
      data: [first, second].map((item) => ({
        id: item.id,
        title: item.title,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        columnCount: 1,
        taskCount: item.tasks.length,
        completedTaskCount: 0,
      })),
    });
    useKanbanStore.setState({ activeBoardId: second.id, activeBoard: second });

    useKanbanStore.getState().handleResult('kanban.delete', {
      success: true,
      data: { removed: true, boardId: first.id },
    });

    const state = useKanbanStore.getState();
    expect(state.boards.map((item) => item.id)).toEqual([second.id]);
    expect(state.activeBoardId).toBe(second.id);
    expect(state.activeBoard?.id).toBe(second.id);
  });

  it('kanban.delete decrements the board totals for the removed bucket', () => {
    useKanbanStore.getState().handleResult('kanban.list', {
      success: true,
      data: [
        {
          id: 'active-board',
          title: 'Active board',
          createdAt: now,
          updatedAt: now,
          columnCount: 1,
          taskCount: 0,
          completedTaskCount: 0,
          presence: [
            {
              id: 'presence-1',
              sessionId: 'session-1',
              agentId: 'leader',
              lastSeenAt: now,
              expiresAt: now,
              active: true,
            },
          ],
        },
        {
          id: 'orphan-board',
          title: 'Orphan board',
          createdAt: now,
          updatedAt: now,
          columnCount: 1,
          taskCount: 0,
          completedTaskCount: 0,
        },
      ],
    });
    expect(useKanbanStore.getState().boardTotal).toBe(2);
    expect(useKanbanStore.getState().activeBoardTotal).toBe(1);
    expect(useKanbanStore.getState().orphanedBoardTotal).toBe(1);

    useKanbanStore.getState().handleResult('kanban.delete', {
      success: true,
      data: { removed: true, boardId: 'active-board' },
    });
    let state = useKanbanStore.getState();
    expect(state.boardTotal).toBe(1);
    expect(state.activeBoardTotal).toBe(0);
    expect(state.orphanedBoardTotal).toBe(1);

    useKanbanStore.getState().handleResult('kanban.delete', {
      success: true,
      data: { removed: true, boardId: 'orphan-board' },
    });
    state = useKanbanStore.getState();
    expect(state.boardTotal).toBe(0);
    expect(state.activeBoardTotal).toBe(0);
    expect(state.orphanedBoardTotal).toBe(0);
  });

  it('kanban.delete leaves totals alone when nothing was removed', () => {
    useKanbanStore.getState().handleResult('kanban.list', {
      success: true,
      data: [
        {
          id: 'only-board',
          title: 'Only board',
          createdAt: now,
          updatedAt: now,
          columnCount: 1,
          taskCount: 0,
          completedTaskCount: 0,
        },
      ],
    });
    useKanbanStore.getState().handleResult('kanban.delete', {
      success: true,
      data: { removed: false, boardId: 'only-board' },
    });
    const state = useKanbanStore.getState();
    expect(state.boards).toHaveLength(1);
    expect(state.boardTotal).toBe(1);
    expect(state.orphanedBoardTotal).toBe(1);
  });

  it('accepts paginated board results and exposes active/orphan totals', () => {
    useKanbanStore.getState().handleResult('kanban.list', {
      success: true,
      data: {
        items: [
          {
            id: 'active-board',
            title: 'Active board',
            createdAt: now,
            updatedAt: now,
            columnCount: 1,
            taskCount: 2,
            completedTaskCount: 0,
            presence: [
              {
                id: 'presence-1',
                sessionId: 'session-1',
                agentId: 'leader',
                lastSeenAt: now,
                expiresAt: now,
                active: true,
              },
            ],
          },
        ],
        total: 25,
        page: 1,
        pageSize: 12,
        totalPages: 3,
        activeTotal: 4,
        orphanedTotal: 21,
      },
    });

    const state = useKanbanStore.getState();
    expect(state.boards).toHaveLength(1);
    expect(state.boardTotal).toBe(25);
    expect(state.activeBoardTotal).toBe(4);
    expect(state.orphanedBoardTotal).toBe(21);
  });

  it('applies task removal payloads with full board data', () => {
    const active = board('b1', [task('t1', 'Remove me')]);
    const afterRemoval = board('b1', []);
    useKanbanStore.setState({
      boards: [
        {
          id: active.id,
          title: active.title,
          createdAt: active.createdAt,
          updatedAt: active.updatedAt,
          columnCount: 1,
          taskCount: 1,
          completedTaskCount: 0,
        },
      ],
      activeBoardId: active.id,
      activeBoard: active,
    });

    useKanbanStore.getState().handleResult('kanban.task.remove', {
      success: true,
      data: { removed: true, boardId: active.id, taskId: 't1', board: afterRemoval },
    });

    const state = useKanbanStore.getState();
    expect(state.activeBoard?.tasks).toEqual([]);
    expect(state.boards[0]?.taskCount).toBe(0);
  });

  it('ignores task envelopes for a different active board', () => {
    const active = board('b1');
    useKanbanStore.setState({ activeBoardId: active.id, activeBoard: active });

    useKanbanStore.getState().handleResult('kanban.task.update', {
      success: true,
      data: { boardId: 'b2', task: task('t2', 'Other board task') },
    });

    expect(useKanbanStore.getState().activeBoard?.tasks).toEqual([]);
  });

  it('updates board envelope summaries without switching the active board', () => {
    const active = board('b1');
    const other = board('b2', [task('t2', 'Other board task')]);
    useKanbanStore.setState({
      boards: [
        {
          id: active.id,
          title: active.title,
          createdAt: active.createdAt,
          updatedAt: active.updatedAt,
          columnCount: 1,
          taskCount: 0,
          completedTaskCount: 0,
        },
      ],
      activeBoardId: active.id,
      activeBoard: active,
    });

    useKanbanStore.getState().handleResult('kanban.task.merge', {
      success: true,
      data: { board: other, task: other.tasks[0] },
    });

    const state = useKanbanStore.getState();
    expect(state.activeBoard?.id).toBe(active.id);
    expect(state.boards.find((item) => item.id === other.id)?.taskCount).toBe(1);
  });

  it('does not switch boards when a realtime kanban.get arrives for another board', () => {
    const active = board('b1');
    const changedElsewhere = board('b2', [task('t2', 'Realtime task')]);
    useKanbanStore.setState({
      activeBoardId: active.id,
      activeBoard: active,
    });

    useKanbanStore.getState().handleResult('kanban.get', {
      success: true,
      data: changedElsewhere,
    });

    const state = useKanbanStore.getState();
    expect(state.activeBoardId).toBe(active.id);
    expect(state.activeBoard?.id).toBe(active.id);
    expect(state.boards.find((item) => item.id === changedElsewhere.id)?.taskCount).toBe(1);
  });

  it('applies kanban.get when it matches the selected board', () => {
    const active = board('b1');
    const refreshed = board('b1', [task('t1', 'Fresh task')]);
    useKanbanStore.setState({
      activeBoardId: active.id,
      activeBoard: active,
    });

    useKanbanStore.getState().handleResult('kanban.get', {
      success: true,
      data: refreshed,
    });

    const state = useKanbanStore.getState();
    expect(state.activeBoardId).toBe(active.id);
    expect(state.activeBoard?.tasks.map((item) => item.title)).toEqual(['Fresh task']);
  });
});

describe('kanban-store — verification activity', () => {
  beforeEach(() => {
    useKanbanStore.setState({
      boards: [],
      activeBoardId: null,
      activeBoard: null,
      loading: false,
      error: null,
      verificationActivity: {},
    });
  });

  it('tracks verification_started and clears on verification_completed', () => {
    const active = board('b1', [task('t1', 'Verify me')]);
    useKanbanStore.setState({ activeBoardId: active.id, activeBoard: active });

    useKanbanStore.getState().handleResult('kanban.task.verification_started', {
      success: true,
      data: { boardId: 'b1', taskId: 't1' },
    });
    expect(useKanbanStore.getState().verificationActivity['b1:t1']).toBeDefined();

    const verified: KanbanTask = {
      ...task('t1', 'Verify me'),
      verificationReport: {
        taskId: 't1',
        taskTitle: 'Verify me',
        boardId: 'b1',
        startedAt: now,
        completedAt: now,
        verdict: 'passed',
        checks: [],
        markdownSummary: '',
        attachments: [],
      },
    };
    useKanbanStore.getState().handleResult('kanban.task.verification_completed', {
      success: true,
      data: { boardId: 'b1', task: verified },
    });
    const state = useKanbanStore.getState();
    expect(state.verificationActivity['b1:t1']).toBeUndefined();
    expect(state.activeBoard?.tasks[0]?.verificationReport?.verdict).toBe('passed');
  });

  it('a decomposition.applied {board} broadcast never hijacks another active board', () => {
    const active = board('b1', [task('t1', 'Mine')]);
    useKanbanStore.setState({ activeBoardId: active.id, activeBoard: active });

    useKanbanStore.getState().handleResult('kanban.decomposition.applied', {
      success: true,
      data: { board: board('b2', [task('t2', 'Other board task')]) },
    });
    const state = useKanbanStore.getState();
    expect(state.activeBoardId).toBe('b1');
    expect(state.activeBoard?.id).toBe('b1');
    // The other board's summary is still tracked.
    expect(state.boards.some((summary) => summary.id === 'b2')).toBe(true);
  });
});

describe('kanban-store — outbound actions flip loading state', () => {
  beforeEach(() => {
    useKanbanStore.setState({
      loading: false,
      error: null,
      lastOutboundAction: null,
    });
  });

  it('sendKanban sets loading=true and records lastOutboundAction', () => {
    const state = useKanbanStore.getState();
    expect(state.loading).toBe(false);

    state.sendKanban('kanban.list', { page: 0 });

    const after = useKanbanStore.getState();
    expect(after.loading).toBe(true);
    expect(after.lastOutboundAction).toBe('kanban.list');
  });

  it('transitionTask maps to kanban.task.transition and flips loading', () => {
    useKanbanStore.getState().transitionTask('b1', 't1', 'done', { comment: 'ok' });
    const after = useKanbanStore.getState();
    expect(after.loading).toBe(true);
    expect(after.lastOutboundAction).toBe('kanban.task.transition');
  });

  it('dispatchTask maps to kanban.task.dispatch and flips loading', () => {
    useKanbanStore.getState().dispatchTask('b1', 't1', 'Investigate flaky test');
    const after = useKanbanStore.getState();
    expect(after.loading).toBe(true);
    expect(after.lastOutboundAction).toBe('kanban.task.dispatch');
  });

  it('moveTask maps to kanban.task.move and flips loading', () => {
    useKanbanStore.getState().moveTask('b1', 't1', 'review');
    const after = useKanbanStore.getState();
    expect(after.loading).toBe(true);
    expect(after.lastOutboundAction).toBe('kanban.task.move');
  });

  it('removeTask maps to kanban.task.remove and flips loading', () => {
    useKanbanStore.getState().removeTask('b1', 't1');
    const after = useKanbanStore.getState();
    expect(after.loading).toBe(true);
    expect(after.lastOutboundAction).toBe('kanban.task.remove');
  });

  it('setLoading(false) clears the spinner flag', () => {
    useKanbanStore.getState().sendKanban('kanban.list', {});
    expect(useKanbanStore.getState().loading).toBe(true);
    useKanbanStore.getState().setLoading(false);
    expect(useKanbanStore.getState().loading).toBe(false);
  });
});

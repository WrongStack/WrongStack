import { beforeEach, describe, expect, it } from 'vitest';
import { useKanbanStore } from '../../src/stores/kanban-store';

/**
 * `handleResult` is one long type-switch over every `kanban.*` reply. Each
 * branch shapes the store differently and several only fire for a specific
 * payload envelope, so they are driven here one message type at a time.
 */

function board(id = 'b1', overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Board ${id}`,
    columns: [{ id: 'todo', name: 'Todo' }],
    tasks: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function task(id = 't1', overrides: Record<string, unknown> = {}) {
  return { id, title: `Task ${id}`, column: 'todo', ...overrides };
}

function summary(id = 'b1', overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Board ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    columnCount: 1,
    taskCount: 0,
    completedTaskCount: 0,
    ...overrides,
  };
}

function result(type: string, data: unknown, success = true) {
  useKanbanStore.getState().handleResult(type, { success, data } as never);
}

function state() {
  return useKanbanStore.getState();
}

beforeEach(() => {
  useKanbanStore.setState({
    boards: [],
    boardTotal: 0,
    activeBoardTotal: 0,
    orphanedBoardTotal: 0,
    activeBoardId: null,
    activeBoard: null,
    loading: true,
    error: 'stale',
    queueHealth: null,
    supervisorSnapshot: null,
    verificationActivity: {},
  });
});

describe('failure envelope', () => {
  it('surfaces the server error and stops the spinner', () => {
    useKanbanStore.getState().handleResult('kanban.list', {
      success: false,
      error: 'board locked',
    } as never);

    expect(state()).toMatchObject({ loading: false, error: 'board locked' });
  });

  it('falls back to a generic message', () => {
    useKanbanStore.getState().handleResult('kanban.list', { success: false } as never);
    expect(state().error).toBe('Kanban request failed');
  });
});

describe('kanban.list', () => {
  it('accepts a paged envelope and keeps the server totals', () => {
    result('kanban.list', {
      items: [summary('b1'), summary('b2')],
      total: 40,
      activeTotal: 3,
      orphanedTotal: 37,
    });

    expect(state()).toMatchObject({
      boardTotal: 40,
      activeBoardTotal: 3,
      orphanedBoardTotal: 37,
    });
    expect(state().boards).toHaveLength(2);
  });

  it('derives the totals itself from a bare array', () => {
    result('kanban.list', [
      summary('b1', { presence: [{ agentId: 'a', active: true }] }),
      summary('b2', { presence: [{ agentId: 'a', active: false }] }),
      summary('b3'),
    ]);

    expect(state()).toMatchObject({
      boardTotal: 3,
      activeBoardTotal: 1,
      orphanedBoardTotal: 2,
    });
  });

  it('treats an unrecognised payload as an empty list', () => {
    result('kanban.list', { nonsense: true });
    expect(state()).toMatchObject({ boards: [], boardTotal: 0 });
  });

  it('falls back to the item count when the page omits the breakdown', () => {
    result('kanban.list', { items: [summary('b1')], total: 1 });
    expect(state()).toMatchObject({ activeBoardTotal: 0, orphanedBoardTotal: 1 });
  });
});

describe('supervisor and health', () => {
  it.each(['kanban.supervisor.status', 'kanban.supervisor.audit'])(
    '%s stores the snapshot',
    (type) => {
      result(type, { runningAgents: 2 });
      expect(state().supervisorSnapshot).toMatchObject({ runningAgents: 2 });
    },
  );

  it('ignores a supervisor reply with no data', () => {
    result('kanban.supervisor.status', null);
    expect(state().supervisorSnapshot).toBeNull();
  });

  it('kanban.health stores the queue health', () => {
    result('kanban.health', { pending: 4 });
    expect(state().queueHealth).toMatchObject({ pending: 4 });
  });
});

describe('kanban.delete', () => {
  beforeEach(() => {
    useKanbanStore.setState({
      boards: [summary('b1'), summary('b2')],
      activeBoardId: 'b1',
      activeBoard: board('b1') as never,
    });
  });

  it('drops the deleted board and clears the active selection', () => {
    result('kanban.delete', { removed: true, boardId: 'b1' });

    expect(state().boards.map((b) => b.id)).toEqual(['b2']);
    expect(state().activeBoardId).toBeNull();
    expect(state().activeBoard).toBeNull();
  });

  it('keeps a different board selected', () => {
    result('kanban.delete', { removed: true, boardId: 'b2' });
    expect(state().activeBoardId).toBe('b1');
    expect(state().activeBoard).not.toBeNull();
  });

  it('falls back to the active board id when the reply omits one', () => {
    result('kanban.delete', { removed: true });
    expect(state().boards.map((b) => b.id)).toEqual(['b2']);
  });

  it('changes nothing when the delete did not happen', () => {
    result('kanban.delete', { removed: false, boardId: 'b1' });
    expect(state().boards).toHaveLength(2);
    expect(state().activeBoardId).toBe('b1');
  });
});

describe('kanban.task.remove', () => {
  beforeEach(() => {
    useKanbanStore.setState({
      boards: [],
      activeBoardId: 'b1',
      activeBoard: board('b1', { tasks: [task('t1'), task('t2')] }) as never,
    });
  });

  it('prefers a full board envelope when the server sends one', () => {
    result('kanban.task.remove', { board: board('b1', { tasks: [task('t2')] }) });
    expect(state().activeBoard?.tasks.map((t) => t.id)).toEqual(['t2']);
    expect(state().boards.map((b) => b.id)).toEqual(['b1']);
  });

  it('falls through to id removal when the board envelope is for another board', () => {
    result('kanban.task.remove', { board: board('b9'), removed: true, taskId: 't1' });
    // The envelope is ignored (wrong board), but the reply carries no boardId,
    // so the id-based path still applies the removal to the open board.
    expect(state().activeBoard?.tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('removes the task by id when only ids come back', () => {
    result('kanban.task.remove', { removed: true, taskId: 't1', boardId: 'b1' });
    expect(state().activeBoard?.tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('accepts an id-only removal with no board id', () => {
    result('kanban.task.remove', { removed: true, taskId: 't2' });
    expect(state().activeBoard?.tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('leaves the board alone when the removal targeted another board', () => {
    result('kanban.task.remove', { removed: true, taskId: 't1', boardId: 'b9' });
    expect(state().activeBoard?.tasks).toHaveLength(2);
  });

  it('leaves the board alone when nothing was removed', () => {
    result('kanban.task.remove', { removed: false, taskId: 't1', boardId: 'b1' });
    expect(state().activeBoard?.tasks).toHaveLength(2);
  });
});

describe('verification activity', () => {
  it('records a spinner keyed by board and task', () => {
    result('kanban.task.verification_started', { boardId: 'b1', taskId: 't1' });
    expect(state().verificationActivity['b1:t1']).toMatchObject({
      startedAt: expect.any(Number),
    });
  });

  it('ignores a start with no ids to key on', () => {
    result('kanban.task.verification_started', { boardId: 'b1' });
    expect(state().verificationActivity).toEqual({});
  });

  it('clears the spinner and applies the task on completion', () => {
    useKanbanStore.setState({
      activeBoardId: 'b1',
      activeBoard: board('b1', { tasks: [task('t1', { title: 'old' })] }) as never,
      verificationActivity: { 'b1:t1': { startedAt: 1 } },
    });
    result('kanban.task.verification_completed', {
      boardId: 'b1',
      task: task('t1', { title: 'verified' }),
    });

    expect(state().verificationActivity).toEqual({});
    expect(state().activeBoard?.tasks[0]).toMatchObject({ title: 'verified' });
  });

  it('clears the spinner even when the board is not selected', () => {
    useKanbanStore.setState({
      activeBoardId: 'b9',
      activeBoard: board('b9') as never,
      verificationActivity: { 'b1:t1': { startedAt: 1 } },
    });
    result('kanban.task.verification_completed', { boardId: 'b1', task: task('t1') });

    expect(state().verificationActivity).toEqual({});
    expect(state().activeBoard?.id).toBe('b9');
  });
});

describe('generic envelopes', () => {
  it('a board envelope adopts the board when it is the selected one', () => {
    useKanbanStore.setState({ activeBoardId: 'b1', activeBoard: null });
    result('kanban.update', { board: board('b1', { name: 'renamed' }) });
    expect(state().activeBoard).toMatchObject({ name: 'renamed' });
  });

  it('a board envelope for another board only updates the summary list', () => {
    useKanbanStore.setState({ activeBoardId: 'b1', activeBoard: board('b1') as never });
    result('kanban.update', { board: board('b9') });
    expect(state().activeBoard?.id).toBe('b1');
    expect(state().boards.map((b) => b.id)).toEqual(['b9']);
  });

  it('a task envelope upserts into the matching active board', () => {
    useKanbanStore.setState({
      activeBoardId: 'b1',
      activeBoard: board('b1', { tasks: [task('t1', { title: 'old' })] }) as never,
    });
    result('kanban.task.update', { boardId: 'b1', task: task('t1', { title: 'new' }) });
    expect(state().activeBoard?.tasks[0]).toMatchObject({ title: 'new' });
  });

  it('a task envelope appends a task the board has not seen', () => {
    useKanbanStore.setState({ activeBoardId: 'b1', activeBoard: board('b1') as never });
    result('kanban.task.add', { boardId: 'b1', task: task('t9') });
    expect(state().activeBoard?.tasks.map((t) => t.id)).toEqual(['t9']);
  });

  it('a task envelope for another board is dropped', () => {
    useKanbanStore.setState({ activeBoardId: 'b1', activeBoard: board('b1') as never });
    result('kanban.task.update', { boardId: 'b9', task: task('t1') });
    expect(state().activeBoard?.tasks).toEqual([]);
  });

  it('kanban.get adopts a bare board only when it is already selected', () => {
    useKanbanStore.setState({ activeBoardId: 'b1', activeBoard: null });
    result('kanban.get', board('b1'));
    expect(state().activeBoard?.id).toBe('b1');
    expect(state().activeBoardId).toBe('b1');
  });

  it('kanban.get for an unselected board leaves the selection alone', () => {
    useKanbanStore.setState({ activeBoardId: 'b1', activeBoard: board('b1') as never });
    result('kanban.get', board('b9'));
    expect(state().activeBoardId).toBe('b1');
    expect(state().activeBoard?.id).toBe('b1');
  });

  it('any other bare board becomes the new selection', () => {
    useKanbanStore.setState({ activeBoardId: 'b1', activeBoard: board('b1') as never });
    result('kanban.create', board('b9'));
    expect(state().activeBoardId).toBe('b9');
    expect(state().activeBoard?.id).toBe('b9');
  });

  it('a bare task upserts into whatever board is open', () => {
    useKanbanStore.setState({ activeBoardId: 'b1', activeBoard: board('b1') as never });
    result('kanban.task.get', task('t1'));
    expect(state().activeBoard?.tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('a bare task with no board open is a no-op', () => {
    result('kanban.task.get', task('t1'));
    expect(state()).toMatchObject({ activeBoard: null, loading: false, error: null });
  });

  it('a column array replaces the open board columns', () => {
    useKanbanStore.setState({ activeBoardId: 'b1', activeBoard: board('b1') as never });
    result('kanban.column.add', [{ id: 'todo' }, { id: 'doing' }]);
    expect(state().activeBoard?.columns.map((c) => c.id)).toEqual(['todo', 'doing']);
  });

  it('a column array with no board open is a no-op', () => {
    result('kanban.column.add', [{ id: 'todo' }]);
    expect(state()).toMatchObject({ activeBoard: null, loading: false, error: null });
  });

  it('an unrecognised payload just clears the spinner', () => {
    result('kanban.generate', { queued: true });
    expect(state()).toMatchObject({ loading: false, error: null });
  });
});

describe('board summary ordering', () => {
  it('keeps the most recently updated board first', () => {
    useKanbanStore.setState({
      boards: [summary('old', { updatedAt: '2026-01-01T00:00:00.000Z' })],
      activeBoardId: 'new',
    });
    result('kanban.update', {
      board: board('new', { updatedAt: '2026-06-01T00:00:00.000Z' }),
    });

    expect(state().boards.map((b) => b.id)).toEqual(['new', 'old']);
  });

  it('replaces rather than duplicates an existing summary', () => {
    // `summarize` projects `title`, not `name` — the summary is a distinct
    // shape from the board it is derived from.
    useKanbanStore.setState({ boards: [summary('b1')], activeBoardId: 'b1' });
    result('kanban.update', { board: board('b1', { title: 'renamed', taskCount: 0 }) });

    expect(state().boards).toHaveLength(1);
    expect(state().boards[0]).toMatchObject({ id: 'b1', title: 'renamed' });
  });
});

describe('simple setters', () => {
  it('setActiveBoardId drops the stale health and supervisor snapshots', () => {
    useKanbanStore.setState({
      queueHealth: { pending: 1 } as never,
      supervisorSnapshot: { runningAgents: 1 } as never,
    });
    useKanbanStore.getState().setActiveBoardId('b1');

    expect(state()).toMatchObject({
      activeBoardId: 'b1',
      queueHealth: null,
      supervisorSnapshot: null,
    });
  });

  it('setLoading, setError and setQueueHealth write straight through', () => {
    useKanbanStore.getState().setLoading(true);
    useKanbanStore.getState().setError('nope');
    useKanbanStore.getState().setQueueHealth({ pending: 7 } as never);

    expect(state()).toMatchObject({ loading: true, error: 'nope' });
    expect(state().queueHealth).toMatchObject({ pending: 7 });
  });
});

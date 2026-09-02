import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('ws', () => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { WebSocket: MockWebSocket };
});

vi.mock('@wrongstack/kanban', () => ({
  createBoard: vi.fn(async () => ({ id: 'board-1', name: 'Test', columns: [], tags: [] })),
  getBoard: vi.fn(async () => null),
  listBoards: vi.fn(async () => []),
  syncBoardFromTaskGraph: vi.fn(),
  updateTaskAssignment: vi.fn(),
  attachVerificationReport: vi.fn(),
  buildVerificationReport: vi.fn(),
}));

vi.mock('@wrongstack/core/tasking', () => ({
  deserializeTaskGraph: vi.fn(() => ({ nodes: new Map(), edges: [] })),
}));

vi.mock('@wrongstack/sdd', () => ({}));

import { createKanbanRunMirror } from '../src/server/kanban-run-mirror.js';

function makeDeps() {
  return {
    projectRoot: '/tmp/proj',
    events: { on: vi.fn(() => () => undefined), emit: vi.fn(), off: vi.fn() } as any,
    broadcast: vi.fn(),
    log: vi.fn(),
  };
}

describe('createKanbanRunMirror', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('returns a mirror with onGoalState, bind, bindGoalNext, flush, and dispose', () => {
    vi.useRealTimers();
    const mirror = createKanbanRunMirror(makeDeps());
    expect(typeof mirror.onGoalState).toBe('function');
    expect(typeof mirror.bind).toBe('function');
    expect(typeof mirror.bindGoalNext).toBe('function');
    expect(typeof mirror.flush).toBe('function');
    expect(typeof mirror.dispose).toBe('function');
  });

  it('flush runs a pending projection without waiting out the debounce', async () => {
    vi.useRealTimers();
    const deps = makeDeps();
    const mirror = createKanbanRunMirror(deps);
    const { createBoard } = await import('@wrongstack/kanban');
    mirror.onGoalState('graph-flush', {
      title: 'Flushed',
      phases: [
        {
          id: 'p1',
          name: 'Phase 1',
          tasks: [
            { id: 't1', title: 'Task 1', status: 'pending', priority: 'high', type: 'feature' },
          ],
        },
      ],
    });
    expect(vi.mocked(createBoard)).not.toHaveBeenCalled();
    await mirror.flush();
    expect(vi.mocked(createBoard)).toHaveBeenCalledTimes(1);
    // Nothing left to settle — a second flush is a no-op, not a second write.
    await mirror.flush();
    expect(vi.mocked(createBoard)).toHaveBeenCalledTimes(1);
    mirror.dispose();
  });

  it('flush surfaces a failing projection through log instead of rejecting', async () => {
    vi.useRealTimers();
    const deps = makeDeps();
    const mirror = createKanbanRunMirror(deps);
    const { createBoard } = await import('@wrongstack/kanban');
    vi.mocked(createBoard).mockRejectedValueOnce(new Error('disk full'));
    mirror.onGoalState('graph-boom', {
      title: 'Boom',
      phases: [
        {
          id: 'p1',
          name: 'Phase 1',
          tasks: [
            { id: 't1', title: 'Task 1', status: 'pending', priority: 'high', type: 'feature' },
          ],
        },
      ],
    });
    await expect(mirror.flush()).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    mirror.dispose();
  });

  it('onGoalState does not throw for an empty state', () => {
    const mirror = createKanbanRunMirror(makeDeps());
    expect(() => mirror.onGoalState('graph-1', {})).not.toThrow();
  });

  it('onGoalState schedules a debounced projection', async () => {
    const deps = makeDeps();
    const mirror = createKanbanRunMirror(deps);
    const { createBoard } = await import('@wrongstack/kanban');
    mirror.onGoalState('graph-1', {
      title: 'Test Goal',
      phases: [
        {
          id: 'p1',
          name: 'Phase 1',
          tasks: [
            { id: 't1', title: 'Task 1', status: 'pending', priority: 'high', type: 'feature' },
          ],
        },
      ],
    });
    // Before debounce timer fires, no kanban calls yet
    expect(vi.mocked(createBoard)).not.toHaveBeenCalled();
    // Advance past debounce
    await vi.advanceTimersByTimeAsync(400);
    // After timer, the projection should have run
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('error'));
  });

  it('bind maps an engine:key to a boardId', () => {
    vi.useRealTimers();
    const mirror = createKanbanRunMirror(makeDeps());
    expect(() => mirror.bind('sdd', 'run-1', 'board-1')).not.toThrow();
  });

  it('bindGoalNext sets a pending board for the next Goal run', () => {
    vi.useRealTimers();
    const mirror = createKanbanRunMirror(makeDeps());
    expect(() => mirror.bindGoalNext('board-42')).not.toThrow();
  });

  it('dispose is safe to call multiple times', () => {
    vi.useRealTimers();
    const mirror = createKanbanRunMirror(makeDeps());
    mirror.dispose();
    mirror.dispose();
  });

  it('onGoalState with phases but no tasks does not throw', () => {
    vi.useRealTimers();
    const mirror = createKanbanRunMirror(makeDeps());
    expect(() => mirror.onGoalState('g1', { phases: [{ id: 'p1', name: 'P1' }] })).not.toThrow();
  });

  it('onGoalState with title-only state does not throw', () => {
    vi.useRealTimers();
    const mirror = createKanbanRunMirror(makeDeps());
    expect(() => mirror.onGoalState('g1', { title: 'Hello' })).not.toThrow();
  });
});

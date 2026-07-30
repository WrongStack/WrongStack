import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTuiCoordinatorCallbacks } from '../src/boot/tui-coordinator-callbacks.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function coordinator(goal: Record<string, unknown> | undefined = undefined) {
  return {
    run: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    graph: {
      load: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockReturnValue(goal),
    },
    auction: {
      getPendingTasks: vi
        .fn()
        .mockReturnValue([{ id: 'task-1', title: 'Test', priority: 'high', tags: ['coverage'] }]),
      claim: vi.fn().mockResolvedValue(true),
    },
    reportTaskCompletion: vi.fn().mockResolvedValue(undefined),
    reportTaskFailure: vi.fn().mockResolvedValue(undefined),
    syncFromGraph: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockReturnValue({
      goals: { total: 3, done: 1, pending: 1, failed: 1 },
      dag: { running: 1, ready: 2, done: 3, failed: 4 },
      auction: { pending: 5, in_progress: 6 },
    }),
  };
}

function callbacks(active: ReturnType<typeof coordinator> | null) {
  const state = { coordinatorRun: null, autonomousCoordinator: active };
  const coordinatorEvents = new Set<(event: unknown) => void>();
  const ensure = vi.fn().mockReturnValue(active);
  return {
    state,
    coordinatorEvents,
    ensure,
    api: createTuiCoordinatorCallbacks({
      state: state as never,
      context: { session: { id: 'session-1' } } as never,
      coordinatorEvents,
      ensureAutonomousCoordinator: ensure,
    }),
  };
}

describe('createTuiCoordinatorCallbacks', () => {
  it('subscribes and exposes the current coordinator', () => {
    const active = coordinator();
    const { api, coordinatorEvents } = callbacks(active);
    const listener = vi.fn();
    const unsubscribe = api.subscribeCoordinatorEvents(listener);

    expect(api.getAutonomousCoordinator()).toBe(active);
    expect(coordinatorEvents.has(listener)).toBe(true);
    unsubscribe();
    expect(coordinatorEvents.has(listener)).toBe(false);
  });

  it('starts once, applies the default goal, clears state, and stops', async () => {
    const active = coordinator();
    const { api, state } = callbacks(active);

    api.onCoordinatorStart();
    api.onCoordinatorStart('ignored duplicate');
    expect(active.run).toHaveBeenCalledOnce();
    expect(active.run).toHaveBeenCalledWith({
      goal: 'Improve the codebase',
      runUntilComplete: true,
    });
    await state.coordinatorRun;
    expect(state.coordinatorRun).toBeNull();
    api.onCoordinatorStop();
    expect(active.stop).toHaveBeenCalledOnce();
  });

  it('logs unavailable and rejected coordinator starts', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    callbacks(null).api.onCoordinatorStart('goal');
    expect(error.mock.calls.flat().join(' ')).toContain('coordinator.not_ready');

    const active = coordinator();
    active.run.mockRejectedValueOnce('run failed');
    const { api, state } = callbacks(active);
    api.onCoordinatorStart('goal');
    await state.coordinatorRun;
    expect(error.mock.calls.flat().join(' ')).toContain('coordinator.run_failed');
  });

  it('lists tasks and returns null when no coordinator exists', async () => {
    await expect(callbacks(null).api.onCoordinatorTasks()).resolves.toBeNull();
    const active = coordinator();
    await expect(callbacks(active).api.onCoordinatorTasks()).resolves.toEqual([
      { id: 'task-1', title: 'Test', priority: 'high', tags: ['coverage'] },
    ]);
    expect(active.graph.load).toHaveBeenCalledOnce();
  });

  it('validates claims before assigning terminal ownership', async () => {
    const missing = callbacks(null).api;
    await expect(missing.onCoordinatorClaim('abcdefghijk')).resolves.toBe(
      'No coordinator is active.',
    );

    const active = coordinator({ id: 'task', type: 'task', status: 'pending' });
    const api = callbacks(active).api;
    await expect(api.onCoordinatorClaim('abcdefghijk')).resolves.toContain('not found');
    active.graph.get.mockReturnValue({ type: 'goal', status: 'done' });
    await expect(api.onCoordinatorClaim('abcdefghijk')).resolves.toContain('not claimable');
    active.graph.get.mockReturnValue({
      type: 'goal',
      status: 'pending',
      description: 'Implement tests',
    });
    active.auction.claim.mockResolvedValueOnce(false);
    await expect(api.onCoordinatorClaim('abcdefghijk')).resolves.toContain('could not be claimed');
    active.auction.claim.mockResolvedValueOnce(true);
    await expect(api.onCoordinatorClaim('abcdefghijk')).resolves.toEqual({
      description: 'Implement tests',
    });
    expect(active.auction.claim).toHaveBeenLastCalledWith(
      'abcdefghijk',
      'terminal@session-1',
      'Terminal worker',
    );
  });

  it('completes, fails, and summarizes valid coordinator goals', async () => {
    const active = coordinator({ type: 'goal', status: 'in_progress' });
    const api = callbacks(active).api;
    await expect(api.onCoordinatorComplete('task', 'done')).resolves.toBeNull();
    expect(active.reportTaskCompletion).toHaveBeenCalledWith('task', 'done');
    await expect(api.onCoordinatorFail('task', 'broken')).resolves.toBeNull();
    expect(active.reportTaskFailure).toHaveBeenCalledWith('task', 'broken');
    await expect(api.onCoordinatorStatus()).resolves.toEqual({
      goals: { total: 3, done: 1, pending: 1, failed: 1 },
      dag: { running: 1, ready: 2, done: 3, failed: 4 },
      auction: { pending: 5, inProgress: 6 },
    });

    active.graph.get.mockReturnValue({ type: 'goal', status: 'pending' });
    await expect(api.onCoordinatorComplete('task')).resolves.toContain('cannot complete');
    await expect(api.onCoordinatorFail('task', 'broken')).resolves.toContain('cannot fail');
    await expect(callbacks(null).api.onCoordinatorStatus()).resolves.toBeNull();
  });
});

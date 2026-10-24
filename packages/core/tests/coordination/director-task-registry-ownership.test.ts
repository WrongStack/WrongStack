import type { TaskResult, TaskSpec } from '@wrongstack/contracts/types/multi-agent';
import { describe, expect, it, vi } from 'vitest';
import { DirectorTaskRegistry } from '../../src/coordination/director/director-task-registry.js';
import type { DirectorStateCheckpoint } from '../../src/storage/director-state.js';

function result(taskId: string, status: TaskResult['status'] = 'success'): TaskResult {
  return { taskId, subagentId: 'sub-1', status, iterations: 1, toolCalls: 2, durationMs: 3 };
}

function setup(workComplete = false) {
  const flags = { workComplete };
  const registry = new DirectorTaskRegistry({
    coordinator: {
      assign: vi.fn(async () => {}),
      listPendingTasks: vi.fn(() => [] as TaskSpec[]),
      retargetPendingTask: vi.fn(() => true),
    },
    stateCheckpoint: { recordTaskAssigned: vi.fn() } as unknown as DirectorStateCheckpoint,
    isWorkComplete: () => flags.workComplete,
    addTaskToManifest: vi.fn(),
    recordPendingTask: vi.fn(),
    appendSessionEvent: vi.fn(async () => {}),
    scheduleManifest: vi.fn(),
    getSubagentMeta: vi.fn(() => undefined),
  });
  return { registry, flags };
}

describe('DirectorTaskRegistry ownership (background delegate)', () => {
  it('an unowned, unawaited result is not consumed in band (notifier mail goes out)', () => {
    const { registry } = setup();
    expect(registry.settle(result('t-free'))).toEqual({
      internal: false,
      consumedInBand: false,
      leaderConsumed: false,
    });
  });

  it('markOwned suppresses the notifier without claiming the leader consumed it', () => {
    const { registry } = setup();
    registry.markOwned('t-owned');
    expect(registry.settle(result('t-owned'))).toEqual({
      internal: false,
      consumedInBand: true,
      leaderConsumed: false,
    });
  });

  it('assign-after-workComplete race: the synchronous stopped settlement is still owned', async () => {
    const { registry } = setup(true);
    const settleSpy = vi.spyOn(registry, 'settle');
    registry.markOwned('t-race');
    await registry.assign({ id: 't-race', subagentId: 'sub-1', description: 'late handoff' });
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(settleSpy.mock.results[0]?.value).toMatchObject({
      consumedInBand: true,
      leaderConsumed: false,
    });
    // No waiter existed yet; the result is still retrievable afterwards.
    await expect(registry.awaitTasks(['t-race'])).resolves.toMatchObject([{ status: 'stopped' }]);
  });

  it('observe is not a waiter: it fires on settle and leaves leaderConsumed false', () => {
    const { registry } = setup();
    registry.markOwned('t-obs');
    const seen = vi.fn();
    registry.observe('t-obs', seen);
    const settled = registry.settle(result('t-obs'));
    expect(settled.leaderConsumed).toBe(false);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't-obs' }), {
      leaderConsumed: false,
    });
  });

  it('observe fires immediately for an already-retained result', () => {
    const { registry } = setup();
    registry.settle(result('t-done'));
    const seen = vi.fn();
    const off = registry.observe('t-done', seen);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it('a leader await on an owned task reports leaderConsumed to observers', async () => {
    const { registry } = setup();
    registry.markOwned('t-both');
    const seen = vi.fn();
    registry.observe('t-both', seen);
    const waiting = registry.awaitTasksAny(['t-both']);
    const settled = registry.settle(result('t-both'));
    expect(settled).toMatchObject({ consumedInBand: true, leaderConsumed: true });
    expect(seen.mock.calls[0]?.[1]).toEqual({ leaderConsumed: true });
    await expect(waiting).resolves.toMatchObject({ completed: [{ taskId: 't-both' }] });
  });

  it('shutdown resolves pending observers with a stopped result', () => {
    const { registry } = setup();
    const seen = vi.fn();
    registry.observe('t-pending', seen);
    registry.resolveWaitersOnShutdown();
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't-pending', status: 'stopped' }),
      { leaderConsumed: false },
    );
  });
});

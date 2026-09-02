import { describe, expect, it, vi } from 'vitest';
import { DirectorTaskRegistry } from '../../src/coordination/director/director-task-registry.js';
import type { DirectorStateCheckpoint } from '../../src/storage/director-state.js';
import type { TaskResult, TaskSpec } from '../../src/types/multi-agent.js';

function result(taskId: string, status: TaskResult['status'] = 'success'): TaskResult {
  return { taskId, subagentId: 'sub-1', status, iterations: 1, toolCalls: 2, durationMs: 3 };
}

function setup(workComplete = false) {
  const coordinator = {
    assign: vi.fn(async () => {}),
    listPendingTasks: vi.fn(() => [] as TaskSpec[]),
    retargetPendingTask: vi.fn(() => true),
  };
  const deps = {
    coordinator,
    stateCheckpoint: {
      recordTaskAssigned: vi.fn(),
    } as unknown as DirectorStateCheckpoint,
    isWorkComplete: vi.fn(() => workComplete),
    addTaskToManifest: vi.fn(),
    recordPendingTask: vi.fn(),
    appendSessionEvent: vi.fn(async () => {}),
    scheduleManifest: vi.fn(),
    getSubagentMeta: vi.fn(() => ({ provider: 'p', model: 'm' })),
  };
  return { registry: new DirectorTaskRegistry(deps), coordinator, deps };
}

describe('DirectorTaskRegistry', () => {
  it('assigns and records ownership through injected persistence ports', async () => {
    const { registry, coordinator, deps } = setup();
    const taskId = await registry.assign({ id: 't-1', subagentId: 'sub-1', description: 'work' });
    expect(taskId).toBe('t-1');
    expect(coordinator.assign).toHaveBeenCalled();
    expect(deps.addTaskToManifest).toHaveBeenCalledWith('sub-1', 't-1');
    expect(deps.stateCheckpoint.recordTaskAssigned).toHaveBeenCalled();
    expect(registry.ownerFor('t-1')).toBe('sub-1');
  });

  it('synthesizes a stopped result after workComplete and wakes waiters', async () => {
    const { registry, coordinator } = setup(true);
    const waiting = registry.awaitTasks(['t-stop']);
    await registry.assign({ id: 't-stop', description: 'late work' });
    await expect(waiting).resolves.toMatchObject([{ taskId: 't-stop', status: 'stopped' }]);
    expect(coordinator.assign).not.toHaveBeenCalled();
  });

  it('settles all-wait and overlapping any-wait consumers exactly once', async () => {
    const { registry } = setup();
    const all = registry.awaitTasks(['t-1']);
    const anyA = registry.awaitTasksAny(['t-1', 't-2']);
    const anyB = registry.awaitTasksAny(['t-1', 't-3']);
    expect(registry.settle(result('t-1')).consumedInBand).toBe(true);
    await expect(all).resolves.toMatchObject([{ taskId: 't-1' }]);
    await expect(anyA).resolves.toMatchObject({ completed: [{ taskId: 't-1' }], pending: ['t-2'] });
    await expect(anyB).resolves.toMatchObject({ completed: [{ taskId: 't-1' }], pending: ['t-3'] });
  });

  it('keeps internal task results out of user-visible history', async () => {
    const { registry } = setup();
    await registry.assignInternal({ id: 'internal', description: 'infra' });
    expect(registry.settle(result('internal')).internal).toBe(true);
    expect(registry.completedResults()).toEqual([]);
  });

  it('retargets only accepted pending tasks and synchronizes ownership', () => {
    const { registry, coordinator, deps } = setup();
    expect(registry.retargetPendingTask('t-1', 'sub-2')).toBe(true);
    expect(registry.ownerFor('t-1')).toBe('sub-2');
    expect(deps.recordPendingTask).toHaveBeenCalledWith('t-1', 'sub-2', 't-1');
    coordinator.retargetPendingTask.mockReturnValue(false);
    expect(registry.retargetPendingTask('missing', 'sub-3')).toBe(false);
  });

  it('resolves all waiter kinds during shutdown', async () => {
    const { registry } = setup();
    const all = registry.awaitTasks(['never']);
    const any = registry.awaitTasksAny(['also-never']);
    registry.resolveWaitersOnShutdown();
    await expect(all).resolves.toMatchObject([{ status: 'stopped' }]);
    await expect(any).resolves.toMatchObject({ completed: [{ status: 'stopped' }] });
  });

  it('formats retained results without exposing its internal maps', () => {
    const { registry } = setup();
    registry.settle({ ...result('t-1'), result: 'done' });
    expect(registry.rollUp(['t-1'])).toContain('### sub-1 · p/m');
    expect(JSON.parse(registry.rollUp(['t-1'], 'json'))[0]).toMatchObject({ taskId: 't-1' });
  });

  it("removeTasksOwnedBy reclaims only the given owner's descriptions/owners and is idempotent", async () => {
    // Regression (RAM-leak audit 2026-08-01): on the default FleetManager path
    // Director.remove() never called removeTasks (its only call site was gated
    // behind the empty manifestEntries map), so descriptions (full task briefs)
    // + owners accumulated one entry per assigned task for the Director's
    // lifetime. removeTasksOwnedBy uses the path-independent owners index.
    const { registry } = setup();
    await registry.assign({ id: 't-1', subagentId: 'sub-1', description: 'brief-1' });
    await registry.assign({ id: 't-2', subagentId: 'sub-1', description: 'brief-2' });
    await registry.assign({ id: 't-3', subagentId: 'sub-2', description: 'brief-3' });
    expect(registry.ownerFor('t-1')).toBe('sub-1');
    expect(registry.descriptionFor('t-3', 'X')).toBe('brief-3');

    const removed = registry.removeTasksOwnedBy('sub-1');

    expect(removed.sort()).toEqual(['t-1', 't-2']);
    // sub-1's ownership + descriptions are back to baseline...
    expect(registry.ownerFor('t-1')).toBeUndefined();
    expect(registry.ownerFor('t-2')).toBeUndefined();
    expect(registry.descriptionFor('t-1', 'X')).toBe('X');
    expect(registry.descriptionFor('t-2', 'X')).toBe('X');
    // ...while sub-2's state is untouched (no cross-contamination).
    expect(registry.ownerFor('t-3')).toBe('sub-2');
    expect(registry.descriptionFor('t-3', 'X')).toBe('brief-3');
    // Idempotent: nothing left to reclaim for sub-1.
    expect(registry.removeTasksOwnedBy('sub-1')).toEqual([]);
  });
});

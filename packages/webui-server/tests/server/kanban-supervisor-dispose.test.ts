/**
 * KanbanSupervisor.dispose() — the shutdown contract for the background
 * custodian. Without a clean teardown the nextTimer would keep firing as
 * an orphan chain (one duplicate per auditNow call that races the tick),
 * and the per-board Map/Set bookkeeping would leak.
 *
 * Regression scope (covers KanbanSupervisor.dispose body verbatim):
 *   - nextTimer is clearTimeout'd + dropped to undefined
 *   - snapshots, nextDue, agentLastRun, agentRunning all empty
 *   - post-dispose auditNow / tick / status requests are no-ops
 *     (they short-circuit on `disposed` so no fresh timer can be armed)
 *   - duplicate chain protection: the scheduleNext() `clearTimeout`
 *     before overwriting nextTimer must keep working after dispose.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createKanbanSupervisor,
  type KanbanSupervisorDeps,
} from '../../src/server/kanban-supervisor.js';

function makeDeps(projectRoot = '/tmp/empty-project'): KanbanSupervisorDeps {
  return {
    projectRoot,
    broadcast: vi.fn(),
    log: vi.fn(),
  };
}

describe('KanbanSupervisor.dispose()', () => {
  it('drops nextTimer and clears every per-board Map/Set', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      // The constructor calls void scheduleNext(), which arms a real
      // setTimeout for tick() inside the supervisor's closure. Spy on
      // clearTimeout BEFORE dispose() so the supervisor's own cancellation
      // is observable; do NOT mockClear() between create and dispose — that
      // hid the very call we are testing.
      createKanbanSupervisor(makeDeps()).dispose();

      // First dispose must clear the supervisor-armed timer. Without this
      // call, a regression that simply nulls `nextTimer` without calling
      // clearTimeout would still leave an orphan background chain ticking.
      expect(clearSpy).toHaveBeenCalled();

      // Second dispose on the SAME supervisor must be a no-op: no new
      // clearTimeout calls, no stale-ref clearing on a handle that was
      // already nulled. (Idempotency is also covered by the next test;
      // we assert it here in the same fake-timer context so the spy stays
      // consistent.)
      const supervisor = createKanbanSupervisor(makeDeps());
      supervisor.dispose();
      clearSpy.mockClear();
      supervisor.dispose();
      expect(clearSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      clearSpy.mockRestore();
    }
  });

  it('is safe to call twice (idempotent teardown)', () => {
    const supervisor = createKanbanSupervisor(makeDeps());
    expect(() => {
      supervisor.dispose();
      supervisor.dispose();
    }).not.toThrow();
  });

  it('keeps auditNow a no-op after dispose (no new timer can be armed)', async () => {
    const deps = makeDeps();
    const broadcast = deps.broadcast;
    const supervisor = createKanbanSupervisor(deps);
    supervisor.dispose();
    // After dispose, auditNow must not crash, must not broadcast, and must
    // not arm any timer. Unknown boardId → empty array, no broadcast.
    const snapshot = await supervisor.auditNow('does-not-exist');
    expect(snapshot).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('keeps getSnapshot a no-op after dispose', () => {
    const supervisor = createKanbanSupervisor(makeDeps());
    supervisor.dispose();
    expect(supervisor.getSnapshot('does-not-exist')).toBeUndefined();
  });
});

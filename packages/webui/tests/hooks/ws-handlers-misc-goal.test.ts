import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = {
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  undoable: vi.fn(),
};
vi.mock('@/components/Toaster', () => ({ toast }));

const send = vi.fn();
const refineModel = vi.fn();
const sendMessage = vi.fn();
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ send, refineModel, sendMessage }),
}));

const { useGoalRunStore, useGoalStateStore, useUIStore } = await import('../../src/stores');
const { useLocalPrefs } = await import('../../src/stores/local-prefs');
const {
  handleGoalLifecycle,
  handleGoalList,
  handleGoalProgress,
  handleGoalState,
  handleGoalUpdated,
  handlePrefsUpdated,
  miscHandlerMap,
} = await import('../../src/hooks/ws-handlers/misc-handlers');

function msg(type: string, payload: unknown) {
  return { type, payload } as never;
}

const run = () => useGoalRunStore.getState();

function phase(status: string) {
  return { id: `p-${status}`, title: status, status };
}

describe('misc ws-handlers — goal run', () => {
  beforeEach(() => {
    for (const fn of Object.values(toast)) fn.mockReset();
    send.mockReset();
    run().clear();
  });

  it('routes every goal lifecycle type to the same handler', () => {
    for (const type of [
      'goal.paused',
      'goal.resumed',
      'goal.stopped',
      'goal.cleared',
      'goal.reverted',
      'goal.saved',
      'goal.completed',
      'goal.failed',
      'goal.error',
    ]) {
      expect(miscHandlerMap[type], type).toBe(handleGoalLifecycle);
    }
  });

  // ── goal.state ────────────────────────────────────────────────────────────

  describe('goal.state', () => {
    it('stores the board fields', () => {
      handleGoalState(
        msg('goal.state', {
          phases: [phase('running')],
          activePhaseId: 'p-running',
          overallPercent: 40,
          autonomous: true,
          title: 'Ship it',
          goal: 'Ship the thing',
          multiBoard: true,
        }),
      );
      expect(run()).toMatchObject({
        activePhaseId: 'p-running',
        overallPercent: 40,
        autonomous: true,
        title: 'Ship it',
        goal: 'Ship the thing',
        multiBoard: true,
      });
    });

    it('drops non-conforming scalar fields rather than storing garbage', () => {
      // Each type guard yields `undefined`, and the store's `??`/`!== undefined`
      // merge then keeps the previous value — so a malformed frame can never
      // overwrite good state with garbage.
      handleGoalState(
        msg('goal.state', {
          phases: [phase('running')],
          activePhaseId: 42,
          overallPercent: '40',
          autonomous: 'yes',
          title: 7,
          goal: null,
        }),
      );
      const s = run();
      expect(s.activePhaseId).toBeNull();
      expect(s.overallPercent).toBe(0);
      expect(s.autonomous).toBe(false);
      expect(s.title).toBeNull();
      expect(s.goal).toBeNull();
    });

    it('a malformed frame does not clobber previously good values', () => {
      handleGoalState(
        msg('goal.state', { activePhaseId: 'p1', overallPercent: 40, title: 'Ship it' }),
      );
      handleGoalState(msg('goal.state', { activePhaseId: 42, overallPercent: '90', title: 7 }));
      expect(run()).toMatchObject({ activePhaseId: 'p1', overallPercent: 40, title: 'Ship it' });
    });

    it('treats a non-array phases field as absent', () => {
      handleGoalState(msg('goal.state', { phases: 'nope' }));
      expect(run().phases).toEqual([]);
      expect(run().status).toBe('idle');
    });

    it('defaults multiBoard to false unless it is exactly true', () => {
      handleGoalState(msg('goal.state', { multiBoard: 'true' }));
      expect(run().multiBoard).toBe(false);
    });

    describe('status derivation', () => {
      it('is left untouched with no phases', () => {
        // deriveGoalRunStatus returns undefined, so the store keeps 'idle'.
        handleGoalState(msg('goal.state', {}));
        expect(run().status).toBe('idle');
      });

      it('is left untouched with an empty phase list', () => {
        handleGoalState(msg('goal.state', { phases: [] }));
        expect(run().status).toBe('idle');
      });

      it('does not downgrade a live status when phases go missing', () => {
        handleGoalState(msg('goal.state', { phases: [phase('running')] }));
        expect(run().status).toBe('running');
        handleGoalState(msg('goal.state', {}));
        expect(run().status).toBe('running');
      });

      it('is failed when any phase failed — failure wins over everything', () => {
        handleGoalState(
          msg('goal.state', { phases: [phase('completed'), phase('failed'), phase('paused')] }),
        );
        expect(run().status).toBe('failed');
      });

      it('is completed when every phase is completed or skipped', () => {
        handleGoalState(msg('goal.state', { phases: [phase('completed'), phase('skipped')] }));
        expect(run().status).toBe('completed');
      });

      it('is paused when a phase is paused and none failed', () => {
        handleGoalState(msg('goal.state', { phases: [phase('completed'), phase('paused')] }));
        expect(run().status).toBe('paused');
      });

      it('is running otherwise', () => {
        handleGoalState(msg('goal.state', { phases: [phase('completed'), phase('pending')] }));
        expect(run().status).toBe('running');
      });
    });

    it('clears lastError on a non-failed state', () => {
      useGoalRunStore.setState({ lastError: 'old failure' } as never);
      handleGoalState(msg('goal.state', { phases: [phase('running')] }));
      expect(run().lastError).toBeNull();
    });

    it('preserves lastError while the run is still failed', () => {
      useGoalRunStore.setState({ lastError: 'boom' } as never);
      handleGoalState(msg('goal.state', { phases: [phase('failed')] }));
      expect(run().lastError).toBe('boom');
    });
  });

  // ── goal.progress ─────────────────────────────────────────────────────────

  describe('goal.progress', () => {
    it('stores the counters', () => {
      handleGoalProgress(
        msg('goal.progress', {
          totalPhases: 4,
          completed: 2,
          failed: 0,
          totalTasks: 20,
          completedTasks: 11,
          failedTasks: 0,
          percentComplete: 55,
        }),
      );
      expect(run().progress).toEqual({
        totalPhases: 4,
        completed: 2,
        failed: 0,
        totalTasks: 20,
        completedTasks: 11,
        failedTasks: 0,
      });
      expect(run().overallPercent).toBe(55);
      expect(run().lastEvent).toBe('progress');
    });

    it('zeroes any counter that is not a number', () => {
      handleGoalProgress(msg('goal.progress', { totalPhases: '4', completed: null }));
      expect(run().progress).toEqual({
        totalPhases: 0,
        completed: 0,
        failed: 0,
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
      });
    });

    it('rounds a fractional percentComplete', () => {
      handleGoalProgress(msg('goal.progress', { percentComplete: 55.6 }));
      expect(run().overallPercent).toBe(56);
    });

    it('leaves overallPercent alone when percentComplete is absent', () => {
      handleGoalState(msg('goal.state', { overallPercent: 42 }));
      handleGoalProgress(msg('goal.progress', {}));
      expect(run().overallPercent).toBe(42);
    });

    it('reports running while nothing has failed', () => {
      handleGoalProgress(msg('goal.progress', { failed: 0, failedTasks: 0 }));
      expect(run().status).toBe('running');
    });

    it('reports failed on a failed phase', () => {
      handleGoalProgress(msg('goal.progress', { failed: 1 }));
      expect(run().status).toBe('failed');
    });

    it('reports failed on a failed task even with no failed phase', () => {
      handleGoalProgress(msg('goal.progress', { failed: 0, failedTasks: 2 }));
      expect(run().status).toBe('failed');
    });
  });

  // ── goal lifecycle ────────────────────────────────────────────────────────

  describe('goal lifecycle', () => {
    it('paused stops autonomy and toasts', () => {
      handleGoalLifecycle(msg('goal.paused', {}));
      expect(run()).toMatchObject({ status: 'paused', autonomous: false, lastEvent: 'paused' });
      expect(toast.info).toHaveBeenCalledWith('Goal paused');
    });

    it('resumed restarts autonomy and toasts', () => {
      handleGoalLifecycle(msg('goal.resumed', {}));
      expect(run()).toMatchObject({ status: 'running', autonomous: true, lastEvent: 'resumed' });
      expect(toast.info).toHaveBeenCalledWith('Goal resumed');
    });

    it('stopped warns', () => {
      handleGoalLifecycle(msg('goal.stopped', {}));
      expect(run()).toMatchObject({ status: 'stopped', autonomous: false, lastEvent: 'stopped' });
      expect(toast.warn).toHaveBeenCalledWith('Goal stopped');
    });

    it('cleared resets the board so the entry screen returns', () => {
      useGoalRunStore.setState({ title: 'Ship it', status: 'running' } as never);
      handleGoalLifecycle(msg('goal.cleared', {}));
      expect(run().title).toBeNull();
      expect(run().status).toBe('idle');
      expect(run().phases).toEqual([]);
    });

    it('completed pins 100% and clears the error', () => {
      useGoalRunStore.setState({ lastError: 'old' } as never);
      handleGoalLifecycle(msg('goal.completed', { title: 'Ship it' }));
      expect(run()).toMatchObject({
        status: 'completed',
        autonomous: false,
        overallPercent: 100,
        lastEvent: 'completed',
        lastError: null,
      });
      expect(toast.success).toHaveBeenCalledWith('Ship it completed');
    });

    it('completed falls back to "Goal" when no title is sent', () => {
      handleGoalLifecycle(msg('goal.completed', {}));
      expect(toast.success).toHaveBeenCalledWith('Goal completed');
    });

    it('treats an empty title as absent', () => {
      handleGoalLifecycle(msg('goal.completed', { title: '' }));
      expect(toast.success).toHaveBeenCalledWith('Goal completed');
    });

    describe('goal.reverted', () => {
      it('reports a plural revert count', () => {
        handleGoalLifecycle(msg('goal.reverted', { ok: true, reverted: 3 }));
        expect(toast.success).toHaveBeenCalledWith('Reverted 3 commits');
      });

      it('uses the singular for exactly one commit', () => {
        handleGoalLifecycle(msg('goal.reverted', { ok: true, reverted: 1 }));
        expect(toast.success).toHaveBeenCalledWith('Reverted 1 commit');
      });

      it('says nothing to revert for zero', () => {
        handleGoalLifecycle(msg('goal.reverted', { ok: true, reverted: 0 }));
        expect(toast.success).toHaveBeenCalledWith('Nothing to revert');
      });

      it('reports the failure reason', () => {
        handleGoalLifecycle(msg('goal.reverted', { ok: false, reason: 'dirty tree' }));
        expect(toast.error).toHaveBeenCalledWith('Revert failed: dirty tree');
      });

      it('falls back when no reason is given', () => {
        handleGoalLifecycle(msg('goal.reverted', { ok: false }));
        expect(toast.error).toHaveBeenCalledWith('Revert failed: unknown error');
      });

      it('treats a non-true ok as a failure', () => {
        handleGoalLifecycle(msg('goal.reverted', { ok: 'yes' }));
        expect(toast.error).toHaveBeenCalled();
      });

      it('records the event either way', () => {
        handleGoalLifecycle(msg('goal.reverted', { ok: true, reverted: 1 }));
        expect(run().lastEvent).toBe('reverted');
      });
    });

    it('saved toasts and records the event', () => {
      handleGoalLifecycle(msg('goal.saved', {}));
      expect(run().lastEvent).toBe('saved');
      expect(toast.success).toHaveBeenCalledWith('Goal graph saved');
    });

    describe('goal.failed / goal.error', () => {
      it.each(['goal.failed', 'goal.error'])('%s surfaces the error field', (type) => {
        handleGoalLifecycle(msg(type, { error: 'compile failed' }));
        expect(run()).toMatchObject({
          status: 'failed',
          autonomous: false,
          lastEvent: 'failed',
          lastError: 'compile failed',
        });
        expect(toast.error).toHaveBeenCalledWith('compile failed');
      });

      it('falls back to the message field', () => {
        handleGoalLifecycle(msg('goal.failed', { message: 'network down' }));
        expect(run().lastError).toBe('network down');
      });

      it('prefers error over message', () => {
        handleGoalLifecycle(msg('goal.failed', { error: 'E', message: 'M' }));
        expect(run().lastError).toBe('E');
      });

      it('synthesises a message from the title as a last resort', () => {
        handleGoalLifecycle(msg('goal.failed', { title: 'Ship it' }));
        expect(run().lastError).toBe('Ship it failed');
      });

      it('uses the "Goal" fallback title', () => {
        handleGoalLifecycle(msg('goal.failed', {}));
        expect(run().lastError).toBe('Goal failed');
      });
    });

    it('ignores an unrelated message type without throwing', () => {
      expect(() => handleGoalLifecycle(msg('goal.unknown', {}))).not.toThrow();
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  // ── goal.list ─────────────────────────────────────────────────────────────

  describe('goal.list', () => {
    it('stores the graph list', () => {
      const graphs = [{ id: 'g1', title: 'A', updatedAt: 1, status: 'active' }];
      handleGoalList(msg('goal.list', { graphs }));
      expect(run().graphs).toEqual(graphs);
      expect(run().lastEvent).toBe('list');
    });

    it('normalises a missing or non-array graphs field to []', () => {
      handleGoalList(msg('goal.list', {}));
      expect(run().graphs).toEqual([]);
      handleGoalList(msg('goal.list', { graphs: 'nope' }));
      expect(run().graphs).toEqual([]);
    });
  });

  // ── goal-state.updated ────────────────────────────────────────────────────

  describe('goal-state.updated', () => {
    it('parses the raw goal.json payload', () => {
      handleGoalUpdated(
        msg('goal-state.updated', { goal: 'Ship the thing', goalState: 'active', iterations: 3 }),
      );
      expect(useGoalStateStore.getState().goal).toMatchObject({ iterations: 3 });
    });

    it('clears the goal on a null payload', () => {
      handleGoalUpdated(msg('goal-state.updated', { goal: 'x' }));
      handleGoalUpdated(msg('goal-state.updated', null));
      expect(useGoalStateStore.getState().goal).toBeNull();
    });
  });

  // ── prefs.updated ─────────────────────────────────────────────────────────

  describe('prefs.updated', () => {
    it('applies the patch to local prefs', () => {
      const set = vi.fn();
      // Session-scoped keys are filed against the tab the payload names, so
      // the handler goes through `applyRemote(patch, sessionId)` rather than
      // writing every snapshot into one global `set`.
      useLocalPrefs.setState({ applyRemote: set } as never);
      handlePrefsUpdated(msg('prefs.updated', { yolo: false, maxIterations: 12 }));
      expect(set).toHaveBeenCalledWith({ yolo: false, maxIterations: 12 }, undefined);
    });

    it('dismisses a pending confirm when YOLO is switched on', () => {
      useLocalPrefs.setState({ set: vi.fn() } as never);
      const hideConfirm = vi.fn();
      useUIStore.setState({ confirmInfo: { toolName: 'bash' }, hideConfirm } as never);
      handlePrefsUpdated(msg('prefs.updated', { yolo: true }));
      expect(hideConfirm).toHaveBeenCalled();
    });

    it('does not touch the confirm dialog when YOLO stays off', () => {
      useLocalPrefs.setState({ set: vi.fn() } as never);
      const hideConfirm = vi.fn();
      useUIStore.setState({ confirmInfo: { toolName: 'bash' }, hideConfirm } as never);
      handlePrefsUpdated(msg('prefs.updated', { yolo: false }));
      expect(hideConfirm).not.toHaveBeenCalled();
    });

    it('is a no-op on YOLO when no confirm is open', () => {
      useLocalPrefs.setState({ set: vi.fn() } as never);
      const hideConfirm = vi.fn();
      useUIStore.setState({ confirmInfo: null, hideConfirm } as never);
      handlePrefsUpdated(msg('prefs.updated', { yolo: true }));
      expect(hideConfirm).not.toHaveBeenCalled();
    });

    it('ignores a truthy-but-not-true yolo value', () => {
      useLocalPrefs.setState({ set: vi.fn() } as never);
      const hideConfirm = vi.fn();
      useUIStore.setState({ confirmInfo: { toolName: 'bash' }, hideConfirm } as never);
      handlePrefsUpdated(msg('prefs.updated', { yolo: 'true' }));
      expect(hideConfirm).not.toHaveBeenCalled();
    });
  });
});

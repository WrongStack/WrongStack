import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ({ send }) }));

const { useFleetStore, useMonitorStore, useWorktreeStore } = await import('../../src/stores');
const { useVizStore } = await import('../../src/stores/viz-store');
const {
  fleetHandlerMap,
  handleClientStatusUpdate,
  handleFleetConcurrency,
  handleSessionsStatusUpdate,
  handleSubagentEvent,
  handleWorktreeCleanupResult,
  handleWorktreeDiffResult,
  handleWorktreeEvent,
  handleWorktreeMergeResult,
  handleWorktreeOrphans,
  handleWorktreeState,
} = await import('../../src/hooks/ws-handlers/fleet-handlers');

function msg(type: string, payload: unknown) {
  return { type, payload } as never;
}

/** A live session row as `normalizeLiveSessions` expects it. */
function session(id: string) {
  return { id, agents: [] };
}

/**
 * `sessions.status_update` keeps module-level throttle gates (1s for the viz
 * snapshot, 5s for the mailbox refresh) compared against `Date.now()`.
 *
 * The clock therefore has to move MONOTONICALLY for the whole file — a
 * per-test `vi.setSystemTime` reset would rewind `now` behind gate timestamps
 * recorded by an earlier test and wedge every gate shut. So the fake clock is
 * installed once and only ever advanced.
 */
function clearThrottles() {
  vi.advanceTimersByTime(10_000);
  send.mockReset();
  useVizStore.setState({ events: [], isActive: false } as never);
}

describe('fleet ws-handler map', () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: new Date('2026-07-29T00:00:00Z') });
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    // Move past both gates instead of rewinding the clock.
    vi.advanceTimersByTime(60_000);
    send.mockReset();
    useWorktreeStore.setState({
      worktrees: [],
      baseBranch: '',
      activity: [],
      orphans: [],
      canClean: false,
      cleanResult: null,
      mergeResult: null,
      diffByDir: {},
    } as never);
    useVizStore.setState({ events: [], isActive: false } as never);
  });

  it('registers a handler for every fleet wire type', () => {
    expect(Object.keys(fleetHandlerMap).sort()).toEqual(
      [
        'client.status_update',
        'fleet.concurrency_update',
        'sessions.status_update',
        'subagent.event',
        'worktree.cleanup_result',
        'worktree.diff_result',
        'worktree.event',
        'worktree.merge_result',
        'worktree.orphans',
        'worktree.state',
      ].sort(),
    );
  });

  // ── worktree ──────────────────────────────────────────────────────────────

  describe('worktree.state', () => {
    it('stores the snapshot', () => {
      handleWorktreeState(
        msg('worktree.state', {
          worktrees: [{ handleId: 'w1', path: '/repo/w1', branch: 'feat/x' }],
          baseBranch: 'main',
        }),
      );
      const s = useWorktreeStore.getState();
      expect(s.worktrees).toHaveLength(1);
      expect(s.baseBranch).toBe('main');
    });

    it('defaults a missing list and branch instead of storing undefined', () => {
      handleWorktreeState(msg('worktree.state', {}));
      const s = useWorktreeStore.getState();
      expect(s.worktrees).toEqual([]);
      expect(s.baseBranch).toBe('');
    });
  });

  it('worktree.event appends to the activity log', () => {
    handleWorktreeEvent(
      msg('worktree.event', { kind: 'create', handleId: 'w1', text: 'Created', at: 5 }),
    );
    expect(useWorktreeStore.getState().activity).toEqual([
      { kind: 'create', handleId: 'w1', text: 'Created', at: 5 },
    ]);
  });

  describe('worktree.orphans', () => {
    it('stores orphans with the clean gate open', () => {
      handleWorktreeOrphans(
        msg('worktree.orphans', { orphans: [{ dir: '/tmp/wt1' }], canClean: true }),
      );
      const s = useWorktreeStore.getState();
      expect(s.orphans).toHaveLength(1);
      expect(s.canClean).toBe(true);
      expect(s.cleanBlockedReason).toBeUndefined();
    });

    it('carries the blocked reason when cleaning is gated', () => {
      handleWorktreeOrphans(
        msg('worktree.orphans', { orphans: [], canClean: false, reason: 'run in progress' }),
      );
      const s = useWorktreeStore.getState();
      expect(s.canClean).toBe(false);
      expect(s.cleanBlockedReason).toBe('run in progress');
    });

    it('defaults to an empty list with cleaning closed', () => {
      handleWorktreeOrphans(msg('worktree.orphans', {}));
      const s = useWorktreeStore.getState();
      expect(s.orphans).toEqual([]);
      expect(s.canClean).toBe(false);
    });
  });

  describe('worktree.cleanup_result', () => {
    it('stamps the result with the arrival time', () => {
      const before = Date.now();
      handleWorktreeCleanupResult(msg('worktree.cleanup_result', { ok: true, removed: 3 }));
      expect(useWorktreeStore.getState().cleanResult).toEqual({
        ok: true,
        removed: 3,
        at: before,
      });
    });

    it('keeps the failure reason', () => {
      handleWorktreeCleanupResult(
        msg('worktree.cleanup_result', { ok: false, removed: 0, reason: 'locked' }),
      );
      expect(useWorktreeStore.getState().cleanResult).toMatchObject({
        ok: false,
        reason: 'locked',
      });
    });
  });

  describe('worktree.merge_result', () => {
    it('stamps a successful merge', () => {
      handleWorktreeMergeResult(msg('worktree.merge_result', { ok: true, branch: 'feat/x' }));
      expect(useWorktreeStore.getState().mergeResult).toMatchObject({
        ok: true,
        branch: 'feat/x',
      });
    });

    it('keeps the conflict file list', () => {
      handleWorktreeMergeResult(
        msg('worktree.merge_result', {
          ok: false,
          branch: 'feat/x',
          conflict: true,
          conflictFiles: ['a.ts', 'b.ts'],
        }),
      );
      expect(useWorktreeStore.getState().mergeResult).toMatchObject({
        conflict: true,
        conflictFiles: ['a.ts', 'b.ts'],
      });
    });
  });

  describe('worktree.diff_result', () => {
    it('stores the summary keyed by directory', () => {
      handleWorktreeDiffResult(
        msg('worktree.diff_result', { dir: '/repo/w1', summary: { files: 2 } }),
      );
      expect(useWorktreeStore.getState().diffByDir['/repo/w1']).toEqual({ files: 2 });
    });

    it('stores an explicit null for a worktree with no changes', () => {
      handleWorktreeDiffResult(msg('worktree.diff_result', { dir: '/repo/w1', summary: null }));
      expect(useWorktreeStore.getState().diffByDir).toHaveProperty('/repo/w1', null);
    });

    it('keeps summaries for other directories', () => {
      handleWorktreeDiffResult(msg('worktree.diff_result', { dir: '/a', summary: { files: 1 } }));
      handleWorktreeDiffResult(msg('worktree.diff_result', { dir: '/b', summary: { files: 2 } }));
      expect(Object.keys(useWorktreeStore.getState().diffByDir).sort()).toEqual(['/a', '/b']);
    });
  });

  // ── subagent ──────────────────────────────────────────────────────────────

  it('subagent.event forwards to the fleet store', () => {
    const applyEvent = vi.fn();
    const original = useFleetStore.getState().applyEvent;
    useFleetStore.setState({ applyEvent } as never);
    try {
      handleSubagentEvent(msg('subagent.event', { kind: 'spawned', name: 'w1' }));
      expect(applyEvent).toHaveBeenCalledWith({ kind: 'spawned', name: 'w1' });
    } finally {
      useFleetStore.setState({ applyEvent: original } as never);
    }
  });

  // ── projections ───────────────────────────────────────────────────────────

  describe('fleet.concurrency_update', () => {
    it('stores active and maximum', () => {
      handleFleetConcurrency(
        msg('fleet.concurrency_update', { fleetConcurrency: 3, fleetConcurrencyMax: 8 }),
      );
      expect(useFleetStore.getState()).toMatchObject({
        fleetConcurrency: 3,
        fleetConcurrencyMax: 8,
      });
    });

    it('stores lifetime spawn budget fields when present', () => {
      handleFleetConcurrency(
        msg('fleet.concurrency_update', {
          fleetConcurrency: 2,
          fleetConcurrencyMax: 8,
          maxSpawns: 256,
          usedSpawns: 103,
          remainingSpawns: 153,
          effectiveSource: 'maxConcurrent=profile, maxSpawns=profile',
          checkpointMaxSpawns: 96,
          ceilingMismatch: true,
        }),
      );
      expect(useFleetStore.getState()).toMatchObject({
        fleetConcurrency: 2,
        fleetConcurrencyMax: 8,
        fleetMaxSpawns: 256,
        fleetUsedSpawns: 103,
        fleetRemainingSpawns: 153,
        fleetBudgetSource: 'maxConcurrent=profile, maxSpawns=profile',
        fleetCheckpointMaxSpawns: 96,
        fleetCeilingMismatch: true,
      });
    });

    it('ignores a frame the projection rejects', () => {
      useFleetStore.setState({ fleetConcurrency: 1, fleetConcurrencyMax: 2 } as never);
      handleFleetConcurrency(msg('fleet.concurrency_update', null));
      expect(useFleetStore.getState()).toMatchObject({
        fleetConcurrency: 1,
        fleetConcurrencyMax: 2,
      });
    });

    it('ignores a frame of the wrong type', () => {
      useFleetStore.setState({ fleetConcurrency: 1 } as never);
      handleFleetConcurrency(msg('sessions.status_update', { sessions: [] }));
      expect(useFleetStore.getState().fleetConcurrency).toBe(1);
    });
  });

  describe('client.status_update', () => {
    it('projects the payload onto the current session', () => {
      handleClientStatusUpdate(
        msg('client.status_update', {
          clientType: 'webui',
          clientId: 'c1',
          agentCount: 2,
          model: 'opus',
          mode: 'code',
          toolCalls: 7,
          inputTokens: 100,
          outputTokens: 50,
          cacheTokens: 10,
          costUsd: 0.25,
          timestamp: 1234,
        }),
      );
      expect(useMonitorStore.getState().currentSession).toMatchObject({
        clientType: 'webui',
        clientId: 'c1',
        agentCount: 2,
        model: 'opus',
        toolCalls: 7,
        costUsd: 0.25,
      });
    });

    it('ignores a frame the projection rejects', () => {
      useMonitorStore.setState({ currentSession: null } as never);
      handleClientStatusUpdate(msg('client.status_update', null));
      expect(useMonitorStore.getState().currentSession).toBeNull();
    });

    it('ignores a frame of the wrong type', () => {
      useMonitorStore.setState({ currentSession: null } as never);
      handleClientStatusUpdate(msg('fleet.concurrency_update', { fleetConcurrency: 1 }));
      expect(useMonitorStore.getState().currentSession).toBeNull();
    });
  });

  // ── sessions.status_update (throttled) ────────────────────────────────────

  describe('sessions.status_update', () => {
    it('always stores the live session list', () => {
      clearThrottles();
      handleSessionsStatusUpdate(
        msg('sessions.status_update', { sessions: [session('s1'), session('s2')] }),
      );
      expect(useMonitorStore.getState().liveSessions).toHaveLength(2);
    });

    it('stores an empty list when the payload omits sessions', () => {
      clearThrottles();
      handleSessionsStatusUpdate(msg('sessions.status_update', {}));
      expect(useMonitorStore.getState().liveSessions).toEqual([]);
    });

    it('ignores a frame the projection rejects', () => {
      clearThrottles();
      useMonitorStore.setState({ liveSessions: [session('keep')] } as never);
      handleSessionsStatusUpdate(msg('sessions.status_update', null));
      expect(useMonitorStore.getState().liveSessions).toEqual([session('keep')]);
    });

    it('refreshes the mailbox at most once per 5 seconds', () => {
      clearThrottles();
      handleSessionsStatusUpdate(msg('sessions.status_update', { sessions: [] }));
      expect(send).toHaveBeenCalledTimes(2); // messages + agents

      send.mockReset();
      vi.advanceTimersByTime(4_999);
      handleSessionsStatusUpdate(msg('sessions.status_update', { sessions: [] }));
      expect(send).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      handleSessionsStatusUpdate(msg('sessions.status_update', { sessions: [] }));
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('pushes a viz snapshot at most once per second', () => {
      clearThrottles();
      handleSessionsStatusUpdate(msg('sessions.status_update', { sessions: [session('s1')] }));
      const afterFirst = useVizStore.getState().events.length;

      // Inside the 1s gate — the expensive graph rebuild is skipped.
      vi.advanceTimersByTime(999);
      handleSessionsStatusUpdate(msg('sessions.status_update', { sessions: [session('s1')] }));
      expect(useVizStore.getState().events).toHaveLength(afterFirst);

      vi.advanceTimersByTime(1);
      handleSessionsStatusUpdate(msg('sessions.status_update', { sessions: [session('s1')] }));
      expect(useVizStore.getState().events.length).toBeGreaterThanOrEqual(afterFirst);
    });

    it('still stores sessions while the viz gate is closed', () => {
      clearThrottles();
      handleSessionsStatusUpdate(msg('sessions.status_update', { sessions: [session('s1')] }));
      handleSessionsStatusUpdate(
        msg('sessions.status_update', { sessions: [session('s1'), session('s2')] }),
      );
      // The early `return` guards only the viz push, never the store write.
      expect(useMonitorStore.getState().liveSessions).toHaveLength(2);
    });
  });
});

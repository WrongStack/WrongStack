import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() };
vi.mock('@/components/Toaster', () => ({ toast }));

const { useCoordinatorMonitorStore } = await import('../../src/stores');
const { coordinatorHandlerMap } = await import('../../src/hooks/ws-handlers/coordinator-handlers');

const store = () => useCoordinatorMonitorStore.getState();

/** Dispatch a wire frame through the handler map. */
function handle(type: string, payload: unknown) {
  const fn = coordinatorHandlerMap[type];
  if (!fn) throw new Error(`no handler registered for ${type}`);
  fn({ type, payload } as never);
}

describe('coordinator ws-handler map', () => {
  beforeEach(() => {
    store().clear();
    toast.info.mockReset();
    toast.error.mockReset();
  });

  it('registers a handler for every coordinator wire type', () => {
    expect(Object.keys(coordinatorHandlerMap).sort()).toEqual(
      [
        'budget.decision',
        'budget.threshold_reached',
        'consensus.vote_cast',
        'consensus.vote_initiated',
        'consensus.vote_resolved',
        'coordinator.stats',
        'coordinator.status',
        'subagent.budget_extended',
        'task.completed',
        'task.failed',
        'task.pending',
        'task.started',
      ].sort(),
    );
  });

  // ── coordinator.status ────────────────────────────────────────────────────

  describe('coordinator.status', () => {
    it('records status and mode', () => {
      handle('coordinator.status', { status: 'running', mode: 'swarm' });
      expect(store().coordinatorStatus).toBe('running');
      expect(store().coordinatorMode).toBe('swarm');
    });

    it('does not touch task counts when no taskQueue is present', () => {
      handle('coordinator.status', { status: 'running' });
      expect(store().taskCounts).toEqual({ pending: 0, running: 0, completed: 0, failed: 0 });
    });

    it('projects taskQueue onto the counters', () => {
      handle('coordinator.status', {
        status: 'running',
        subagentCount: 3,
        taskQueue: { pending: 2, running: 1, completed: 5, failed: 1 },
      });
      // `failed` is not carried by updateCoordinatorStats — it is reset to 0.
      expect(store().taskCounts).toEqual({ pending: 2, running: 1, completed: 5, failed: 0 });
    });

    it('defaults a missing subagentCount to zero without throwing', () => {
      expect(() =>
        handle('coordinator.status', {
          status: 'draining',
          taskQueue: { pending: 0, running: 0, completed: 0, failed: 0 },
        }),
      ).not.toThrow();
    });
  });

  // ── coordinator.stats ─────────────────────────────────────────────────────

  it('coordinator.stats forwards the payload to the store', () => {
    handle('coordinator.stats', {
      total: 1,
      running: 1,
      idle: 0,
      stopped: 0,
      inFlight: 1,
      pending: 0,
      completed: 2,
      subagentStatuses: [{ id: 'a1', name: 'Alpha', status: 'running' }],
    });
    expect(store().subagents.get('a1')?.name).toBe('Alpha');
    expect(store().taskCounts).toMatchObject({ running: 1, completed: 2 });
  });

  // ── budget ────────────────────────────────────────────────────────────────

  describe('budget.threshold_reached', () => {
    const base = { subagentId: 'a1', kind: 'tokens', used: 90, limit: 100, timeoutMs: 0 };

    it('pushes a timeline event', () => {
      handle('budget.threshold_reached', { ...base, ts: 1234, taskId: 't1' });
      expect(store().events[0]).toMatchObject({
        type: 'budget.threshold_reached',
        ts: 1234,
        subagentId: 'a1',
        taskId: 't1',
      });
    });

    it('falls back to now when the frame carries no timestamp', () => {
      handle('budget.threshold_reached', base);
      expect(store().events[0]?.ts).toBeGreaterThan(0);
    });

    it('raises an alert at or above 85%', () => {
      handle('budget.threshold_reached', base);
      expect(store().budgetAlerts).toHaveLength(1);
      expect(store().budgetAlerts[0]).toMatchObject({ subagentId: 'a1', pct: 90 });
    });

    it('raises an alert exactly at the 85% boundary', () => {
      handle('budget.threshold_reached', { ...base, used: 85 });
      expect(store().budgetAlerts).toHaveLength(1);
    });

    it('stays quiet below 85%', () => {
      handle('budget.threshold_reached', { ...base, used: 84 });
      expect(store().budgetAlerts).toHaveLength(0);
    });

    it('stays quiet when the limit is zero — no divide-by-zero alert', () => {
      handle('budget.threshold_reached', { ...base, limit: 0 });
      expect(store().budgetAlerts).toHaveLength(0);
    });

    it('records the agent so the roster shows it even before stats arrive', () => {
      handle('budget.threshold_reached', base);
      expect(store().subagents.get('a1')?.budgetUsage?.elapsedMs).toBe(90);
    });

    it('defaults elapsedMs to 0 when used is absent', () => {
      handle('budget.threshold_reached', { subagentId: 'a1', kind: 'tokens', limit: 100 });
      expect(store().subagents.get('a1')?.budgetUsage?.elapsedMs).toBe(0);
    });
  });

  describe('budget.decision', () => {
    it('annotates the matching alert and emits an event', () => {
      handle('budget.threshold_reached', {
        subagentId: 'a1',
        kind: 'timeout',
        used: 100,
        limit: 100,
        timeoutMs: 0,
      });
      handle('budget.decision', {
        subagentId: 'a1',
        kind: 'timeout',
        decision: 'extend',
        extended: { timeoutMs: 9000 },
      });
      expect(store().budgetAlerts[0]).toMatchObject({ decision: 'extend', newLimit: 9000 });
      expect(store().events[0]).toMatchObject({ type: 'budget.decision' });
    });

    it.each([
      [{ timeoutMs: 1 }, 1],
      [{ maxIterations: 2 }, 2],
      [{ maxToolCalls: 3 }, 3],
    ])('resolves the new limit from %o', (extended, expected) => {
      handle('budget.decision', {
        subagentId: 'a1',
        kind: 'timeout',
        decision: 'extend',
        extended,
      });
      expect(store().events[0]?.payload).toMatchObject({ newLimit: expected });
    });

    it('prefers timeoutMs over the other extension fields', () => {
      handle('budget.decision', {
        subagentId: 'a1',
        kind: 'timeout',
        decision: 'extend',
        extended: { timeoutMs: 1, maxIterations: 2, maxToolCalls: 3 },
      });
      expect(store().events[0]?.payload).toMatchObject({ newLimit: 1 });
    });

    it('leaves newLimit undefined for a deny with no extension', () => {
      handle('budget.decision', { subagentId: 'a1', kind: 'cost', decision: 'deny' });
      expect(store().events[0]?.payload).toHaveProperty('newLimit', undefined);
    });
  });

  describe('subagent.budget_extended', () => {
    it('raises the stored limit and emits an event', () => {
      store().updateSubagentBudget('a1', { budgetLimits: { timeoutMs: 1000 } });
      handle('subagent.budget_extended', {
        subagentId: 'a1',
        kind: 'timeout',
        extendedTo: 8000,
      });
      expect(store().subagents.get('a1')?.budgetLimits?.timeoutMs).toBe(8000);
      expect(store().events[0]).toMatchObject({ type: 'subagent.budget_extended' });
    });

    it('still emits an event for an unknown agent', () => {
      handle('subagent.budget_extended', { subagentId: 'ghost', kind: 'timeout', extendedTo: 1 });
      expect(store().events[0]?.type).toBe('subagent.budget_extended');
    });
  });

  // ── consensus ─────────────────────────────────────────────────────────────

  describe('consensus', () => {
    const eligible = [
      { agentId: 'a1', agentName: 'Alpha' },
      { agentId: 'a2', agentName: 'Beta' },
    ];

    it('opens a vote, emits an event and toasts', () => {
      handle('consensus.vote_initiated', { changeId: 'c1', title: 'Ship it', eligible });
      expect(store().consensusVotes.get('c1')?.status).toBe('pending');
      expect(store().events[0]?.type).toBe('consensus.vote_initiated');
      expect(toast.info).toHaveBeenCalledWith('Vote started: Ship it');
    });

    it('resolves a voter id to its display name from the eligible roster', () => {
      handle('consensus.vote_initiated', { changeId: 'c1', title: 'Ship it', eligible });
      handle('consensus.vote_cast', { changeId: 'c1', voterId: 'a2', value: 'approve' });
      expect(store().consensusVotes.get('c1')?.votes[0]).toMatchObject({
        agentId: 'a2',
        agentName: 'Beta',
      });
    });

    it('falls back to the raw id for a voter not on the roster', () => {
      handle('consensus.vote_initiated', { changeId: 'c1', title: 'Ship it', eligible });
      handle('consensus.vote_cast', { changeId: 'c1', voterId: 'stranger', value: 'reject' });
      expect(store().consensusVotes.get('c1')?.votes[0]?.agentName).toBe('stranger');
    });

    it('handles a ballot for an unknown vote without throwing', () => {
      expect(() =>
        handle('consensus.vote_cast', { changeId: 'nope', voterId: 'a1', value: 'approve' }),
      ).not.toThrow();
      // The event is still recorded even though the vote is unknown.
      expect(store().events[0]?.type).toBe('consensus.vote_cast');
    });

    it('resolves a vote, emits an event and toasts the tally', () => {
      handle('consensus.vote_initiated', { changeId: 'c1', title: 'Ship it', eligible });
      handle('consensus.vote_resolved', {
        changeId: 'c1',
        result: 'approved',
        approveCount: 2,
        rejectCount: 0,
      });
      expect(store().consensusVotes.get('c1')?.status).toBe('approved');
      expect(toast.info).toHaveBeenCalledWith('Vote resolved: approved (y2 n0)');
    });
  });

  // ── tasks ─────────────────────────────────────────────────────────────────

  describe('tasks', () => {
    it('queues a pending task and emits an event', () => {
      handle('task.pending', { taskId: 't1', description: 'do it', priority: 2 });
      expect(store().tasks.get('t1')).toMatchObject({ status: 'pending', priority: 2 });
      expect(store().events[0]?.type).toBe('task.pending');
    });

    it('starts a task and attributes it to the subagent', () => {
      handle('task.pending', { taskId: 't1', description: 'do it' });
      handle('task.started', { taskId: 't1', subagentId: 'a1' });
      expect(store().tasks.get('t1')).toMatchObject({ status: 'running', subagentId: 'a1' });
      expect(store().events[0]).toMatchObject({ type: 'task.started', subagentId: 'a1' });
    });

    it('completes a task', () => {
      handle('task.pending', { taskId: 't1', description: 'do it' });
      handle('task.started', { taskId: 't1', subagentId: 'a1' });
      handle('task.completed', {
        taskId: 't1',
        subagentId: 'a1',
        status: 'completed',
        durationMs: 500,
      });
      expect(store().tasks.get('t1')).toMatchObject({ status: 'completed', durationMs: 500 });
      expect(store().taskCounts.completed).toBe(1);
    });

    it('fails a task, truncates the error in the event and toasts', () => {
      const longError = 'e'.repeat(200);
      handle('task.pending', { taskId: 't1', description: 'do it' });
      handle('task.started', { taskId: 't1', subagentId: 'a1' });
      handle('task.failed', { taskId: 't1', subagentId: 'a1', error: longError });

      expect(store().tasks.get('t1')).toMatchObject({ status: 'failed', error: longError });
      // Event payload is capped at 120 chars, the toast at 80.
      const eventPayload = store().events[0]?.payload as { error: string } | undefined;
      expect(eventPayload?.error).toHaveLength(120);
      expect(toast.error).toHaveBeenCalledWith(`Task failed: ${'e'.repeat(80)}`);
    });

    it('stringifies a non-string failure reason', () => {
      handle('task.failed', { taskId: 't1', subagentId: 'a1', error: { code: 500 } });
      expect(toast.error).toHaveBeenCalledWith('Task failed: [object Object]');
    });
  });
});

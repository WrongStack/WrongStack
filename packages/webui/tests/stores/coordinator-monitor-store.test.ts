import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BudgetKind,
  useCoordinatorMonitorStore,
} from '../../src/stores/coordinator-monitor-store';

const store = () => useCoordinatorMonitorStore.getState();

describe('coordinator monitor store', () => {
  beforeEach(() => {
    store().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── coordinator status ────────────────────────────────────────────────────

  describe('coordinator status', () => {
    it('starts idle with empty collections', () => {
      const s = store();
      expect(s.coordinatorStatus).toBe('idle');
      expect(s.coordinatorMode).toBeUndefined();
      expect(s.subagents.size).toBe(0);
      expect(s.events).toEqual([]);
      expect(s.consensusVotes.size).toBe(0);
      expect(s.tasks.size).toBe(0);
      expect(s.taskCounts).toEqual({ pending: 0, running: 0, completed: 0, failed: 0 });
      expect(s.budgetAlerts).toEqual([]);
    });

    it('records status and mode together', () => {
      store().setCoordinatorStatus('running', 'swarm');
      expect(store().coordinatorStatus).toBe('running');
      expect(store().coordinatorMode).toBe('swarm');
    });

    it('clears the mode when a status arrives without one', () => {
      store().setCoordinatorStatus('running', 'swarm');
      store().setCoordinatorStatus('draining');
      expect(store().coordinatorStatus).toBe('draining');
      expect(store().coordinatorMode).toBeUndefined();
    });

    it('bumps lastUpdated on every mutation', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));
      store().setCoordinatorStatus('idle');
      const first = store().lastUpdated;
      vi.setSystemTime(new Date('2026-07-29T00:00:05Z'));
      store().setCoordinatorStatus('running');
      expect(store().lastUpdated).toBeGreaterThan(first);
    });
  });

  // ── subagents ─────────────────────────────────────────────────────────────

  describe('updateCoordinatorStats', () => {
    const stats = {
      total: 2,
      running: 1,
      idle: 1,
      stopped: 0,
      inFlight: 1,
      pending: 3,
      completed: 4,
    };

    it('maps inFlight/pending/completed onto taskCounts and zeroes failed', () => {
      store().updateCoordinatorStats(stats);
      expect(store().taskCounts).toEqual({
        pending: 3,
        running: 1,
        completed: 4,
        failed: 0,
      });
    });

    it('tolerates a stats payload with no subagentStatuses', () => {
      store().updateCoordinatorStats(stats);
      expect(store().subagents.size).toBe(0);
    });

    it('inserts new subagents with the default "agent" role', () => {
      store().updateCoordinatorStats({
        ...stats,
        subagentStatuses: [{ id: 'a1', name: 'Alpha', status: 'running', currentTask: 't1' }],
      });
      const agent = store().subagents.get('a1');
      expect(agent).toMatchObject({
        id: 'a1',
        name: 'Alpha',
        role: 'agent',
        status: 'running',
        currentTask: 't1',
      });
    });

    it('preserves role, budget and lastSeen from an existing entry', () => {
      store().updateSubagentBudget('a1', {
        role: 'reviewer',
        budgetLimits: { maxIterations: 10 },
        budgetUsage: { iterations: 2, toolCalls: 1, tokens: 100, costUsd: 0.1, elapsedMs: 500 },
      });
      const seenAt = store().subagents.get('a1')?.lastSeen;

      store().updateCoordinatorStats({
        ...stats,
        subagentStatuses: [{ id: 'a1', name: 'Alpha', status: 'idle' }],
      });
      const agent = store().subagents.get('a1');
      expect(agent?.role).toBe('reviewer');
      expect(agent?.budgetLimits).toEqual({ maxIterations: 10 });
      expect(agent?.budgetUsage?.iterations).toBe(2);
      expect(agent?.lastSeen).toBe(seenAt);
      expect(agent?.status).toBe('idle');
    });

    it('replaces the subagents Map rather than mutating it (referential change for React)', () => {
      const before = store().subagents;
      store().updateCoordinatorStats(stats);
      expect(store().subagents).not.toBe(before);
    });

    it('caps subagents at 200, evicting stopped ones first', () => {
      // 200 stopped + 5 running: the stopped entries are dropped first.
      const many = Array.from({ length: 200 }, (_, i) => ({
        id: `stopped-${i}`,
        name: `S${i}`,
        status: 'stopped',
      }));
      const live = Array.from({ length: 5 }, (_, i) => ({
        id: `live-${i}`,
        name: `L${i}`,
        status: 'running',
      }));
      store().updateCoordinatorStats({ ...stats, subagentStatuses: [...many, ...live] });

      const s = store().subagents;
      expect(s.size).toBe(200);
      for (let i = 0; i < 5; i++) {
        expect(s.has(`live-${i}`), `live-${i} was evicted before a stopped agent`).toBe(true);
      }
    });

    it('falls back to oldest-first eviction when nothing is stopped', () => {
      const running = Array.from({ length: 205 }, (_, i) => ({
        id: `r-${i}`,
        name: `R${i}`,
        status: 'running',
      }));
      store().updateCoordinatorStats({ ...stats, subagentStatuses: running });
      const s = store().subagents;
      expect(s.size).toBe(200);
      expect(s.has('r-0')).toBe(false);
      expect(s.has('r-204')).toBe(true);
    });
  });

  describe('updateSubagentBudget', () => {
    it('creates a placeholder entry keyed by id when the agent is unknown', () => {
      store().updateSubagentBudget('ghost', { currentTask: 'boot' });
      const agent = store().subagents.get('ghost');
      expect(agent).toMatchObject({
        id: 'ghost',
        name: 'ghost',
        role: 'agent',
        status: 'idle',
        currentTask: 'boot',
      });
    });

    it('merges a partial patch onto an existing entry', () => {
      store().updateSubagentBudget('a1', { name: 'Alpha', status: 'running' });
      store().updateSubagentBudget('a1', {
        budgetUsage: { iterations: 5, toolCalls: 3, tokens: 900, costUsd: 0.4, elapsedMs: 2000 },
      });
      const agent = store().subagents.get('a1');
      expect(agent?.name).toBe('Alpha');
      expect(agent?.status).toBe('running');
      expect(agent?.budgetUsage?.tokens).toBe(900);
    });

    it('refreshes lastSeen on every patch', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));
      store().updateSubagentBudget('a1', {});
      const first = store().subagents.get('a1')?.lastSeen ?? 0;
      vi.setSystemTime(new Date('2026-07-29T00:00:10Z'));
      store().updateSubagentBudget('a1', {});
      expect(store().subagents.get('a1')?.lastSeen).toBeGreaterThan(first);
    });
  });

  // ── events ────────────────────────────────────────────────────────────────

  describe('pushEvent', () => {
    it('prepends events so the newest is first', () => {
      store().pushEvent('task.started', { taskId: 't1', subagentId: 'a1' }, 1);
      store().pushEvent('task.started', { taskId: 't2', subagentId: 'a1' }, 2);
      expect(store().events[0]?.ts).toBe(2);
    });

    it('caps the timeline at 200 events', () => {
      for (let i = 0; i < 205; i++) store().pushEvent('noop', {}, i);
      expect(store().events).toHaveLength(200);
      expect(store().events[0]?.ts).toBe(204);
    });

    it('builds a stable id from ts and type', () => {
      store().pushEvent('task.started', { taskId: 't1', subagentId: 'a1' }, 42);
      expect(store().events[0]?.id).toBe('42-task.started');
    });

    it('carries subagentId and taskId through', () => {
      store().pushEvent('task.started', { taskId: 't1', subagentId: 'a1' }, 1, 'a1', 't1');
      expect(store().events[0]).toMatchObject({ subagentId: 'a1', taskId: 't1' });
    });

    it('prefers an explicit payload.kind over the event type', () => {
      store().pushEvent(
        'budget.threshold_reached',
        {
          kind: 'tokens',
          used: 5,
          limit: 10,
          subagentId: 'a1',
        },
        1,
      );
      expect(store().events[0]?.kind).toBe('tokens');
    });

    it('falls back to the type when the payload has no kind', () => {
      store().pushEvent('custom.thing', {}, 1);
      expect(store().events[0]?.kind).toBe('custom.thing');
    });

    it.each([
      [50, 'info'],
      [85, 'warning'],
      [99, 'warning'],
      [100, 'danger'],
      [150, 'danger'],
    ])('grades a %i%% budget event as %s', (pct, level) => {
      store().pushEvent(
        'budget.threshold_reached',
        { kind: 'tokens', used: pct, limit: 100, subagentId: 'a1' },
        1,
      );
      expect(store().events[0]?.level).toBe(level);
    });

    it('treats a zero limit as non-gradable and falls back to info', () => {
      store().pushEvent(
        'budget.threshold_reached',
        { kind: 'tokens', used: 5, limit: 0, subagentId: 'a1' },
        1,
      );
      expect(store().events[0]?.level).toBe('info');
    });

    it('treats a non-numeric limit as non-gradable', () => {
      store().pushEvent(
        'budget.decision',
        { subagentId: 'a1', kind: 'tokens', decision: 'deny', limit: 'x' },
        1,
      );
      expect(store().events[0]?.level).toBe('info');
    });

    it('flags an initiated consensus vote as warning and a resolved one as info', () => {
      store().pushEvent('consensus.vote_initiated', { title: 'Ship it', eligible: ['a', 'b'] }, 1);
      expect(store().events[0]?.level).toBe('warning');
      store().pushEvent(
        'consensus.vote_resolved',
        { result: 'approved', approveCount: 2, rejectCount: 0 },
        2,
      );
      expect(store().events[0]?.level).toBe('info');
    });

    describe('message rendering', () => {
      function msgFor(type: string, payload: Record<string, unknown>): string {
        store().pushEvent(type, payload, 1);
        return store().events[0]?.message ?? '';
      }

      it('renders budget.threshold_reached as a percentage', () => {
        expect(
          msgFor('budget.threshold_reached', {
            subagentId: 'a1',
            kind: 'tokens',
            used: 90,
            limit: 100,
          }),
        ).toBe('a1 [tokens] 90% (90/100)');
      });

      it('renders 0% rather than NaN when the limit is zero', () => {
        expect(
          msgFor('budget.threshold_reached', {
            subagentId: 'a1',
            kind: 'tokens',
            used: 5,
            limit: 0,
          }),
        ).toBe('a1 [tokens] 0% (5/0)');
      });

      it('renders budget.decision', () => {
        expect(
          msgFor('budget.decision', { subagentId: 'a1', kind: 'cost', decision: 'deny' }),
        ).toBe('a1 [cost] → deny');
      });

      it('renders consensus.vote_initiated with the voter count', () => {
        expect(
          msgFor('consensus.vote_initiated', { title: 'Ship it', eligible: ['a', 'b', 'c'] }),
        ).toBe('Vote: "Ship it" — 3 voters');
      });

      it('renders consensus.vote_cast', () => {
        expect(msgFor('consensus.vote_cast', { voterId: 'a1', value: 'approve' })).toBe(
          'a1 voted approve',
        );
      });

      it('renders consensus.vote_resolved with tallies', () => {
        expect(
          msgFor('consensus.vote_resolved', {
            result: 'approved',
            approveCount: 3,
            rejectCount: 1,
          }),
        ).toBe('approved — ✅3 ❌1');
      });

      it('truncates a long task description at 60 chars', () => {
        const long = 'x'.repeat(120);
        expect(msgFor('task.pending', { taskId: 't1', description: long })).toBe(
          `Task queued: "${'x'.repeat(60)}"`,
        );
      });

      it('renders task.started, task.completed and task.failed', () => {
        expect(msgFor('task.started', { taskId: 't1', subagentId: 'a1' })).toBe('a1 started t1');
        expect(
          msgFor('task.completed', { taskId: 't1', status: 'completed', durationMs: 1200 }),
        ).toBe('Task t1 completed (1200ms)');
        expect(msgFor('task.failed', { taskId: 't1', error: 'boom' })).toBe('Task t1 failed: boom');
      });

      it('truncates a long failure reason at 60 chars', () => {
        expect(msgFor('task.failed', { taskId: 't1', error: 'e'.repeat(100) })).toBe(
          `Task t1 failed: ${'e'.repeat(60)}`,
        );
      });

      it('renders subagent.budget_extended', () => {
        expect(
          msgFor('subagent.budget_extended', {
            subagentId: 'a1',
            kind: 'timeout',
            extendedTo: 5000,
          }),
        ).toBe('a1 [timeout] extended → 5000ms');
      });

      it('falls back to the raw type for unknown events', () => {
        expect(msgFor('something.unmapped', {})).toBe('something.unmapped');
      });
    });
  });

  // ── consensus ─────────────────────────────────────────────────────────────

  describe('consensus votes', () => {
    const eligible = [
      { agentId: 'a1', agentName: 'Alpha' },
      { agentId: 'a2', agentName: 'Beta' },
    ];

    it('opens a vote in the pending state with zeroed tallies and a 5-minute expiry', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));
      store().pushConsensusVote('c1', 'Ship it', eligible);
      const vote = store().consensusVotes.get('c1');
      expect(vote).toMatchObject({
        changeId: 'c1',
        title: 'Ship it',
        status: 'pending',
        approveCount: 0,
        rejectCount: 0,
        abstainCount: 0,
        votes: [],
      });
      expect(vote?.expiresAt).toBe(Date.parse('2026-07-29T00:05:00Z'));
    });

    it('tallies approve, reject and abstain independently', () => {
      store().pushConsensusVote('c1', 'Ship it', eligible);
      store().recordConsensusVote('c1', 'a1', 'Alpha', 'approve');
      store().recordConsensusVote('c1', 'a2', 'Beta', 'reject');
      store().recordConsensusVote('c1', 'a3', 'Gamma', 'abstain');
      const vote = store().consensusVotes.get('c1');
      expect(vote?.approveCount).toBe(1);
      expect(vote?.rejectCount).toBe(1);
      expect(vote?.abstainCount).toBe(1);
      expect(vote?.votes).toHaveLength(3);
    });

    it("replaces a voter's earlier ballot rather than duplicating the row", () => {
      store().pushConsensusVote('c1', 'Ship it', eligible);
      store().recordConsensusVote('c1', 'a1', 'Alpha', 'approve');
      store().recordConsensusVote('c1', 'a1', 'Alpha', 'reject');
      const vote = store().consensusVotes.get('c1');
      expect(vote?.votes).toHaveLength(1);
      expect(vote?.votes[0]?.value).toBe('reject');
    });

    it('ignores a ballot for an unknown change id', () => {
      store().recordConsensusVote('nope', 'a1', 'Alpha', 'approve');
      expect(store().consensusVotes.size).toBe(0);
    });

    it('resolves a vote with server-authoritative tallies and a resolvedAt stamp', () => {
      store().pushConsensusVote('c1', 'Ship it', eligible);
      store().recordConsensusVote('c1', 'a1', 'Alpha', 'approve');
      store().resolveConsensusVote('c1', 'approved', 5, 1);
      const vote = store().consensusVotes.get('c1');
      expect(vote?.status).toBe('approved');
      // Server tallies overwrite the locally accumulated counts.
      expect(vote?.approveCount).toBe(5);
      expect(vote?.rejectCount).toBe(1);
      expect(vote?.resolvedAt).toBeGreaterThan(0);
    });

    it('ignores a resolution for an unknown change id', () => {
      store().resolveConsensusVote('nope', 'approved', 1, 0);
      expect(store().consensusVotes.size).toBe(0);
    });

    it('caps votes at 100, evicting resolved ones first', () => {
      for (let i = 0; i < 100; i++) {
        store().pushConsensusVote(`done-${i}`, `t${i}`, eligible);
        store().resolveConsensusVote(`done-${i}`, 'approved', 1, 0);
      }
      for (let i = 0; i < 3; i++) store().pushConsensusVote(`open-${i}`, `o${i}`, eligible);

      const votes = store().consensusVotes;
      expect(votes.size).toBe(100);
      for (let i = 0; i < 3; i++) {
        expect(votes.has(`open-${i}`), `pending vote open-${i} was evicted`).toBe(true);
      }
    });
  });

  // ── tasks ─────────────────────────────────────────────────────────────────

  describe('task lifecycle', () => {
    it('queues a pending task and increments the pending count', () => {
      store().pushTaskPending('t1', 'do the thing', 5);
      expect(store().tasks.get('t1')).toMatchObject({
        id: 't1',
        description: 'do the thing',
        status: 'pending',
        priority: 5,
      });
      expect(store().taskCounts.pending).toBe(1);
    });

    it('moves pending → running on start', () => {
      store().pushTaskPending('t1', 'do the thing');
      store().startTask('t1', 'a1');
      expect(store().tasks.get('t1')).toMatchObject({ status: 'running', subagentId: 'a1' });
      expect(store().taskCounts).toMatchObject({ pending: 0, running: 1 });
    });

    it('synthesizes a task row when start arrives before pending', () => {
      store().startTask('t9', 'a1');
      expect(store().tasks.get('t9')).toMatchObject({
        id: 't9',
        description: '',
        status: 'running',
        subagentId: 'a1',
      });
    });

    it('never drives the pending count below zero', () => {
      store().startTask('t1', 'a1');
      expect(store().taskCounts.pending).toBe(0);
    });

    it('completes a task and increments the completed count', () => {
      store().pushTaskPending('t1', 'x');
      store().startTask('t1', 'a1');
      store().completeTask('t1', 'completed', 1500);
      expect(store().tasks.get('t1')).toMatchObject({ status: 'completed', durationMs: 1500 });
      expect(store().taskCounts).toMatchObject({ running: 0, completed: 1, failed: 0 });
    });

    it('routes a completeTask with status "failed" to the failed counter', () => {
      store().pushTaskPending('t1', 'x');
      store().startTask('t1', 'a1');
      store().completeTask('t1', 'failed', 200);
      expect(store().taskCounts).toMatchObject({ completed: 0, failed: 1 });
    });

    it('counts neither for a completeTask with some other status', () => {
      store().pushTaskPending('t1', 'x');
      store().startTask('t1', 'a1');
      store().completeTask('t1', 'cancelled', 200);
      expect(store().taskCounts).toMatchObject({ completed: 0, failed: 0, running: 0 });
    });

    it('ignores completeTask for an unknown id but still decrements running', () => {
      store().startTask('t1', 'a1');
      store().completeTask('ghost', 'completed', 10);
      expect(store().tasks.has('ghost')).toBe(false);
      expect(store().taskCounts.running).toBe(0);
    });

    it('never drives the running count below zero', () => {
      store().completeTask('ghost', 'completed', 10);
      expect(store().taskCounts.running).toBe(0);
    });

    it('failTask records the error and stamps completedAt', () => {
      store().pushTaskPending('t1', 'x');
      store().startTask('t1', 'a1');
      store().failTask('t1', 'boom');
      const task = store().tasks.get('t1');
      expect(task).toMatchObject({ status: 'failed', error: 'boom' });
      expect(task?.completedAt).toBeGreaterThan(0);
      expect(store().taskCounts).toMatchObject({ running: 0, failed: 1 });
    });

    it('failTask on an unknown id still adjusts the counters', () => {
      store().failTask('ghost', 'boom');
      expect(store().tasks.has('ghost')).toBe(false);
      expect(store().taskCounts.failed).toBe(1);
    });

    it('caps tasks at 300, evicting terminal ones first', () => {
      for (let i = 0; i < 300; i++) {
        store().pushTaskPending(`done-${i}`, 'x');
        store().completeTask(`done-${i}`, 'completed', 1);
      }
      for (let i = 0; i < 5; i++) store().pushTaskPending(`open-${i}`, 'x');

      const tasks = store().tasks;
      expect(tasks.size).toBe(300);
      for (let i = 0; i < 5; i++) {
        expect(tasks.has(`open-${i}`), `pending task open-${i} was evicted`).toBe(true);
      }
    });
  });

  // ── budget alerts ─────────────────────────────────────────────────────────

  describe('budget alerts', () => {
    it('records an alert with a computed percentage', () => {
      store().recordBudgetAlert('a1', 'tokens', 90, 100);
      const alert = store().budgetAlerts[0];
      expect(alert).toMatchObject({
        subagentId: 'a1',
        kind: 'tokens',
        used: 90,
        limit: 100,
        pct: 90,
      });
    });

    it('reports 0% instead of NaN when the limit is zero', () => {
      store().recordBudgetAlert('a1', 'tokens', 5, 0);
      expect(store().budgetAlerts[0]?.pct).toBe(0);
    });

    it.each<[BudgetKind, number, 'warning' | 'danger']>([
      ['tokens', 50, 'warning'],
      ['tokens', 100, 'danger'],
      ['iterations', 99, 'warning'],
      ['cost', 99, 'warning'],
      ['cost', 100, 'danger'],
      ['timeout', 100, 'danger'],
      ['idle_timeout', 50, 'warning'],
    ])('grades a %s alert at %i%% as %s', (kind, pct, level) => {
      store().recordBudgetAlert('a1', kind, pct, 100);
      expect(store().budgetAlerts[0]?.level).toBe(level);
    });

    it('prepends alerts and caps the list at 50', () => {
      for (let i = 0; i < 55; i++) store().recordBudgetAlert(`a${i}`, 'tokens', i, 100);
      expect(store().budgetAlerts).toHaveLength(50);
      expect(store().budgetAlerts[0]?.subagentId).toBe('a54');
    });

    it('attaches an extend decision to the matching alert and softens it to warning', () => {
      store().recordBudgetAlert('a1', 'tokens', 100, 100);
      expect(store().budgetAlerts[0]?.level).toBe('danger');
      store().recordBudgetDecision('a1', 'tokens', 'extend', 500);
      const alert = store().budgetAlerts.find((a) => a.subagentId === 'a1');
      expect(alert).toMatchObject({ decision: 'extend', newLimit: 500, level: 'warning' });
    });

    it('escalates the alert to danger on a deny decision', () => {
      store().recordBudgetAlert('a1', 'tokens', 50, 100);
      store().recordBudgetDecision('a1', 'tokens', 'deny');
      const alert = store().budgetAlerts.find((a) => a.subagentId === 'a1');
      expect(alert).toMatchObject({ decision: 'deny', level: 'danger', newLimit: undefined });
    });

    it('leaves alerts for other agents or kinds untouched', () => {
      store().recordBudgetAlert('a1', 'tokens', 50, 100);
      store().recordBudgetAlert('a2', 'cost', 50, 100);
      store().recordBudgetDecision('a1', 'tokens', 'deny');
      const other = store().budgetAlerts.find((a) => a.subagentId === 'a2');
      expect(other?.decision).toBeUndefined();
    });

    it('is a no-op when no alert matches the decision', () => {
      store().recordBudgetAlert('a1', 'tokens', 50, 100);
      store().recordBudgetDecision('ghost', 'tokens', 'extend', 1);
      expect(store().budgetAlerts.every((a) => a.decision === undefined)).toBe(true);
    });
  });

  describe('recordBudgetExtended', () => {
    function seedWithLimits() {
      store().updateSubagentBudget('a1', {
        budgetLimits: { maxIterations: 5, maxToolCalls: 10, timeoutMs: 1000 },
      });
    }

    it('raises the timeout limit', () => {
      seedWithLimits();
      store().recordBudgetExtended('a1', 'timeout', 9000);
      expect(store().subagents.get('a1')?.budgetLimits?.timeoutMs).toBe(9000);
    });

    it('ignores a timeout extension with no new value', () => {
      seedWithLimits();
      store().recordBudgetExtended('a1', 'timeout');
      expect(store().subagents.get('a1')?.budgetLimits?.timeoutMs).toBe(1000);
    });

    it('raises the iteration and tool-call limits', () => {
      seedWithLimits();
      store().recordBudgetExtended('a1', 'iterations', 50);
      store().recordBudgetExtended('a1', 'tool_calls', 99);
      const limits = store().subagents.get('a1')?.budgetLimits;
      expect(limits?.maxIterations).toBe(50);
      expect(limits?.maxToolCalls).toBe(99);
    });

    it('is a no-op for an unknown agent', () => {
      store().recordBudgetExtended('ghost', 'timeout', 5000);
      expect(store().subagents.has('ghost')).toBe(false);
    });

    it('is a no-op for an agent that has no budgetLimits yet', () => {
      store().updateSubagentBudget('a1', { name: 'Alpha' });
      store().recordBudgetExtended('a1', 'timeout', 5000);
      expect(store().subagents.get('a1')?.budgetLimits).toBeUndefined();
    });
  });

  // ── reset ─────────────────────────────────────────────────────────────────

  it('clear() resets every collection and counter', () => {
    store().setCoordinatorStatus('running', 'swarm');
    store().updateSubagentBudget('a1', {});
    store().pushEvent('task.started', { taskId: 't', subagentId: 'a' }, 1);
    store().pushConsensusVote('c1', 'x', []);
    store().pushTaskPending('t1', 'x');
    store().recordBudgetAlert('a1', 'tokens', 1, 2);

    store().clear();

    const s = store();
    expect(s.coordinatorStatus).toBe('idle');
    expect(s.coordinatorMode).toBeUndefined();
    expect(s.subagents.size).toBe(0);
    expect(s.events).toEqual([]);
    expect(s.consensusVotes.size).toBe(0);
    expect(s.tasks.size).toBe(0);
    expect(s.taskCounts).toEqual({ pending: 0, running: 0, completed: 0, failed: 0 });
    expect(s.budgetAlerts).toEqual([]);
  });
});

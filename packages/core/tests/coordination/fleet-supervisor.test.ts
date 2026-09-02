/**
 * FleetSupervisor — signal detection + brain gating + rate limits.
 *
 * All ports are faked; `evaluate()` is driven directly with a fake clock so
 * no wall-clock timing is asserted. Pins:
 *   - pinned-starvation → brain-approved retarget + steer to loser +
 *     leader notification
 *   - overload → queue tail moves, head stays
 *   - brain deny / ask_human → zero actions, outcome recorded
 *   - backlog (2 sustained ticks) → spawnHelper; spawn-budget error
 *     degrades to notifyLeader
 *   - stuck agent → steer; failure streak → steer (terminate only when
 *     allowTerminate)
 *   - cooldown, one-retarget-per-task, maxInterventionsPerSubagent,
 *     collab exclusion, workComplete dormancy, kill switch
 *   - non-interference: nothing ever touches budget negotiation
 */
import { describe, expect, it, vi } from 'vitest';
import type { BrainArbiter, BrainDecision } from '../../src/coordination/brain.js';
import { FleetBus } from '../../src/coordination/fleet-bus.js';
import {
  FleetSupervisor,
  type FleetSupervisorActions,
  type FleetSupervisorSource,
  type SupervisedSubagent,
} from '../../src/coordination/fleet-supervisor.js';
import { EventBus } from '../../src/kernel/events.js';
import type { TaskSpec } from '../../src/types/multi-agent.js';

function approveBrain(): BrainArbiter & { calls: number } {
  const b = {
    calls: 0,
    async decide(req): Promise<BrainDecision> {
      b.calls++;
      const recommended = req.options?.find((o) => o.recommended);
      return { type: 'answer', optionId: recommended?.id, text: recommended?.label ?? 'ok' };
    },
  } as BrainArbiter & { calls: number };
  return b;
}

function denyBrain(): BrainArbiter {
  return {
    async decide(): Promise<BrainDecision> {
      return { type: 'answer', optionId: 'wait', text: 'wait' };
    },
  };
}

function escalateBrain(): BrainArbiter {
  return {
    async decide(): Promise<BrainDecision> {
      return { type: 'ask_human', prompt: 'unresolved' };
    },
  };
}

interface Harness {
  supervisor: FleetSupervisor;
  actions: {
    retargetPendingTask: ReturnType<typeof vi.fn>;
    spawnHelper: ReturnType<typeof vi.fn>;
    steerAgent: ReturnType<typeof vi.fn>;
    notifyLeader: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  };
  events: EventBus;
  fleet: FleetBus;
  state: { subagents: SupervisedSubagent[]; pending: TaskSpec[]; workComplete: boolean };
  clock: { now: number };
  signals: string[];
}

function makeHarness(brain: BrainArbiter, config: Record<string, unknown> = {}): Harness {
  const events = new EventBus();
  const fleet = new FleetBus();
  const clock = { now: 1_000_000 };
  const state = {
    subagents: [] as SupervisedSubagent[],
    pending: [] as TaskSpec[],
    workComplete: false,
  };
  const source: FleetSupervisorSource = {
    subagents: () => state.subagents,
    listPendingTasks: () => state.pending,
    isWorkComplete: () => state.workComplete,
  };
  const actions = {
    retargetPendingTask: vi.fn(() => true),
    spawnHelper: vi.fn(async () => ({ subagentId: 'helper-1' })),
    steerAgent: vi.fn(async () => {}),
    notifyLeader: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
  };
  const supervisor = new FleetSupervisor({
    events,
    fleet,
    brain,
    source,
    actions: actions as never as FleetSupervisorActions,
    now: () => clock.now,
    config: config as never,
  });
  const signals: string[] = [];
  events.on('fleet.supervisor.signal', (e) => signals.push(e.kind));
  return { supervisor, actions, events, fleet, state, clock, signals };
}

const sub = (
  id: string,
  status: SupervisedSubagent['status'],
  task?: string,
): SupervisedSubagent => ({
  id,
  name: id,
  status,
  currentTask: task,
});
const task = (id: string, subagentId?: string): TaskSpec => ({
  id,
  description: `desc ${id}`,
  subagentId,
});

describe('FleetSupervisor', () => {
  it('rebalances a starved pinned task: retarget + steer the loser + notify leader', async () => {
    const h = makeHarness(approveBrain(), { pinnedWaitMs: 60_000 });
    h.state.subagents = [sub('busy', 'running', 'big task'), sub('idle', 'idle')];
    h.state.pending = [task('t-starved', 'busy')];

    await h.supervisor.evaluate(); // first sight — starts the age clock
    expect(h.actions.retargetPendingTask).not.toHaveBeenCalled();

    h.clock.now += 61_000;
    await h.supervisor.evaluate();
    expect(h.signals).toContain('pinned_starvation');
    expect(h.actions.retargetPendingTask).toHaveBeenCalledWith('t-starved', 'idle');
    expect(h.actions.steerAgent).toHaveBeenCalledWith(
      'busy',
      expect.stringContaining('Workload reduced'),
      expect.stringContaining('t-starved'),
    );
    // Third argument names the worker the note is ABOUT, so the host can post
    // it into that worker's conversation rather than the host's own.
    expect(h.actions.notifyLeader).toHaveBeenCalledWith(
      'Fleet rebalanced',
      expect.stringContaining('busy'),
      'busy',
    );
    const last = h.supervisor.history().at(-1);
    expect(last).toMatchObject({ kind: 'pinned_starvation', outcome: 'approved' });
  });

  it('overloaded worker: moves the queue tail immediately, keeps the head pinned', async () => {
    const h = makeHarness(approveBrain(), { overloadPinnedThreshold: 2 });
    h.state.subagents = [sub('busy', 'running'), sub('idle', 'idle')];
    h.state.pending = [task('t-1', 'busy'), task('t-2', 'busy'), task('t-3', 'busy')];

    await h.supervisor.evaluate(); // overload needs no age — fires on first pass
    expect(h.signals).toContain('overloaded_worker');
    const moved = h.actions.retargetPendingTask.mock.calls.map((c) => c[0]);
    expect(moved).toEqual(['t-2', 't-3']); // head t-1 stays
  });

  it('brain deny → zero actions, outcome recorded as denied', async () => {
    const h = makeHarness(denyBrain(), { overloadPinnedThreshold: 2 });
    h.state.subagents = [sub('busy', 'running'), sub('idle', 'idle')];
    h.state.pending = [task('t-1', 'busy'), task('t-2', 'busy')];
    await h.supervisor.evaluate();
    expect(h.actions.retargetPendingTask).not.toHaveBeenCalled();
    expect(h.supervisor.history().at(-1)).toMatchObject({ outcome: 'denied' });
  });

  it('brain ask_human (unresolved) → zero actions, outcome escalated', async () => {
    const h = makeHarness(escalateBrain(), { overloadPinnedThreshold: 2 });
    h.state.subagents = [sub('busy', 'running'), sub('idle', 'idle')];
    h.state.pending = [task('t-1', 'busy'), task('t-2', 'busy')];
    await h.supervisor.evaluate();
    expect(h.actions.retargetPendingTask).not.toHaveBeenCalled();
    expect(h.supervisor.history().at(-1)).toMatchObject({ outcome: 'escalated' });
  });

  it('does not execute the recommended action for an answer without an exact option id', async () => {
    const h = makeHarness(
      {
        async decide(): Promise<BrainDecision> {
          return { type: 'answer', text: 'Do not rebalance; wait for the current worker.' };
        },
      },
      { overloadPinnedThreshold: 2 },
    );
    h.state.subagents = [sub('busy', 'running'), sub('idle', 'idle')];
    h.state.pending = [task('head', 'busy'), task('tail', 'busy')];

    await h.supervisor.evaluate();

    expect(h.actions.retargetPendingTask).not.toHaveBeenCalled();
    expect(h.supervisor.history().at(-1)).toMatchObject({
      proposedAction: 'retarget',
      outcome: 'denied',
    });
  });

  it('cooldown suppresses re-engagement for the same worker; a task is never retargeted twice', async () => {
    const h = makeHarness(approveBrain(), { overloadPinnedThreshold: 2, cooldownMs: 120_000 });
    h.state.subagents = [sub('busy', 'running'), sub('idle', 'idle')];
    h.state.pending = [task('t-1', 'busy'), task('t-2', 'busy')];
    await h.supervisor.evaluate();
    expect(h.actions.retargetPendingTask).toHaveBeenCalledTimes(1);
    // Same state a tick later (still inside cooldown) → no second engagement.
    await h.supervisor.evaluate();
    expect(h.actions.retargetPendingTask).toHaveBeenCalledTimes(1);
    // After cooldown: only the already-moved task remains pinned — one
    // retarget per task lifetime means it is excluded from rebalancing
    // even though the overload/starvation rules would otherwise match it.
    h.state.pending = [task('t-2', 'busy')];
    h.clock.now += 121_000;
    await h.supervisor.evaluate();
    expect(h.actions.retargetPendingTask).toHaveBeenCalledTimes(1);
  });

  it('deep backlog for 2 sustained ticks → brain-approved spawnHelper', async () => {
    const h = makeHarness(approveBrain(), { backlogFactor: 2 });
    h.state.subagents = [sub('w1', 'running')];
    h.state.pending = [task('t-1'), task('t-2'), task('t-3')]; // 3 > 2×1
    await h.supervisor.evaluate(); // tick 1 — arm
    expect(h.actions.spawnHelper).not.toHaveBeenCalled();
    await h.supervisor.evaluate(); // tick 2 — fire
    expect(h.signals).toContain('backlog');
    expect(h.actions.spawnHelper).toHaveBeenCalledTimes(1);
    expect(h.actions.spawnHelper).toHaveBeenCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ id: 't-1' }) }),
    );
    expect(h.actions.notifyLeader).toHaveBeenCalledWith(
      'Fleet helper spawned',
      expect.stringContaining('helper-1'),
      'helper-1',
    );
  });

  it('spawnHelper budget error degrades to a leader notification', async () => {
    const h = makeHarness(approveBrain(), { backlogFactor: 2 });
    h.actions.spawnHelper.mockResolvedValue({ error: 'max_spawns reached' });
    h.state.subagents = [sub('w1', 'running')];
    h.state.pending = [task('t-1'), task('t-2'), task('t-3')];
    await h.supervisor.evaluate();
    await h.supervisor.evaluate();
    expect(h.actions.notifyLeader).toHaveBeenCalledWith(
      'Fleet backlog needs attention',
      expect.stringContaining('max_spawns reached'),
    );
    expect(h.supervisor.history().at(-1)).toMatchObject({ kind: 'backlog', outcome: 'error' });
  });

  it('allowSpawn:false never proposes a helper', async () => {
    const h = makeHarness(approveBrain(), { backlogFactor: 2, allowSpawn: false });
    h.state.subagents = [sub('w1', 'running')];
    h.state.pending = [task('t-1'), task('t-2'), task('t-3')];
    await h.supervisor.evaluate();
    await h.supervisor.evaluate();
    await h.supervisor.evaluate();
    expect(h.actions.spawnHelper).not.toHaveBeenCalled();
  });

  it('stuck agent (no observable activity past stuckMs) → steer + leader notification', async () => {
    const h = makeHarness(approveBrain(), { stuckMs: 180_000 });
    h.supervisor.start(); // arm listeners so fleet activity is tracked
    h.state.subagents = [sub('w1', 'running', 'some task')];
    // Record activity, then let it go stale.
    h.fleet.emit({
      subagentId: 'w1',
      ts: h.clock.now,
      type: 'tool.executed',
      payload: { name: 'bash', ok: true },
    });
    h.clock.now += 181_000;
    await h.supervisor.evaluate();
    expect(h.signals).toContain('stuck_agent');
    expect(h.actions.steerAgent).toHaveBeenCalledWith(
      'w1',
      expect.stringContaining('Progress check'),
      expect.stringContaining('stalled'),
    );
    expect(h.actions.notifyLeader).toHaveBeenCalled();
    h.supervisor.stop();
  });

  it('provider streaming activity prevents a false stuck-agent signal', async () => {
    const h = makeHarness(approveBrain(), { stuckMs: 180_000 });
    h.supervisor.start();
    h.state.subagents = [sub('w1', 'running', 'long reasoning task')];
    h.fleet.emit({
      subagentId: 'w1',
      ts: h.clock.now,
      type: 'tool.started',
      payload: { name: 'read' },
    });
    h.clock.now += 170_000;
    h.fleet.emit({
      subagentId: 'w1',
      ts: h.clock.now,
      type: 'provider.text_delta',
      payload: { text: 'still working' },
    });
    h.clock.now += 20_000;

    await h.supervisor.evaluate();

    expect(h.signals).not.toContain('stuck_agent');
    expect(h.actions.steerAgent).not.toHaveBeenCalled();
    h.supervisor.stop();
  });

  it('failure streak → steer by default; terminate only when allowTerminate', async () => {
    // Default: terminate NOT offered.
    const h = makeHarness(approveBrain(), { failureStreak: 2 });
    h.supervisor.start();
    h.state.subagents = [sub('w1', 'running')];
    for (let i = 0; i < 2; i++) {
      h.events.emit('subagent.task_completed', {
        subagentId: 'w1',
        taskId: `t-${i}`,
        status: 'failed',
        iterations: 1,
        toolCalls: 1,
        durationMs: 10,
      });
    }
    await h.supervisor.evaluate();
    expect(h.signals).toContain('failure_streak');
    expect(h.actions.steerAgent).toHaveBeenCalled();
    expect(h.actions.terminate).not.toHaveBeenCalled();
    h.supervisor.stop();

    // allowTerminate + a brain that picks terminate.
    const terminatingBrain: BrainArbiter = {
      async decide(req): Promise<BrainDecision> {
        const t = req.options?.find((o) => o.id === 'terminate');
        return { type: 'answer', optionId: t ? 'terminate' : 'steer', text: 'kill it' };
      },
    };
    const h2 = makeHarness(terminatingBrain, { failureStreak: 2, allowTerminate: true });
    h2.supervisor.start();
    h2.state.subagents = [sub('w1', 'running')];
    for (let i = 0; i < 2; i++) {
      h2.events.emit('subagent.task_completed', {
        subagentId: 'w1',
        taskId: `t-${i}`,
        status: 'timeout',
        iterations: 1,
        toolCalls: 1,
        durationMs: 10,
      });
    }
    await h2.supervisor.evaluate();
    expect(h2.actions.terminate).toHaveBeenCalledWith('w1');
    h2.supervisor.stop();
  });

  it('maxInterventionsPerSubagent caps engagements against one worker', async () => {
    const h = makeHarness(approveBrain(), {
      overloadPinnedThreshold: 2,
      cooldownMs: 1,
      maxInterventionsPerSubagent: 1,
    });
    h.state.subagents = [sub('busy', 'running'), sub('idle', 'idle')];
    h.state.pending = [task('t-1', 'busy'), task('t-2', 'busy')];
    await h.supervisor.evaluate();
    expect(h.actions.retargetPendingTask).toHaveBeenCalledTimes(1);
    // Fresh overload against the same worker after cooldown — budget spent.
    h.state.pending = [task('t-1', 'busy'), task('t-9', 'busy')];
    h.clock.now += 10;
    await h.supervisor.evaluate();
    expect(h.actions.retargetPendingTask).toHaveBeenCalledTimes(1);
  });

  it('collab subagents and their tasks are invisible to supervision', async () => {
    const h = makeHarness(approveBrain(), { overloadPinnedThreshold: 1, pinnedWaitMs: 0 });
    h.state.subagents = [sub('bug-hunter-1', 'running'), sub('idle', 'idle')];
    h.state.pending = [task('t-1', 'bug-hunter-1'), task('t-2', 'bug-hunter-1')];
    await h.supervisor.evaluate();
    expect(h.actions.retargetPendingTask).not.toHaveBeenCalled();
    expect(h.signals).toHaveLength(0);
  });

  it('goes dormant when the director declares work complete', async () => {
    const h = makeHarness(approveBrain(), { overloadPinnedThreshold: 2 });
    h.state.workComplete = true;
    h.state.subagents = [sub('busy', 'running'), sub('idle', 'idle')];
    h.state.pending = [task('t-1', 'busy'), task('t-2', 'busy')];
    await h.supervisor.evaluate();
    expect(h.actions.retargetPendingTask).not.toHaveBeenCalled();
    expect(h.signals).toHaveLength(0);
  });

  it('enabled:false kill switch — start() is a no-op', () => {
    const h = makeHarness(approveBrain(), { enabled: false });
    h.supervisor.start();
    expect(h.supervisor.isRunning()).toBe(false);
  });

  it('start/stop/start re-arms (for /supervisor on|off)', () => {
    const h = makeHarness(approveBrain(), {});
    h.supervisor.start();
    expect(h.supervisor.isRunning()).toBe(true);
    h.supervisor.stop();
    expect(h.supervisor.isRunning()).toBe(false);
    h.supervisor.start();
    expect(h.supervisor.isRunning()).toBe(true);
    h.supervisor.stop();
  });

  it('never touches budget negotiation events (non-interference)', async () => {
    const h = makeHarness(approveBrain(), {});
    h.supervisor.start();
    const extend = vi.fn();
    const deny = vi.fn();
    h.events.emit('budget.threshold_reached', {
      kind: 'iterations',
      used: 10,
      limit: 10,
      extend,
      deny,
      timeoutMs: 1000,
    } as never);
    await h.supervisor.evaluate();
    expect(extend).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
    h.supervisor.stop();
  });

  it('prunes per-subagent observation/rate-limit state on subagent.removed (no unbounded growth)', () => {
    // Regression (RAM-leak audit 2026-08-01): lastActivityAt / failStreaks /
    // interventionsBySubagent and the subagent-keyed lastEngagedAt entries were
    // never reclaimed when a worker was removed, so they grew one entry per
    // distinct retired subagent over a long leader session. forgetSubagent
    // (wired to subagent.removed in start()) prunes them. White-box access to
    // the private maps is intentional: this pins the reclaim itself.
    const h = makeHarness(approveBrain(), {});
    h.supervisor.start();
    const s = h.supervisor as unknown as {
      lastActivityAt: Map<string, number>;
      failStreaks: Map<string, number>;
      interventionsBySubagent: Map<string, number>;
      lastEngagedAt: Map<string, number>;
    };
    // Seed state for two workers as a long-running session would accumulate.
    s.lastActivityAt.set('w-1', 1);
    s.lastActivityAt.set('w-2', 2);
    s.failStreaks.set('w-1', 1);
    s.failStreaks.set('w-2', 1);
    s.interventionsBySubagent.set('w-1', 3);
    s.interventionsBySubagent.set('w-2', 1);
    // lastEngagedAt mixes subagent-keyed and task-keyed cooldown entries.
    s.lastEngagedAt.set('stuck|w-1', 1);
    s.lastEngagedAt.set('failure_streak|w-1', 1);
    s.lastEngagedAt.set('stuck|w-2', 1);
    s.lastEngagedAt.set('retarget|task-9', 1); // task-keyed: must survive

    h.events.emit('subagent.removed', { subagentId: 'w-1' } as never);

    expect(s.lastActivityAt.has('w-1')).toBe(false);
    expect(s.lastActivityAt.has('w-2')).toBe(true);
    expect(s.failStreaks.has('w-1')).toBe(false);
    expect(s.failStreaks.has('w-2')).toBe(true);
    expect(s.interventionsBySubagent.has('w-1')).toBe(false);
    expect(s.interventionsBySubagent.has('w-2')).toBe(true);
    // Subagent-keyed cooldowns for w-1 are gone; w-2 and task-keyed survive.
    expect(s.lastEngagedAt.has('stuck|w-1')).toBe(false);
    expect(s.lastEngagedAt.has('failure_streak|w-1')).toBe(false);
    expect(s.lastEngagedAt.has('stuck|w-2')).toBe(true);
    expect(s.lastEngagedAt.has('retarget|task-9')).toBe(true);
    h.supervisor.stop();
  });
});

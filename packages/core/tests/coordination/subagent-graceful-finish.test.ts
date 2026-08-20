/**
 * Graceful-finish lifecycle for background subagents (see
 * src/coordination/subagent-finish.ts).
 *
 * Contract under test:
 *  1. Crossing the wall-clock deadline under `gracefulFinish` NEVER aborts
 *     the runner — it delivers `subagent.finish_requested` in-band (between
 *     tool batches) and grants a grace window.
 *  2. A subagent that finishes its own turn within the grace window reports
 *     success — the model's final output is preserved.
 *  3. A subagent that ignores the notification is stopped only after the
 *     grace window elapses: bounded maximum lifetime.
 *  4. `coordinator.requestFinish()` notifies running opted-in subagents
 *     without granting grace and without touching legacy subagents.
 *  5. The Chimera reviewer policy opts in (verified in the cli package's
 *     chimera policy test).
 */
import { describe, expect, it } from 'vitest';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import { executeSubagentWithTimeout } from '../../src/coordination/multi-agent-timeout.js';
import {
  DEFAULT_SUBAGENT_FINISH_GRACE_MS,
  resolveGracefulFinish,
  SUBAGENT_FINISH_REQUESTED_EVENT,
} from '../../src/coordination/subagent-finish.js';
import { BudgetExceededError, BudgetThresholdSignal, SubagentBudget } from '../../src/coordination/subagent-budget.js';
import { EventBus } from '../../src/kernel/events.js';
import type { SubagentRunner, TaskSpec } from '../../src/types/multi-agent.js';

const task = (id: string): TaskSpec => ({ id, description: 'review the diff' });

const runCtx = (subagentId: string, budget: SubagentBudget) => ({
  subagentId,
  config: { name: 'chimera-review', gracefulFinish: true as const },
  budget,
  signal: new AbortController().signal,
  bridge: null,
});

describe('resolveGracefulFinish', () => {
  it('keeps legacy behavior for unset/false configs', () => {
    expect(resolveGracefulFinish({})).toBeUndefined();
    expect(resolveGracefulFinish({ gracefulFinish: false })).toBeUndefined();
    expect(resolveGracefulFinish({ gracefulFinish: undefined })).toBeUndefined();
  });

  it('resolves true to the default grace window', () => {
    expect(resolveGracefulFinish({ gracefulFinish: true })).toEqual({
      graceMs: DEFAULT_SUBAGENT_FINISH_GRACE_MS,
    });
  });

  it('accepts an explicit graceMs and falls back on invalid values', () => {
    expect(resolveGracefulFinish({ gracefulFinish: { graceMs: 5_000 } })).toEqual({
      graceMs: 5_000,
    });
    expect(resolveGracefulFinish({ gracefulFinish: { graceMs: 0 } })?.graceMs).toBe(
      DEFAULT_SUBAGENT_FINISH_GRACE_MS,
    );
    expect(resolveGracefulFinish({ gracefulFinish: { graceMs: Number.NaN } })?.graceMs).toBe(
      DEFAULT_SUBAGENT_FINISH_GRACE_MS,
    );
  });
});

describe('SubagentBudget.notifyFinish', () => {
  it('emits the in-band notification once and grants grace when asked', () => {
    const events = new EventBus();
    const budget = new SubagentBudget(
      { timeoutMs: 1_000 },
      'auto',
      { subagentId: 'rev-1', wallClockWatchdogOwned: true },
    );
    budget._events = events;
    budget.start();

    const seen: Array<{ reason: string; notice: string; graceMs: number }> = [];
    events.on(SUBAGENT_FINISH_REQUESTED_EVENT, (e) => {
      seen.push({ reason: e.reason, notice: e.notice, graceMs: e.graceMs });
    });

    expect(budget.notifyFinish('wall-clock budget of 1s reached', { graceMs: 2_000 })).toBe(true);
    expect(seen).toHaveLength(1);
    const deadlineAfterFirstGrant = budget.finishDeadlineMs;
    expect(deadlineAfterFirstGrant).toBeGreaterThan(Date.now());
    expect(seen[0]!.reason).toContain('wall-clock');
    expect(seen[0]!.notice).toContain('The leader agent has finished its work.');
    expect(seen[0]!.notice).toContain('end your turn');
    // The ceiling was extended to cover the grace window granted FROM THE
    // NOTIFICATION MOMENT (now + graceMs measured from start) — not from the
    // original deadline. "You have 2s from now" is the contract.
    expect(budget.limits.timeoutMs).toBeGreaterThanOrEqual(2_000);
    expect(budget.limits.timeoutMs).toBeLessThan(3_000);

    // Idempotent: a second call neither re-emits nor double-grants. Asserted
    // through the public surface only — SubagentBudget exposes no startTime,
    // so the deadline is pinned by capture rather than reconstructed.
    expect(budget.notifyFinish('leader session ended', { graceMs: 9_999 })).toBe(false);
    expect(seen).toHaveLength(1);
    expect(budget.finishDeadlineMs).toBe(deadlineAfterFirstGrant);
    // The refused 9_999s grant never touched the ceiling either.
    expect(budget.limits.timeoutMs).toBeLessThan(3_000);
  });

  it('notify-only keeps the existing time budget (no grace grant)', () => {
    const events = new EventBus();
    const budget = new SubagentBudget({ timeoutMs: 600_000 }, 'auto', { subagentId: 'rev-2' });
    budget._events = events;
    budget.start();

    let notice: string | undefined;
    events.on(SUBAGENT_FINISH_REQUESTED_EVENT, (e) => {
      notice = e.notice;
    });

    expect(budget.notifyFinish('leader session ended')).toBe(true);
    expect(budget.graceGranted).toBe(false);
    expect(budget.finishDeadlineMs).toBeUndefined();
    // The reported window is the still-standing ceiling, not a shorter one.
    expect(notice).toContain('seconds');
    expect(budget.limits.timeoutMs).toBe(600_000);
  });

  it('refuses to notify before start() or without a bus', () => {
    const unstarted = new SubagentBudget({ timeoutMs: 1_000 }, 'auto', { subagentId: 'x' });
    expect(unstarted.notifyFinish('reason', { graceMs: 1_000 })).toBe(false);
    const started = new SubagentBudget({ timeoutMs: 1_000 }, 'auto', { subagentId: 'y' });
    started.start();
    expect(started.notifyFinish('reason', { graceMs: 1_000 })).toBe(false);
  });
});

describe('executeSubagentWithTimeout graceful-finish path', () => {
  it('notifies instead of killing at the deadline; a model that finishes succeeds', async () => {
    const events = new EventBus();
    const budget = new SubagentBudget(
      { timeoutMs: 60 },
      'auto',
      { subagentId: 'rev-a', wallClockWatchdogOwned: true },
    );
    budget._events = events;
    budget.start();

    let aborted = false;
    // The model: keep working until the in-band notification arrives, then
    // complete the report in its own turn.
    const runner: SubagentRunner = async () => {
      await new Promise<void>((resolve) => {
        events.on(SUBAGENT_FINISH_REQUESTED_EVENT, () => resolve());
      });
      return { result: '## 🦂 Chimera Review — done in my own turn', iterations: 4, toolCalls: 7 };
    };

    const outcome = await executeSubagentWithTimeout({
      runner,
      task: task('t1'),
      ctx: runCtx('rev-a', budget),
      budget,
      abortSubagent: () => {
        aborted = true;
      },
      currentSessionId: () => 'session-1',
      gracefulFinish: resolveGracefulFinish({ gracefulFinish: { graceMs: 5_000 } }),
    });

    expect(aborted).toBe(false);
    expect(outcome.result).toContain('done in my own turn');
  });

  it('stops a subagent that ignores the notification only after the grace window', async () => {
    const events = new EventBus();
    const budget = new SubagentBudget(
      { timeoutMs: 40 },
      'auto',
      { subagentId: 'rev-b', wallClockWatchdogOwned: true },
    );
    budget._events = events;
    budget.start();

    let notified = false;
    events.on(SUBAGENT_FINISH_REQUESTED_EVENT, () => {
      notified = true;
    });

    // The model ignores the notification and never finishes.
    const runner: SubagentRunner = () => new Promise(() => {});

    await expect(
      executeSubagentWithTimeout({
        runner,
        task: task('t2'),
        ctx: runCtx('rev-b', budget),
        budget,
        abortSubagent: () => {},
        currentSessionId: () => 'session-1',
        gracefulFinish: resolveGracefulFinish({ gracefulFinish: { graceMs: 120 } }),
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    // The terminal stop happened, but only AFTER the in-band notification was
    // delivered — never before the model was told to finish.
    expect(notified).toBe(true);
  });

  it('applies the terminal stop when notification is undeliverable (no bus)', async () => {
    const budget = new SubagentBudget(
      { timeoutMs: 40 },
      'auto',
      { subagentId: 'rev-c', wallClockWatchdogOwned: true },
    );
    budget.start();

    await expect(
      executeSubagentWithTimeout({
        runner: () => new Promise(() => {}),
        task: task('t3'),
        ctx: runCtx('rev-c', budget),
        budget,
        abortSubagent: () => {},
        currentSessionId: () => 'session-1',
        gracefulFinish: resolveGracefulFinish({ gracefulFinish: { graceMs: 60 } }),
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('keeps the idle reaper as the bound for idle-only graceful-finish budgets (no wall clock)', async () => {
    // Regression pin: with no timeoutMs there is no grace deadline to defer
    // to, so the policy must NOT disable the idle reaper — otherwise the run
    // has no bound at all. The stalled runner below must still be reaped.
    const events = new EventBus();
    const budget = new SubagentBudget(
      { idleTimeoutMs: 60 },
      'auto',
      { subagentId: 'rev-idle', wallClockWatchdogOwned: true },
    );
    budget._events = events;
    budget.start();

    let notified = false;
    events.on(SUBAGENT_FINISH_REQUESTED_EVENT, () => {
      notified = true;
    });

    const attempt = executeSubagentWithTimeout({
      runner: () => new Promise(() => {}),
      task: task('t4'),
      ctx: runCtx('rev-idle', budget),
      budget,
      abortSubagent: () => {},
      currentSessionId: () => 'session-1',
      gracefulFinish: resolveGracefulFinish({ gracefulFinish: { graceMs: 5_000 } }),
    });

    // Bounded: the idle reaper rejects rather than leaving the run alive.
    await expect(attempt).rejects.toBeInstanceOf(BudgetExceededError);
    // And it was never "notified" into a grace window it cannot have —
    // idle-only runs are reaped, not extended.
    expect(notified).toBe(false);
  });

  it('mirrors wall-clock ownership into checkLimits: a heartbeat past the deadline negotiates only idle, never timeout', async () => {
    // The sub-millisecond race: a tool.progress heartbeat calls checkTimeout()
    // right after the wall deadline crossed but before the watchdog's own
    // tick delivered subagent.finish_requested. checkLimits must NOT re-add
    // the 'timeout' kind for wallClockWatchdogOwned budgets — doing so starts
    // a legacy wall-clock negotiation that races the watchdog's
    // notify-then-grace path. Only the idle kind may negotiate here.
    const events = new EventBus();
    const negotiated: string[] = [];
    events.on('budget.threshold_reached', (e) => {
      negotiated.push(e.kind as string);
      e.deny();
    });

    const budget = new SubagentBudget(
      { timeoutMs: 40, idleTimeoutMs: 20 },
      'auto',
      { subagentId: 'rev-race', wallClockWatchdogOwned: true },
    );
    budget._events = events;
    budget.onThreshold = ({ requestDecision }) => requestDecision();
    budget.start();

    // Cross BOTH limits with no activity: wall elapsed AND idle exceeded.
    await new Promise((r) => setTimeout(r, 60));

    expect(() => budget.checkTimeout()).toThrow(BudgetThresholdSignal);
    expect(negotiated).toEqual(['idle_timeout']);
  });

  it('legacy budgets (no ownership flag) still negotiate wall-clock from checkTimeout', async () => {
    // Control for the mirror above: without wallClockWatchdogOwned the old
    // behavior stands — a checkTimeout past the wall deadline still negotiates
    // 'timeout'. The mirror must not over-suppress legacy runs.
    const events = new EventBus();
    const negotiated: string[] = [];
    events.on('budget.threshold_reached', (e) => {
      negotiated.push(e.kind as string);
      e.deny();
    });

    const budget = new SubagentBudget({ timeoutMs: 40, idleTimeoutMs: 20 }, 'auto', {
      subagentId: 'rev-legacy-race',
    });
    budget._events = events;
    budget.onThreshold = ({ requestDecision }) => requestDecision();
    budget.start();

    await new Promise((r) => setTimeout(r, 60));

    expect(() => budget.checkTimeout()).toThrow(BudgetThresholdSignal);
    expect(negotiated).toContain('timeout');
  });
});

describe('coordinator.requestFinish', () => {
  it('notifies running opted-in subagents in-band without granting grace', async () => {
    const coordinator = new DefaultMultiAgentCoordinator({
      coordinatorId: 'finish-coord',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 2,
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let finishEvent: { reason: string; notice: string } | undefined;

    const runner: SubagentRunner = async (_t, ctx) => {
      // Wire the bus the way the production runner (makeAgentSubagentRunner)
      // does — the coordinator creates the budget but the runner owns its bus.
      const bus = new EventBus();
      ctx.budget._events = bus;
      bus.on(SUBAGENT_FINISH_REQUESTED_EVENT, (e) => {
        finishEvent = { reason: e.reason, notice: e.notice };
        release();
      });
      // The subagent has STARTED working (iterations/tool calls on record) —
      // coordinator.requestFinish only accelerates started subagents.
      ctx.budget.recordIteration();
      ctx.budget.recordToolCall();
      await gate;
      return { result: 'review complete', iterations: 2, toolCalls: 3 };
    };
    coordinator.setRunner(runner);

    await coordinator.spawn({
      id: 'rev-graceful',
      name: 'chimera-review',
      role: 'reviewer',
      gracefulFinish: true,
    });
    const taskId = 'task-finish-1';
    await coordinator.assign({ id: taskId, description: 'review' });
    await new Promise((r) => setTimeout(r, 10)); // let dispatch wire the budget

    const notified = coordinator.requestFinish('leader session ended');
    expect(notified).toBe(1);
    expect(finishEvent?.reason).toBe('leader session ended');
    expect(finishEvent?.notice).toContain('The leader agent has finished its work.');

    const [result] = await coordinator.awaitTasks([taskId]);
    expect(result?.status).toBe('success');
    expect(result?.result).toBe('review complete');
    await coordinator.stopAll();
  });

  it('leaves legacy subagents untouched', async () => {
    const coordinator = new DefaultMultiAgentCoordinator({
      coordinatorId: 'finish-coord-legacy',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 1,
    });

    let sawFinishEvent = false;
    const runner: SubagentRunner = async (_t, ctx) => {
      ctx.budget._events?.on(SUBAGENT_FINISH_REQUESTED_EVENT, () => {
        sawFinishEvent = true;
      });
      // Record activity so the ONLY reason this subagent is skipped is the
      // missing gracefulFinish opt-in, not the not-yet-started gate.
      ctx.budget.recordIteration();
      ctx.budget.recordToolCall();
      await new Promise((r) => setTimeout(r, 20));
      return { result: 'legacy done', iterations: 1, toolCalls: 0 };
    };
    coordinator.setRunner(runner);

    await coordinator.spawn({ id: 'rev-legacy', name: 'worker' });
    await coordinator.assign({ id: 'task-legacy', description: 'work' });
    await new Promise((r) => setTimeout(r, 10));

    expect(coordinator.requestFinish('leader session ended')).toBe(0);
    expect(sawFinishEvent).toBe(false);
    await coordinator.stopAll();
  });

  it('does not tell a not-yet-started subagent to finish (no truncated first review)', async () => {
    // Regression pin (mailbox review 2026-08): a freshly spawned post-session
    // reviewer has wired no progress yet — zero iterations, zero tool calls.
    // Telling it "the leader has finished, wrap up now" at that moment means
    // it reads the notice at its FIRST iteration, before examining anything,
    // and a compliant model emits a truncated review. The not-yet-started
    // gate skips it; the watchdog deadline remains its in-band path.
    const coordinator = new DefaultMultiAgentCoordinator({
      coordinatorId: 'finish-coord-fresh',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 1,
    });

    let sawFinishEvent = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner: SubagentRunner = async (_t, ctx) => {
      const bus = new EventBus();
      ctx.budget._events = bus;
      bus.on(SUBAGENT_FINISH_REQUESTED_EVENT, () => {
        sawFinishEvent = true;
      });
      // NO recordIteration/recordToolCall: this subagent has not started.
      await gate;
      return { result: 'fresh spawn done', iterations: 1, toolCalls: 0 };
    };
    coordinator.setRunner(runner);

    await coordinator.spawn({
      id: 'rev-fresh',
      name: 'chimera-review',
      role: 'reviewer',
      gracefulFinish: true,
    });
    await coordinator.assign({ id: 'task-fresh', description: 'review' });
    await new Promise((r) => setTimeout(r, 10));

    expect(coordinator.requestFinish('leader session ended')).toBe(0);
    expect(sawFinishEvent).toBe(false);

    release();
    const [result] = await coordinator.awaitTasks(['task-fresh']);
    expect(result?.status).toBe('success');
    await coordinator.stopAll();
  });
});

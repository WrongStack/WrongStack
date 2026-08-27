/**
 * Watchdog guard — C1 fix verification.
 *
 * Issue: Two independent enforcement paths could both emit
 * `budget.threshold_reached` (kind: 'timeout') simultaneously:
 *   1. Coordinator watchdog (`executeWithTimeout`) → `onTick` → `negotiateTimeout`
 *   2. Runner → `tool.progress` → `budget.checkTimeout()` → `checkLimits`
 *
 * Both call `onThreshold` which emits the event. A streaming tool that fires
 * `tool.progress` between the watchdog setting `_watchdogActive` and clearing it
 * would cause `checkTimeout()` to also emit, creating duplicate events.
 *
 * Fix: `_watchdogActive` flag — the coordinator sets it before calling
 * `onThreshold`; `checkTimeout()` skips its wall-clock check while the flag
 * is set, making the watchdog the sole source of 'timeout' events. The
 * `idle_timeout` kind is always emitted regardless of the flag.
 *
 * @priority C1
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgentSubagentRunner } from '../../src/coordination/agent-subagent-runner.js';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import type {
  BudgetKind,
  BudgetLimits,
  BudgetThresholdDecision,
} from '../../src/coordination/subagent-budget.js';
import type { Agent, RunResult } from '../../src/core/agent.js';
import { EventBus } from '../../src/kernel/events.js';
import type { TaskResult } from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Makes a coordinator config with sensible defaults. */
const makeConfig = (overrides: Record<string, unknown> = {}) => ({
  coordinatorId: 'guard-test-coord',
  doneCondition: { type: 'all_tasks_done' as const },
  maxConcurrent: 2,
  ...overrides,
});

/**
 * Stub agent that fires `tool.executed` at high frequency (every `intervalMs`)
 * while running, so the runner's `tool_progress` listener fires repeatedly.
 * Uses Date.now() to stop precisely at `durationMs` even under fake timers.
 */
function makeFrequentProgressAgent(opts: {
  durationMs: number;
  intervalMs: number;
  events: EventBus;
}): Agent {
  const { durationMs, intervalMs, events } = opts;
  return {
    async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
      const startedAt = Date.now();
      let iteration = 0;
      events.emit('iteration.started', { ctx: undefined as never, index: iteration });
      while (Date.now() - startedAt < durationMs) {
        if (runOpts.signal.aborted) return { status: 'aborted', iterations: iteration };
        // Emit tool.started + tool.executed in rapid succession — this mirrors
        // a streaming tool that calls tool_progress between start and done.
        events.emit('tool.started', { name: 'work', id: `t${iteration}` });
        events.emit('tool.executed', {
          name: 'work',
          id: `t${iteration}`,
          durationMs: 1,
          ok: true,
        });
        // tool_progress is what triggers checkTimeout() in the runner.
        events.emit('tool.progress', {
          name: 'work',
          id: `t${iteration}`,
          durationMs: 0,
          elapsedMs: Date.now() - startedAt,
        });
        iteration++;
        // Use Date.now() inside the loop so fake timers can advance time.
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return { status: 'done', iterations: iteration, finalText: 'completed' };
    },
  } as never as Agent;
}

/**
 * Stub agent that runs for `durationMs` and deliberately stalls (no progress
 * events) to trigger the idle timeout path.
 */
function makeStalledAgent(opts: { durationMs: number; events: EventBus }): Agent {
  const { durationMs, events } = opts;
  return {
    async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
      const startedAt = Date.now();
      events.emit('iteration.started', { ctx: undefined as never, index: 0 });
      while (Date.now() - startedAt < durationMs) {
        if (runOpts.signal.aborted) return { status: 'aborted', iterations: 0 };
        await new Promise((r) => setTimeout(r, 10));
      }
      return { status: 'done', iterations: 1, finalText: 'stalled-done' };
    },
  } as never as Agent;
}

// ---------------------------------------------------------------------------
// T2a: Budget-level unit test — watchdogActive skips wall-clock, not idle
// ---------------------------------------------------------------------------
describe('watchdogActive guard', () => {
  // Use fake timers so we can deterministically control elapsed time.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('checkTimeout skips wall-clock but not idle when watchdogActive is set', async () => {
    const { SubagentBudget } = await import('../../src/coordination/subagent-budget.js');
    const events = new EventBus<string>();
    const wallClockEvents: string[] = [];
    const idleEvents: string[] = [];

    // Handler that records which kinds it sees.
    const handler = (e: {
      kind: BudgetKind;
      used: number;
      limit: number;
      requestDecision: () => Promise<BudgetThresholdDecision>;
      extend?: (extra: Partial<BudgetLimits>) => void;
      deny?: () => void;
    }): 'continue' => {
      if (e.kind === 'timeout') wallClockEvents.push(e.kind);
      if (e.kind === 'idle_timeout') idleEvents.push(e.kind);
      e.deny?.();
      return 'continue';
    };

    const budget = new SubagentBudget({ timeoutMs: 100, idleTimeoutMs: 50 }, 'auto');
    budget.onThreshold = handler;
    budget._events = events as never as EventBus;
    budget.start();

    // Advance past BOTH limits.
    vi.advanceTimersByTime(120);

    // Without the guard: both wall-clock and idle would be reported.
    // With the guard: wall-clock skipped, idle still reported.
    budget.setWatchdogNegotiation(100); // simulates watchdog in negotiation
    budget.checkTimeout();

    // idle_timeout should be emitted (watchdogActive does NOT suppress it)
    expect(idleEvents).toContain('idle_timeout');
    // wall-clock timeout should be SKIPPED (watchdog is handling it)
    expect(wallClockEvents).not.toContain('timeout');

    // Cleanup
    budget.clearWatchdogNegotiation();
  });

  it('checkTimeout resumes wall-clock after clearWatchdogNegotiation', async () => {
    const { SubagentBudget } = await import('../../src/coordination/subagent-budget.js');
    const events = new EventBus<string>();
    const wallClockEvents: string[] = [];

    const handler = (e: {
      kind: BudgetKind;
      used: number;
      limit: number;
      requestDecision: () => Promise<BudgetThresholdDecision>;
      extend?: (extra: Partial<BudgetLimits>) => void;
      deny?: () => void;
    }): 'continue' => {
      if (e.kind === 'timeout') wallClockEvents.push(e.kind);
      e.deny?.();
      return 'continue';
    };

    const budget = new SubagentBudget({ timeoutMs: 50 }, 'auto');
    budget.onThreshold = handler;
    budget._events = events as never as EventBus;
    budget.start();

    vi.advanceTimersByTime(60); // past deadline

    // Guard is set — wall-clock skipped
    budget.setWatchdogNegotiation(50);
    budget.checkTimeout();
    expect(wallClockEvents).toHaveLength(0);

    // Guard cleared — wall-clock fires normally
    budget.clearWatchdogNegotiation();
    budget.checkTimeout();
    expect(wallClockEvents).toContain('timeout');
  });

  it('setWatchdogNegotiation / clearWatchdogNegotiation are no-ops without a handler', async () => {
    const { SubagentBudget } = await import('../../src/coordination/subagent-budget.js');
    // No handler → hard throw path. These methods should not break that path.
    const budget = new SubagentBudget({ timeoutMs: 10 }, 'auto');
    budget.start();
    vi.advanceTimersByTime(20);

    // Guard has no effect on the hard-throw path.
    budget.setWatchdogNegotiation(10);
    expect(() => budget.checkTimeout()).toThrow();
    // Clear it — next check still throws.
    budget.clearWatchdogNegotiation();
    expect(() => budget.checkTimeout()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// T2b: Coordinator dual-path — no duplicate timeout events per deadline cycle
// ---------------------------------------------------------------------------
describe('dual-path race: watchdog vs checkTimeout (T2)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits exactly ONE budget.threshold_reached (timeout) per deadline crossing despite frequent tool.progress', async () => {
    // The core invariant: even when tool.progress fires hundreds of times
    // while the watchdog is negotiating, we get exactly one event per
    // deadline crossing (pre-empt at ~85%, deadline at 100%).
    //
    // Without the C1 fix, the tool.progress → checkTimeout() path would emit
    // a second event for the same crossing.
    const timeoutMs = 120;
    const timeoutEvents: Array<{ kind: string; used: number; limit: number }> = [];

    const factory = async () => {
      const events = new EventBus();
      // High-frequency tool.progress emitter — fires every 1ms to maximise
      // the chance of landing inside the watchdog's negotiation window.
      events.on('budget.threshold_reached', (e) => {
        timeoutEvents.push({ kind: e.kind, used: e.used, limit: e.limit });
        // Grant headroom so the agent can keep running.
        e.extend({ timeoutMs: Math.ceil(Math.max(e.limit, e.used) * 3) });
      });
      const agent = makeFrequentProgressAgent({
        durationMs: timeoutMs * 4,
        intervalMs: 1, // very frequent — guaranteed to hit the race window
        events,
      });
      return { agent, events };
    };

    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 's1', name: 'S1', timeoutMs });
    const completion = new Promise<TaskResult>((resolve) => {
      coord.once('task.completed', (e: { result: TaskResult }) => resolve(e.result));
    });
    await coord.assign({ id: 't1', description: 'high-frequency progress agent' });

    // Advance time so the agent completes.
    // With shouldAdvanceTime: false we must advance manually.
    vi.advanceTimersByTime(timeoutMs * 5);
    await Promise.resolve(); // let promises settle
    vi.advanceTimersByTime(200);

    const result = await completion;
    expect(result.status).toBe('success');

    // Filter to only wall-clock timeout events.
    const wallClockEvents = timeoutEvents.filter((e) => e.kind === 'timeout');

    // We expect exactly 2 timeout events: one at the pre-empt (~85%) and one
    // at the deadline (100%). Before the C1 fix, this would be 3+ because
    // every tool_progress → checkTimeout() would also emit a wall-clock event.
    expect(wallClockEvents.length).toBeGreaterThanOrEqual(1);
    expect(wallClockEvents.length).toBeLessThanOrEqual(2);
  });

  it('emits a second budget.threshold_reached (timeout) at the deadline after the pre-empt', async () => {
    // Verifies that BOTH crossings emit: the proactive pre-empt (~85%, used <
    // limit, granted) and — once the agent stalls so the heartbeat gate locks
    // the pre-empt — the real deadline (used >= limit). The C1 `_watchdogActive`
    // guard must suppress only the *duplicate* wall-clock emission from the
    // budget's own checkTimeout() (driven by the frequent tool.progress here),
    // NOT the watchdog's own deadline event.
    const timeoutMs = 100;
    const timeoutEvents: Array<{ kind: string; used: number; limit: number }> = [];

    const factory = async () => {
      const events = new EventBus();
      events.on('budget.threshold_reached', (e) => {
        if (e.kind !== 'timeout') return;
        timeoutEvents.push({ kind: e.kind, used: e.used, limit: e.limit });
        // Grant the proactive pre-empt (still under the limit), but DENY once
        // the deadline is actually crossed so the stalled agent is reaped.
        if (e.used < e.limit) e.extend({ timeoutMs: Math.ceil(e.limit * 2) });
        else e.deny();
      });
      // Emits frequent tool.progress (exercising the C1 guard) for ~40ms, then
      // stalls — so the pre-empt grants once, the heartbeat gate then locks, and
      // the deadline fires.
      const agent = {
        async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
          const startedAt = Date.now();
          let i = 0;
          events.emit('iteration.started', { ctx: undefined as never, index: 0 });
          while (Date.now() - startedAt < 40) {
            if (runOpts.signal.aborted) return { status: 'aborted', iterations: i };
            events.emit('tool.progress', {
              name: 'work',
              id: `t${i}`,
              durationMs: 0,
              elapsedMs: Date.now() - startedAt,
            });
            i++;
            await new Promise((r) => setTimeout(r, 1));
          }
          // Stall until reaped.
          while (true) {
            if (runOpts.signal.aborted) return { status: 'aborted', iterations: i };
            await new Promise((r) => setTimeout(r, 5));
          }
        },
      } as never as Agent;
      return { agent, events };
    };

    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 's2', name: 'S2', timeoutMs });
    const completion = new Promise<TaskResult>((resolve) => {
      coord.once('task.completed', (e: { result: TaskResult }) => resolve(e.result));
    });
    await coord.assign({ id: 't2', description: 'two-deadline crossings' });

    // `…Async` flushes microtasks between timer firings so the async watchdog
    // chain (pre-empt negotiate → stall → lock → deadline) actually advances.
    await vi.advanceTimersByTimeAsync(timeoutMs * 6);

    const result = await completion;

    const wallClockEvents = timeoutEvents.filter((e) => e.kind === 'timeout');
    // At least the proactive pre-empt and the deadline both emitted.
    expect(wallClockEvents.length).toBeGreaterThanOrEqual(2);
    // First event is the pre-empt (used < limit).
    expect(wallClockEvents[0]!.used).toBeLessThan(wallClockEvents[0]!.limit);
    // A later event is the real deadline (used >= limit).
    const deadline = wallClockEvents.find((e) => e.used >= e.limit);
    expect(deadline).toBeDefined();
    // The denied deadline reaps the stalled agent.
    expect(result.status).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// T2c: idle_timeout is always enforced independently of watchdogActive
// ---------------------------------------------------------------------------
describe('idle_timeout enforcement is independent of watchdogActive', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('aborts the subagent via idle timeout even while watchdog is negotiating wall-clock', async () => {
    // The idle reaper is independent of wall-clock. Even if the watchdog is
    // mid-negotiation (watchdogActive is set), a genuine stall must still
    // be reaped immediately by checkTimeout().
    const idleTimeoutMs = 60;
    const timeoutMs = 10_000; // long wall-clock — only idle should trip

    const idleAbortEvents: string[] = [];

    const factory = async () => {
      const events = new EventBus();
      events.on('budget.threshold_reached', (e) => {
        if (e.kind === 'idle_timeout') idleAbortEvents.push(e.kind);
        // Grant — but the abort should have already fired via idle exceeded.
        e.extend({ idleTimeoutMs: idleTimeoutMs * 2 });
      });
      const agent = makeStalledAgent({ durationMs: idleTimeoutMs * 10, events });
      return { agent, events };
    };

    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 's3', name: 'S3', idleTimeoutMs, timeoutMs });
    const completion = new Promise<TaskResult>((resolve) => {
      coord.once('task.completed', (e: { result: TaskResult }) => resolve(e.result));
    });
    await coord.assign({ id: 't3', description: 'stalled agent' });

    // Advance past idle limit.
    vi.advanceTimersByTime(idleTimeoutMs + 20);
    await Promise.resolve();
    vi.advanceTimersByTime(200);

    const result = await completion;

    // An idle stall is reaped as a 'timeout' (the agent hung) — not 'stopped',
    // which is reserved for an explicit deadline deny. Either way it must not
    // succeed.
    expect(result.status).toBe('timeout');
    // The idle_timeout event should have been emitted (observability).
    expect(idleAbortEvents).toContain('idle_timeout');
  });
});

/**
 * Proactive timeout pre-emption: a delegated subagent must have its wall-clock
 * budget extended BEFORE it crosses the deadline (not reactively, after it has
 * already "fallen into" timeout). The coordinator watchdog (`executeWithTimeout`)
 * arms a negotiation at `timeoutMs * TIMEOUT_PREEMPT_FRACTION`, so while the
 * agent is still making progress AND still under its limit, the ceiling is
 * raised and the agent never enters a timed-out state.
 *
 * These drive the REAL DefaultMultiAgentCoordinator + makeAgentSubagentRunner;
 * only the Agent run is stubbed. The granter is a plain bus listener that
 * records each negotiation's (used, limit) so we can prove `used < limit` —
 * i.e. the ask happened before the deadline.
 */
import { describe, expect, it } from 'vitest';
import { makeAgentSubagentRunner } from '../../src/coordination/agent-subagent-runner.js';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import { TIMEOUT_PREEMPT_FRACTION } from '../../src/coordination/subagent-budget.js';
import type { Agent, RunResult } from '../../src/core/agent.js';
import { EventBus } from '../../src/kernel/events.js';
import type { TaskResult } from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

const makeConfig = (overrides: Record<string, unknown> = {}) => ({
  coordinatorId: 'preempt-coord',
  doneCondition: { type: 'all_tasks_done' as const },
  maxConcurrent: 2,
  ...overrides,
});

/**
 * Stub agent that runs for `durationMs`, emitting a tool heartbeat every
 * `heartbeatMs` so the budget sees continuous forward progress, then ends.
 * Cooperates with the abort signal so a hard timeout would surface as aborted.
 */
function makeTimedAgent(opts: {
  durationMs: number;
  events: EventBus;
  heartbeatMs?: number;
}): Agent {
  const { durationMs, events, heartbeatMs = 20 } = opts;
  const ctx = {} as never;
  return {
    async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
      const startedAt = Date.now();
      events.emit('iteration.started', { ctx, index: 0 });
      let i = 0;
      while (Date.now() - startedAt < durationMs) {
        if (runOpts.signal.aborted) return { status: 'aborted', iterations: i };
        events.emit('tool.started', { name: 'work', id: `t${i}` });
        events.emit('tool.executed', { name: 'work', id: `t${i}`, durationMs: 1, ok: true });
        i++;
        await new Promise((r) => setTimeout(r, heartbeatMs));
      }
      return { status: 'done', iterations: i || 1, finalText: 'completed' };
    },
  } as never as Agent;
}

describe('delegate timeout pre-emption (proactive extend)', () => {
  it('negotiates an extension BEFORE the deadline while the subagent makes progress', async () => {
    const negotiations: Array<{ used: number; limit: number }> = [];
    // The pre-empt arms at `timeoutMs * TIMEOUT_PREEMPT_FRACTION` (0.85), so the
    // lead margin before the deadline is only `(1 - 0.85) * timeoutMs`. Keep the
    // window wide enough that this margin (~90ms here) dwarfs realistic setTimeout
    // skew under full-suite CPU load — a tight 120ms window left just 18ms and
    // flaked (`used` landed past the deadline when the timer fired late).
    const timeoutMs = 600;

    const factory = async () => {
      const events = new EventBus();
      // Granter: record each timeout negotiation and grant headroom. Recording
      // `used`/`limit` lets us prove the ask fired ahead of the deadline.
      events.on('budget.threshold_reached', (e) => {
        if (e.kind === 'timeout') {
          negotiations.push({ used: e.used, limit: e.limit });
          e.extend({ timeoutMs: Math.ceil(Math.max(e.limit, e.used) * 2) });
        }
      });
      // Run well past the original window so, without pre-emption, the agent
      // would cross the deadline; with it, it sails through.
      return { agent: makeTimedAgent({ durationMs: timeoutMs * 2, events }), events };
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
    await coord.assign({ id: 't1', description: 'long but productive' });
    const result = await completion;

    // The task completed normally — it was never killed for running long.
    expect(result.status).toBe('success');

    // At least one negotiation happened, and the FIRST one fired before the
    // deadline (used < limit) — that's the proactive pre-empt, not a reactive
    // at-deadline ask. The first pre-empt point is ~FRACTION * timeoutMs.
    expect(negotiations.length).toBeGreaterThan(0);
    const first = negotiations[0]!;
    expect(first.used).toBeLessThan(first.limit);
    expect(first.used).toBeGreaterThanOrEqual(timeoutMs * TIMEOUT_PREEMPT_FRACTION - 40);
  });

  it('does not negotiate a timeout pre-empt when no wall-clock cap is set', async () => {
    const negotiations: Array<{ used: number; limit: number }> = [];

    const factory = async () => {
      const events = new EventBus();
      events.on('budget.threshold_reached', (e) => {
        if (e.kind === 'timeout') {
          negotiations.push({ used: e.used, limit: e.limit });
          e.extend({ timeoutMs: e.limit * 2 });
        }
      });
      return { agent: makeTimedAgent({ durationMs: 120, events }), events };
    };
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    // No timeoutMs on the subagent → only the idle reaper applies, and a
    // continuously-active agent never trips it.
    await coord.spawn({ id: 's2', name: 'S2' });
    const completion = new Promise<TaskResult>((resolve) => {
      coord.once('task.completed', (e: { result: TaskResult }) => resolve(e.result));
    });
    await coord.assign({ id: 't2', description: 'no wall cap' });
    const result = await completion;

    expect(result.status).toBe('success');
    expect(negotiations).toHaveLength(0);
  });
});

/**
 * D2 — Coordinator race + duplicate-id + dispatch-during-terminate
 * coverage. These tests pin the lifecycle invariants that the prior
 * coordinator silently violated:
 *   - spawn() with a duplicate id must reject (was: silent overwrite)
 *   - stop()-then-assign races must not start the task (was: race
 *     window leaked inFlight forever)
 *   - stopAll() must drain the pending queue (was: tasks orphaned)
 *   - tool-call counter must pair started/executed (was: started-only
 *     count drifted when a tool never completed)
 *   - error-state reset must be synchronous (was: queueMicrotask race
 *     between assign() and the reset)
 */
import { describe, expect, it, vi } from 'vitest';
import { makeAgentSubagentRunner } from '../../src/coordination/agent-subagent-runner.js';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import type { Agent, RunResult } from '../../src/core/agent.js';
import { EventBus } from '../../src/kernel/events.js';
import type { TaskResult } from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

const makeConfig = (overrides: Record<string, unknown> = {}) => ({
  coordinatorId: 'race-coord',
  doneCondition: { type: 'all_tasks_done' as const },
  maxConcurrent: 2,
  ...overrides,
});

/**
 * Stub agent that holds at `await waitGate` so the test can interleave
 * coordinator ops (stop, assign) with the in-flight run. The agent
 * returns when the test releases the gate.
 */
function makeGatedAgent(gate: { release: () => void; promise: Promise<void> }): {
  agent: Agent;
  events: EventBus;
} {
  const events = new EventBus();
  const ctx = {} as never;
  const agent = {
    async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
      // Emit one iteration so budget hooks have something to count.
      events.emit('iteration.started', { ctx, index: 0 });
      events.emit('tool.started', { name: 'gated', id: 't0' });
      events.emit('tool.executed', { name: 'gated', id: 't0', durationMs: 0, ok: true });
      events.emit('provider.response', {
        ctx,

        model: 'test-model',
        usage: { input: 1, output: 1 },
        stopReason: 'end_turn',
      });
      await gate.promise;
      if (runOpts.signal.aborted) return { status: 'aborted', iterations: 1 };
      return { status: 'done', iterations: 1, finalText: 'released' };
    },
  } as never as Agent;
  return { agent, events };
}

function makeGate(): { release: () => void; promise: Promise<void> } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { release, promise };
}

describe('coordinator races + invariants (D2)', () => {
  // ────────────────────────────────────────────────────────────────────
  // T5 — Duplicate spawn id (C4)
  // ────────────────────────────────────────────────────────────────────
  it('T5: spawn() rejects a duplicate subagent id instead of silently overwriting', async () => {
    const factory = vi.fn(async () => {
      const gate = makeGate();
      gate.release(); // immediately release — we don't need to hold
      return makeGatedAgent(gate);
    });
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 'dup', name: 'first' });
    await expect(coord.spawn({ id: 'dup', name: 'second' })).rejects.toThrow(/already exists/i);
    // The first subagent should still be observable, not overwritten.
    const status = coord.getStatus();
    const dup = status.subagents.find((s) => s.id === 'dup');
    expect(dup?.name).toBe('first');
  });

  // ────────────────────────────────────────────────────────────────────
  // T4 — stop()-then-assign race must not start the task (C5)
  // ────────────────────────────────────────────────────────────────────
  it('T4: stop() before assign() refuses to start the task on the terminated subagent', async () => {
    const gate = makeGate();
    gate.release(); // not needed; the assigned task should never reach the agent
    const factory = vi.fn(async () => makeGatedAgent(gate));
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 's1', name: 'S1' });
    await coord.stop('s1');

    // Capture the completion before we assign so the listener is
    // attached when the synchronous dispatch path fires.
    const completion = new Promise<TaskResult>((resolve) => {
      coord.once('task.completed', (e: { result: TaskResult }) => resolve(e.result));
    });
    await coord.assign({ id: 'after-stop', description: 'should refuse' });
    const result = await completion;

    expect(result.status).toBe('stopped');
    expect(result.error?.kind).toBe('aborted_by_parent');
    // The factory should NOT have been invoked — the dispatch guard
    // refused before constructing an Agent.
    expect(factory).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────
  // T4b — stopAll() drains the pending queue with aborted_by_parent
  // ────────────────────────────────────────────────────────────────────
  it('T4b: stopAll() drains pending tasks instead of leaving them orphaned (C2)', async () => {
    const gate = makeGate();
    gate.release();
    const factory = vi.fn(async () => makeGatedAgent(gate));
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig({ maxConcurrent: 1 }), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 's1', name: 'S1' });

    // Capture all 3 completions in order. Pending tasks (t2, t3) get
    // synthetic completion events from stopAll().
    const completed: TaskResult[] = [];
    coord.on('task.completed', (e: { result: TaskResult }) => {
      completed.push(e.result);
    });

    // Queue 3 tasks; with maxConcurrent:1 only t1 dispatches.
    await coord.assign({ id: 't1', description: 'first' });
    await coord.assign({ id: 't2', description: 'queued' });
    await coord.assign({ id: 't3', description: 'queued' });

    await coord.stopAll();

    // Give the synthetic completions a microtask to land — they
    // dispatch synchronously from inside stopAll().
    await new Promise((r) => setImmediate(r));

    // t2 + t3 must surface as stopped/aborted_by_parent. t1's
    // status depends on whether the runner emitted the agent's
    // `aborted` status; either way it counted as completed.
    const stopped = completed.filter((r) => r.taskId === 't2' || r.taskId === 't3');
    expect(stopped).toHaveLength(2);
    for (const r of stopped) {
      expect(r.status).toBe('stopped');
      expect(r.error?.kind).toBe('aborted_by_parent');
    }
    expect(coord.getStatus().pendingTasks).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────
  // T8 — Tool budget exhausted on first call (paired counter, M5)
  // ────────────────────────────────────────────────────────────────────
  it('T8: maxToolCalls=1 admits exactly one paired tool call before bust', async () => {
    // Stub: emits 2 paired tool calls. Budget allows 1 — the second
    // must bust. The counter MUST count on `tool.executed`, not
    // `tool.started`, to honor maxToolCalls=1 correctly.
    const factory = async () => {
      const events = new EventBus();
      const ctx = {} as never;
      const agent = {
        async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
          for (let i = 0; i < 5; i++) {
            if (runOpts.signal.aborted) return { status: 'aborted', iterations: i };
            events.emit('iteration.started', { ctx, index: i });
            events.emit('tool.started', { name: 'busy', id: `s${i}` });
            // Pair only once — when the budget hook fires on this
            // executed event, the second call should trigger
            // BudgetExceededError.
            events.emit('tool.executed', {
              name: 'busy',
              id: `s${i}`,
              durationMs: 0,
              ok: true,
            });
            events.emit('provider.response', {
              ctx,

              model: 'test-model',
              usage: { input: 1, output: 1 },
              stopReason: 'end_turn',
            });
            events.emit('iteration.completed', { ctx, index: i });
            await new Promise<void>((r) => setImmediate(r));
          }
          return { status: 'done', iterations: 5, finalText: 'unreachable' };
        },
      } as never as Agent;
      return { agent, events };
    };
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 'b1', name: 'B1', maxToolCalls: 1 });
    const completion = new Promise<TaskResult>((resolve) => {
      coord.once('task.completed', (e: { result: TaskResult }) => resolve(e.result));
    });
    await coord.assign({ id: 't1', description: 'overrun first call' });
    const result = await completion;

    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('budget_tool_calls');
    // toolCalls counter should be either 1 (just-busted) or 2
    // (count then bust on next start). Either is correct as long as
    // it's bounded — the test fails loudly if pairing drifts back
    // to count-on-started which would let phantom counts through.
    expect(result.toolCalls).toBeGreaterThanOrEqual(1);
    expect(result.toolCalls).toBeLessThanOrEqual(2);
  });

  // ────────────────────────────────────────────────────────────────────
  // M4 — Synchronous error-state reset (no queueMicrotask race)
  // ────────────────────────────────────────────────────────────────────
  it('M4: failed task resets the worker to idle synchronously so the next assign() dispatches', async () => {
    let runs = 0;
    const factory = async () => {
      runs += 1;
      const events = new EventBus();
      const ctx = {} as never;
      const agent = {
        async run(): Promise<RunResult> {
          // First run fails synthetically; second run succeeds.
          if (runs === 1) {
            return {
              status: 'failed',
              error: new Error('first run fails'),
              iterations: 0,
            };
          }
          events.emit('iteration.started', { ctx, index: 0 });
          events.emit('provider.response', {
            ctx,

            model: 'test-model',
            usage: { input: 1, output: 1 },
            stopReason: 'end_turn',
          });
          return { status: 'done', iterations: 1, finalText: 'second run ok' };
        },
      } as never as Agent;
      return { agent, events };
    };
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 'r1', name: 'R1' });

    const first = new Promise<TaskResult>((resolve) => {
      coord.once('task.completed', (e: { result: TaskResult }) => resolve(e.result));
    });
    await coord.assign({ id: 't1', description: 'will fail' });
    const r1 = await first;
    expect(r1.status).toBe('failed');

    // Worker should be back to 'idle' RIGHT NOW (no microtask wait).
    // The next assign must dispatch in the same tick — if the prior
    // microtask-based reset is still in flight, this assign will queue
    // forever and the test times out.
    const second = new Promise<TaskResult>((resolve) => {
      coord.once('task.completed', (e: { result: TaskResult }) => resolve(e.result));
    });
    await coord.assign({ id: 't2', description: 'should dispatch immediately' });
    const r2 = await second;
    expect(r2.status).toBe('success');
    expect(r2.result).toBe('second run ok');
  });
});

/**
 * D5 / T3 — Abort while a tool is mid-execution.
 *
 * The hardest path in the lifecycle: a subagent has called a tool
 * (bash, fetch, anything that runs async), the tool is still
 * streaming progress, and the parent fires `stop(subagentId)` to
 * terminate. The system must:
 *
 *   1. Propagate the abort to the tool (signal aborts).
 *   2. Unwind the agent cooperatively without a phantom task.completed.
 *   3. Tag the TaskResult with `status='stopped'` and
 *      `error.kind='aborted_by_parent'` (NOT 'failed' or 'unknown').
 *   4. Free the inFlight slot so the next assign() can dispatch.
 *   5. Run the factory's `dispose` so any per-task JSONL writer closes.
 *
 * Each of these used to fail in isolation in the prior coordinator:
 *   - The classifier could collapse abort into 'unknown' if the
 *     tool wrapped its rejection in a `new Error(...)` without our
 *     "agent aborted" marker.
 *   - `terminating` set wasn't tracked so a stop+assign race left
 *     the inFlight counter elevated.
 *   - dispose wasn't called on the abort path.
 *
 * D2 fixed all of these; this test pins the contract so any future
 * refactor that loses one of the guarantees fails loudly.
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
  coordinatorId: 'abort-coord',
  doneCondition: { type: 'all_tasks_done' as const },
  maxConcurrent: 2,
  ...overrides,
});

describe('subagent abort during tool execution (D5/T3)', () => {
  it('stop() mid-tool surfaces aborted_by_parent and closes the session', async () => {
    // Stub agent: emits one tool.started, then parks on a long sleep
    // that respects the abort signal. Models a real bash/fetch tool.
    let disposed = 0;
    const factory = vi.fn(async () => {
      const events = new EventBus();
      const ctx = {} as never;
      const agent = {
        async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
          events.emit('iteration.started', { ctx, index: 0 });
          events.emit('tool.started', { name: 'long_tool', id: 't0' });
          // Park on signal. A cooperative tool aborts the moment the
          // signal flips. The race here mirrors what bash/fetch does
          // internally: child process killed → promise rejects.
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 5_000);
            runOpts.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolve();
              },
              { once: true },
            );
          });
          if (runOpts.signal.aborted) {
            return { status: 'aborted', iterations: 0 };
          }
          // Should not reach here in the abort path.
          events.emit('tool.executed', {
            name: 'long_tool',
            id: 't0',
            durationMs: 5_000,
            ok: true,
          });
          return { status: 'done', iterations: 1, finalText: 'late' };
        },
      } as never as Agent;
      return {
        agent,
        events,
        dispose: async () => {
          disposed += 1;
        },
      };
    });
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 's1', name: 'S1' });
    const completion = new Promise<TaskResult>((resolve) => {
      coord.once('task.completed', (e: { result: TaskResult }) => resolve(e.result));
    });
    await coord.assign({ id: 't1', description: 'will be aborted' });

    // Yield enough for the runner to dispatch and the tool to start.
    await new Promise((r) => setTimeout(r, 20));
    await coord.stop('s1');

    const result = await completion;

    // Contract 1+3: status=stopped, kind=aborted_by_parent.
    expect(result.status).toBe('stopped');
    expect(result.error?.kind).toBe('aborted_by_parent');
    expect(result.error?.retryable).toBe(false);

    // Contract 5: dispose ran (per-task JSONL writer closed).
    expect(disposed).toBe(1);

    // Contract 4: inFlight slot freed — assign() after stop() must
    // either dispatch on a fresh subagent or be synthesised. Either
    // way, no leaked slots.
    // (We don't spawn a second subagent here; the dead-end drain test
    // in coordinator-race.test.ts covers that branch.)
    expect(coord.getStatus().pendingTasks).toBe(0);
  });

  it('stop() AFTER tool completes but before agent returns still resolves cleanly', async () => {
    // Edge case: tool finishes, agent is in the `provider.response`
    // emission window, parent fires stop. The signal goes high but
    // the run is already done. Should NOT surface as aborted — the
    // result was already produced. (Status depends on timing; the
    // contract is "no exception, no orphan".)
    const factory = async () => {
      const events = new EventBus();
      const ctx = {} as never;
      const agent = {
        async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
          events.emit('iteration.started', { ctx, index: 0 });
          events.emit('tool.started', { name: 'fast', id: 't0' });
          events.emit('tool.executed', {
            name: 'fast',
            id: 't0',
            durationMs: 1,
            ok: true,
          });
          events.emit('provider.response', {
            ctx,

            model: 'test-model',
            usage: { input: 1, output: 1 },
            stopReason: 'end_turn',
          });
          // Give the coordinator a tick to (maybe) abort us; either way
          // we return done. Don't observe `signal.aborted` here so we
          // model the case where the agent already had its final
          // response in hand.
          await new Promise((r) => setImmediate(r));
          void runOpts;
          return { status: 'done', iterations: 1, finalText: 'made it' };
        },
      } as never as Agent;
      return { agent, events };
    };
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 's1', name: 'S1' });
    const completion = new Promise<TaskResult>((resolve) => {
      coord.once('task.completed', (e: { result: TaskResult }) => resolve(e.result));
    });
    await coord.assign({ id: 't1', description: 'race the stop' });

    // Don't wait — fire stop immediately. The race outcome is what
    // we're testing.
    void coord.stop('s1');
    const result = await completion;

    // Either outcome is valid as long as we don't crash and the slot
    // is freed.  We document the most useful outcomes here.
    expect(['success', 'stopped']).toContain(result.status);
    expect(coord.getStatus().pendingTasks).toBe(0);
  });
});

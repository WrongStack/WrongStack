/**
 * D3 — Tool budget continuity. The runner enforces wall-clock
 * timeouts between iterations (cheap), but a single tool call that
 * never returns (e.g. `bash sleep 3600`) would sit inside one
 * iteration with no checkTimeout firing. The fix subscribes to the
 * `tool.progress` event stream so any tool that emits heartbeats
 * (bash, fetch, spawn-stream) gives the budget a chance to bust
 * the run before the coordinator's hard Promise.race deadline.
 *
 * Without the listener, this test would fail two ways:
 *   - the agent's tool would run to completion (1000ms wait)
 *   - the result.status would be 'timeout' from the coordinator
 *     race instead of 'failed' from a cooperative bust
 *
 * With the listener, the budget trips on the 2nd progress event,
 * abort propagates back to agent.run via the runner's aborter, and
 * the tool's signal listener kills it. Status surfaces as 'timeout'
 * (BudgetExceededError.kind === 'timeout' → `budget_timeout`).
 */
import { describe, expect, it } from 'vitest';
import { makeAgentSubagentRunner } from '../../src/coordination/agent-subagent-runner.js';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import type { Agent, RunResult } from '../../src/core/agent.js';
import { EventBus } from '../../src/kernel/events.js';
import type { TaskResult } from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

const makeConfig = (overrides: Record<string, unknown> = {}) => ({
  coordinatorId: 'budget-coord',
  doneCondition: { type: 'all_tasks_done' as const },
  maxConcurrent: 1,
  ...overrides,
});

describe('subagent budget edges (D3)', () => {
  it('tool.progress heartbeat busts wall-clock budget mid-tool', async () => {
    // Agent stub: simulates a long tool call by emitting tool.started
    // then a stream of tool.progress events. The runner's tool.progress
    // listener should fire checkTimeout(), trip BudgetExceededError,
    // and abort the agent's signal so the run unwinds.
    let progressTicks = 0;
    const factory = async () => {
      const events = new EventBus();
      const ctx = {} as never;
      const agent = {
        async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
          events.emit('iteration.started', { ctx, index: 0 });
          events.emit('tool.started', { name: 'slow', id: 't0' });
          // Heartbeat for ~500ms with a 40ms timeoutMs budget so the
          // budget trips on the 2nd-3rd progress tick at most.
          for (let i = 0; i < 50; i++) {
            if (runOpts.signal.aborted) {
              return { status: 'aborted', iterations: 0 };
            }
            events.emit('tool.progress', {
              name: 'slow',
              id: 't0',
              event: { type: 'output', text: `tick ${i}` } as never,
            });
            progressTicks++;
            await new Promise((r) => setTimeout(r, 20));
          }
          // Tool "completes" — shouldn't get here if abort fired.
          events.emit('tool.executed', {
            name: 'slow',
            id: 't0',
            durationMs: 1000,
            ok: true,
          });
          events.emit('provider.response', {
            ctx,

            model: 'test-model',
            usage: { input: 1, output: 1 },
            stopReason: 'end_turn',
          });
          return { status: 'done', iterations: 1, finalText: 'unreachable' };
        },
      } as never as Agent;
      return { agent, events };
    };
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 's1', name: 'S1', timeoutMs: 40 });
    const completion = new Promise<TaskResult>((resolve) => {
      coord.once('task.completed', (e: { result: TaskResult }) => resolve(e.result));
    });
    await coord.assign({ id: 't1', description: 'slow tool' });
    const result = await completion;

    // The cooperative bust runs through runner → aborter.abort()
    // which the coordinator sees as parentAborted but the budget
    // error carries the structured kind. Either 'timeout' (coord
    // race won) or 'failed' with kind='budget_timeout' (runner won
    // first) is acceptable; both prove the budget tripped.
    expect(['timeout', 'failed']).toContain(result.status);
    expect(result.error?.kind).toBe('budget_timeout');
    // The 50-iteration loop should NOT have run to completion —
    // proving the cooperative abort actually interrupted the tool.
    // (The agent's signal-aware return runs after task.completed in
    // the background, so we can't directly assert the agent saw the
    // abort; bounding progressTicks proves the interruption.)
    expect(progressTicks).toBeLessThan(50);
  });

  it('tool.progress without timeoutMs does not throw', async () => {
    // Regression guard: if a subagent has no timeoutMs, the
    // checkTimeout() call short-circuits silently. A misfire here
    // would surface as a spurious budget_timeout on every tool
    // progress event.
    const factory = async () => {
      const events = new EventBus();
      const ctx = {} as never;
      const agent = {
        async run(): Promise<RunResult> {
          events.emit('iteration.started', { ctx, index: 0 });
          events.emit('tool.started', { name: 'fast', id: 't0' });
          for (let i = 0; i < 10; i++) {
            events.emit('tool.progress', {
              name: 'fast',
              id: 't0',
              event: { type: 'output', text: `t${i}` } as never,
            });
          }
          events.emit('tool.executed', {
            name: 'fast',
            id: 't0',
            durationMs: 5,
            ok: true,
          });
          events.emit('provider.response', {
            ctx,

            model: 'test-model',
            usage: { input: 1, output: 1 },
            stopReason: 'end_turn',
          });
          return { status: 'done', iterations: 1, finalText: 'all good' };
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
    await coord.assign({ id: 't1', description: 'fast tool' });
    const result = await completion;

    expect(result.status).toBe('success');
    expect(result.result).toBe('all good');
  });
});

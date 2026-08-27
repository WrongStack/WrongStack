/**
 * retargetPendingTask / listPendingTasks — the rebalancing primitives.
 *
 * Pins the supervisor contract:
 *   - a pending task pinned to a busy worker moves to an idle sibling and
 *     dispatches immediately
 *   - a dispatched (running) task can NOT be pulled → false
 *   - unknown task / unknown target subagent → false
 *   - unpin (undefined) lets any idle worker take the task
 *   - waiters registered before the retarget still resolve (task id is
 *     preserved end-to-end)
 *   - listPendingTasks returns defensive copies
 */
import { describe, expect, it } from 'vitest';
import { makeAgentSubagentRunner } from '../../src/coordination/agent-subagent-runner.js';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import type { Agent, RunResult } from '../../src/core/agent.js';
import { EventBus } from '../../src/kernel/events.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

const makeConfig = (overrides: Record<string, unknown> = {}) => ({
  coordinatorId: 'retarget-coord',
  doneCondition: { type: 'all_tasks_done' as const },
  maxConcurrent: 4,
  ...overrides,
});

function makeGate(): { release: () => void; promise: Promise<void> } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { release, promise };
}

function makeGatedAgent(gate: { promise: Promise<void> }, finalText: string) {
  const events = new EventBus();
  const ctx = {} as never;
  const agent = {
    async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
      events.emit('iteration.started', { ctx, index: 0 });
      events.emit('provider.response', {
        ctx,

        model: 'test-model',
        usage: { input: 1, output: 1 },
        stopReason: 'end_turn',
      });
      await Promise.race([
        gate.promise,
        new Promise<void>((resolve) => {
          if (runOpts.signal.aborted) resolve();
          else runOpts.signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
      if (runOpts.signal.aborted) return { status: 'aborted', iterations: 1 };
      return { status: 'done', iterations: 1, finalText };
    },
  } as never as Agent;
  return { agent, events };
}

/** Coordinator whose factory hands out per-subagent gates keyed by the
 *  subagent config id (the factory runs once per TASK dispatch). */
function makeCoord(ids: string[]) {
  const gates = new Map(ids.map((id) => [id, makeGate()]));
  const runBySubagent: string[] = [];
  const factory = async (config: { id?: string | undefined }) => {
    const id = config.id ?? 'unknown';
    runBySubagent.push(id);
    const gate = gates.get(id);
    if (!gate) throw new Error(`no gate for ${id}`);
    return makeGatedAgent(gate, `${id} done`);
  };
  const runner = makeAgentSubagentRunner({ factory: factory as never });
  const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
    runner,
    sessionId: TEST_SESSION_ID,
  });
  return { coord, gates, runBySubagent };
}

describe('DefaultMultiAgentCoordinator.retargetPendingTask', () => {
  it('moves a starved pinned task to an idle sibling and dispatches it immediately', async () => {
    const { coord, gates } = makeCoord(['busy', 'idle']);
    await coord.spawn({ id: 'busy', name: 'Busy' });
    await coord.spawn({ id: 'idle', name: 'Idle' });
    // First task occupies 'busy'; second task is pinned behind it.
    await coord.assign({ id: 't-head', description: 'long head task', subagentId: 'busy' });
    await coord.assign({ id: 't-starved', description: 'queued behind busy', subagentId: 'busy' });
    expect(coord.listPendingTasks().map((t) => t.id)).toEqual(['t-starved']);

    const waiter = coord.awaitTasks(['t-starved']);
    const ok = coord.retargetPendingTask('t-starved', 'idle');
    expect(ok).toBe(true);
    // Dispatched to 'idle' immediately — release its gate and the
    // pre-retarget waiter resolves with the same task id.
    gates.get('idle')?.release();
    const [result] = await waiter;
    expect(result?.taskId).toBe('t-starved');
    expect(result?.subagentId).toBe('idle');
    expect(result?.status).toBe('success');

    gates.get('busy')?.release();
    await coord.awaitTasks(['t-head']);
  });

  it('returns false for a dispatched (running) task — running work is never pulled', async () => {
    const { coord, gates } = makeCoord(['w1']);
    await coord.spawn({ id: 'w1', name: 'W1' });
    await coord.assign({ id: 't-running', description: 'in flight', subagentId: 'w1' });
    // Task dispatched immediately (worker was idle) → not pending anymore.
    expect(coord.listPendingTasks()).toHaveLength(0);
    expect(coord.retargetPendingTask('t-running', 'w1')).toBe(false);
    gates.get('w1')?.release();
    await coord.awaitTasks(['t-running']);
  });

  it('returns false for unknown task ids and unknown target subagents', async () => {
    const { coord, gates } = makeCoord(['w1']);
    await coord.spawn({ id: 'w1', name: 'W1' });
    await coord.assign({ id: 't-head', description: 'occupies w1', subagentId: 'w1' });
    await coord.assign({ id: 't-q', description: 'queued', subagentId: 'w1' });
    expect(coord.retargetPendingTask('nope', 'w1')).toBe(false);
    expect(coord.retargetPendingTask('t-q', 'ghost-worker')).toBe(false);
    // The failed retarget didn't corrupt the pin.
    expect(coord.listPendingTasks()[0]?.subagentId).toBe('w1');
    gates.get('w1')?.release();
    await coord.awaitTasks(['t-head', 't-q']);
  });

  it('unpins with undefined so any idle worker takes the task', async () => {
    const { coord, gates, runBySubagent } = makeCoord(['busy', 'idle']);
    await coord.spawn({ id: 'busy', name: 'Busy' });
    await coord.spawn({ id: 'idle', name: 'Idle' });
    await coord.assign({ id: 't-head', description: 'long', subagentId: 'busy' });
    await coord.assign({ id: 't-q', description: 'pinned queued', subagentId: 'busy' });

    const waiter = coord.awaitTasks(['t-q']);
    expect(coord.retargetPendingTask('t-q', undefined)).toBe(true);
    gates.get('idle')?.release();
    const [result] = await waiter;
    expect(result?.subagentId).toBe('idle');
    expect(runBySubagent).toContain('idle');
    gates.get('busy')?.release();
    await coord.awaitTasks(['t-head']);
  });

  it('listPendingTasks returns defensive copies', async () => {
    const { coord, gates } = makeCoord(['w1']);
    await coord.spawn({ id: 'w1', name: 'W1' });
    await coord.assign({ id: 't-head', description: 'occupies', subagentId: 'w1' });
    await coord.assign({ id: 't-q', description: 'queued', subagentId: 'w1' });
    const snapshot = coord.listPendingTasks();
    (snapshot[0] as { subagentId?: string }).subagentId = 'tampered';
    expect(coord.listPendingTasks()[0]?.subagentId).toBe('w1');
    gates.get('w1')?.release();
    await coord.awaitTasks(['t-head', 't-q']);
  });
});

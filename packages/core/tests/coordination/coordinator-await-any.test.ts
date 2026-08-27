/**
 * awaitTasksAny — first-completion semantics on the coordinator.
 *
 * The leader's early-finisher primitive: resolve as soon as ANY of the
 * requested tasks completes (or immediately when some already have),
 * returning the still-pending ids so the caller can loop. Pins:
 *   - fast finisher resolves while the slow sibling is still in flight
 *   - already-completed ids drain immediately without waiting
 *   - timeoutMs resolves {timedOut:true} (never rejects) and detaches
 *     the listener
 *   - no listener leak on any exit path
 */
import { describe, expect, it } from 'vitest';
import { makeAgentSubagentRunner } from '../../src/coordination/agent-subagent-runner.js';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import type { Agent, RunResult } from '../../src/core/agent.js';
import { EventBus } from '../../src/kernel/events.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

const makeConfig = (overrides: Record<string, unknown> = {}) => ({
  coordinatorId: 'await-any-coord',
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

/** Agent stub that completes when its gate is released. */
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
      await gate.promise;
      if (runOpts.signal.aborted) return { status: 'aborted', iterations: 1 };
      return { status: 'done', iterations: 1, finalText };
    },
  } as never as Agent;
  return { agent, events };
}

/** Coordinator with one gated agent per named subagent id. */
function makeCoordWithGates(ids: string[]) {
  const gates = new Map(ids.map((id) => [id, makeGate()]));
  let spawnIndex = 0;
  const factory = async () => {
    const id = ids[spawnIndex++];
    if (!id) throw new Error('factory called more times than spawn ids provided');
    const gate = gates.get(id);
    if (!gate) throw new Error(`no gate for ${id}`);
    return makeGatedAgent(gate, `${id} done`);
  };
  const runner = makeAgentSubagentRunner({ factory });
  const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
    runner,
    sessionId: TEST_SESSION_ID,
  });
  return { coord, gates };
}

describe('DefaultMultiAgentCoordinator.awaitTasksAny', () => {
  it('resolves with the fast finisher while the slow sibling is still running', async () => {
    const { coord, gates } = makeCoordWithGates(['fast', 'slow']);
    await coord.spawn({ id: 'fast', name: 'Fast' });
    await coord.spawn({ id: 'slow', name: 'Slow' });
    await coord.assign({ id: 't-fast', description: 'quick', subagentId: 'fast' });
    await coord.assign({ id: 't-slow', description: 'long', subagentId: 'slow' });

    const anyPromise = coord.awaitTasksAny(['t-fast', 't-slow']);
    gates.get('fast')?.release();

    const r = await anyPromise;
    expect(r.completed).toHaveLength(1);
    expect(r.completed[0]?.taskId).toBe('t-fast');
    expect(r.completed[0]?.status).toBe('success');
    expect(r.pending).toEqual(['t-slow']);
    expect(r.timedOut).toBeUndefined();
    // Slow sibling really is still in flight.
    const slowStatus = coord.getStatus().subagents.find((s) => s.id === 'slow');
    expect(slowStatus?.status).toBe('running');

    gates.get('slow')?.release();
    await coord.awaitTasks(['t-slow']); // drain before teardown
  });

  it('drains already-completed ids immediately, without registering a listener', async () => {
    const { coord, gates } = makeCoordWithGates(['fast', 'slow']);
    await coord.spawn({ id: 'fast', name: 'Fast' });
    await coord.spawn({ id: 'slow', name: 'Slow' });
    await coord.assign({ id: 't-fast', description: 'quick', subagentId: 'fast' });
    await coord.assign({ id: 't-slow', description: 'long', subagentId: 'slow' });
    gates.get('fast')?.release();
    await coord.awaitTasks(['t-fast']);

    const baseline = coord.listenerCount('task.completed');
    const r = await coord.awaitTasksAny(['t-fast', 't-slow']);
    expect(r.completed.map((x) => x.taskId)).toEqual(['t-fast']);
    expect(r.pending).toEqual(['t-slow']);
    expect(coord.listenerCount('task.completed')).toBe(baseline);

    gates.get('slow')?.release();
    await coord.awaitTasks(['t-slow']);
  });

  it('returns every cached result when multiple requested ids already completed', async () => {
    const { coord, gates } = makeCoordWithGates(['fast', 'slow']);
    await coord.spawn({ id: 'fast', name: 'Fast' });
    await coord.spawn({ id: 'slow', name: 'Slow' });
    await coord.assign({ id: 't-1', description: 'one', subagentId: 'fast' });
    await coord.assign({ id: 't-2', description: 'two', subagentId: 'slow' });
    gates.get('fast')?.release();
    gates.get('slow')?.release();
    await coord.awaitTasks(['t-1', 't-2']);

    const r = await coord.awaitTasksAny(['t-1', 't-2']);
    expect(r.completed.map((x) => x.taskId).sort()).toEqual(['t-1', 't-2']);
    expect(r.pending).toEqual([]);
  });

  it('timeoutMs resolves {timedOut:true} without rejecting and removes the listener', async () => {
    const { coord, gates } = makeCoordWithGates(['slow']);
    await coord.spawn({ id: 'slow', name: 'Slow' });
    await coord.assign({ id: 't-slow', description: 'long', subagentId: 'slow' });

    const baseline = coord.listenerCount('task.completed');
    const r = await coord.awaitTasksAny(['t-slow'], { timeoutMs: 20 });
    expect(r.timedOut).toBe(true);
    expect(r.completed).toEqual([]);
    expect(r.pending).toEqual(['t-slow']);
    expect(coord.listenerCount('task.completed')).toBe(baseline);

    gates.get('slow')?.release();
    await coord.awaitTasks(['t-slow']);
  });

  it('clears the timeout timer when a completion wins the race', async () => {
    const { coord, gates } = makeCoordWithGates(['fast']);
    await coord.spawn({ id: 'fast', name: 'Fast' });
    await coord.assign({ id: 't-fast', description: 'quick', subagentId: 'fast' });

    const baseline = coord.listenerCount('task.completed');
    const anyPromise = coord.awaitTasksAny(['t-fast'], { timeoutMs: 60_000 });
    gates.get('fast')?.release();
    const r = await anyPromise;
    expect(r.timedOut).toBeUndefined();
    expect(r.completed[0]?.taskId).toBe('t-fast');
    expect(coord.listenerCount('task.completed')).toBe(baseline);
  });

  it('empty id list resolves immediately with empty result', async () => {
    const { coord } = makeCoordWithGates([]);
    const r = await coord.awaitTasksAny([]);
    expect(r).toEqual({ completed: [], pending: [] });
  });
});

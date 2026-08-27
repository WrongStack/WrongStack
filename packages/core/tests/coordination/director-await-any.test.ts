/**
 * Director.awaitTasksAny + the consumed-in-band report-back rule.
 *
 * Pins the early-finisher contract:
 *   - awaitTasksAny resolves with the first finisher; the slow sibling
 *     stays pending
 *   - the any-WINNER is consumed in-band → no taskResultNotifier call
 *   - the any-LOSER completes later with no waiter → notifier fires
 *     (this is the un-suppression: before, callers of await primitives
 *     silenced every id in the batch)
 *   - awaitTasks('all') still suppresses the notifier for every id it
 *     returns (unchanged behavior)
 *   - workComplete() drain wakes an in-flight awaitTasksAny
 *   - shutdown() clears any-waiter timers
 */
import { describe, expect, it, vi } from 'vitest';
import { Director, type TaskResultNotification } from '../../src/coordination/director.js';
import type {
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

function makeGate(): { release: () => void; promise: Promise<void> } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { release, promise };
}

/**
 * Director whose runner blocks each task on a per-task gate. Tasks
 * without a registered gate complete immediately.
 */
function buildGatedDirector(notifier?: (n: TaskResultNotification) => void) {
  const gates = new Map<string, { release: () => void; promise: Promise<void> }>();
  const gateFor = (taskId: string) => {
    const g = makeGate();
    gates.set(taskId, g);
    return g;
  };
  const runner = vi.fn(
    async (task: TaskSpec, ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
      const gate = gates.get(task.id);
      if (gate) {
        // Respect the coordinator's abort so shutdown()/stopAll() never
        // hangs on a gate the test intentionally leaves closed.
        await Promise.race([
          gate.promise,
          new Promise<void>((resolve) => {
            if (ctx.signal.aborted) resolve();
            else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
      }
      return { result: `${ctx.config.name}:${task.description}`, iterations: 1, toolCalls: 0 };
    },
  );
  const director = new Director({
    sessionId: TEST_SESSION_ID,
    config: {
      coordinatorId: 'await-any-director',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 4,
    },
    runner,
    taskResultNotifier: notifier,
  });
  return { director, gateFor };
}

const waitImmediate = () => new Promise((resolve) => setImmediate(resolve));

describe('Director.awaitTasksAny', () => {
  it('resolves with the first finisher and leaves the sibling pending', async () => {
    const { director, gateFor } = buildGatedDirector();
    const slowGate = gateFor('t-slow');
    await director.spawn({ id: 'w1', name: 'W1' });
    await director.spawn({ id: 'w2', name: 'W2' });
    await director.assign({ id: 't-fast', description: 'quick', subagentId: 'w1' });
    await director.assign({ id: 't-slow', description: 'long', subagentId: 'w2' });

    const r = await director.awaitTasksAny(['t-fast', 't-slow']);
    expect(r.completed).toHaveLength(1);
    expect(r.completed[0]?.taskId).toBe('t-fast');
    expect(r.pending).toEqual(['t-slow']);

    slowGate.release();
    await director.awaitTasks(['t-slow']);
    await director.shutdown();
  });

  it('suppresses the notifier for the any-winner but fires it for the any-loser', async () => {
    const notifications: TaskResultNotification[] = [];
    const { director, gateFor } = buildGatedDirector((n) => notifications.push(n));
    // Gate BOTH tasks so the any-await is registered before either
    // completes — the winner must be consumed by the anyWaiters sweep,
    // not the completed-cache fast path.
    const fastGate = gateFor('t-fast');
    const slowGate = gateFor('t-slow');
    await director.spawn({ id: 'w1', name: 'W1' });
    await director.spawn({ id: 'w2', name: 'W2' });
    await director.assign({ id: 't-fast', description: 'quick', subagentId: 'w1' });
    await director.assign({ id: 't-slow', description: 'long', subagentId: 'w2' });

    const anyPromise = director.awaitTasksAny(['t-fast', 't-slow']);
    fastGate.release();
    const r = await anyPromise;
    expect(r.completed[0]?.taskId).toBe('t-fast');
    await waitImmediate();
    // Winner returned in-band → no mail for it.
    expect(notifications.map((n) => n.taskId)).not.toContain('t-fast');

    // Loser completes later with no waiter → report-back fires.
    slowGate.release();
    await vi.waitFor(() => {
      expect(notifications.map((n) => n.taskId)).toContain('t-slow');
    });
    expect(notifications.filter((n) => n.taskId === 't-slow')).toHaveLength(1);
    await director.shutdown();
  });

  it('awaitTasks (all-mode) still suppresses the notifier for every returned id', async () => {
    const notifications: TaskResultNotification[] = [];
    const { director, gateFor } = buildGatedDirector((n) => notifications.push(n));
    // Gate both tasks so the waiters exist BEFORE completion — the
    // suppression rule keys off "waiter present at completion time".
    const gateA = gateFor('t-a');
    const gateB = gateFor('t-b');
    await director.spawn({ id: 'w1', name: 'W1' });
    await director.spawn({ id: 'w2', name: 'W2' });
    await director.assign({ id: 't-a', description: 'a', subagentId: 'w1' });
    await director.assign({ id: 't-b', description: 'b', subagentId: 'w2' });

    const all = director.awaitTasks(['t-a', 't-b']);
    gateA.release();
    gateB.release();
    await all;
    await waitImmediate();
    expect(notifications).toEqual([]);
    await director.shutdown();
  });

  it('fires the notifier for a fully fire-and-forget task (no awaiters at all)', async () => {
    const notifications: TaskResultNotification[] = [];
    const { director } = buildGatedDirector((n) => notifications.push(n));
    await director.spawn({ id: 'w1', name: 'W1' });
    const id = await director.assign({ description: 'background work', subagentId: 'w1' });

    await vi.waitFor(() => {
      expect(notifications.map((n) => n.taskId)).toContain(id);
    });
    await director.shutdown();
  });

  it('returns cached results immediately when some ids already completed', async () => {
    const { director, gateFor } = buildGatedDirector();
    const slowGate = gateFor('t-slow');
    await director.spawn({ id: 'w1', name: 'W1' });
    await director.spawn({ id: 'w2', name: 'W2' });
    await director.assign({ id: 't-fast', description: 'quick', subagentId: 'w1' });
    await director.assign({ id: 't-slow', description: 'long', subagentId: 'w2' });
    await director.awaitTasks(['t-fast']);

    const r = await director.awaitTasksAny(['t-fast', 't-slow']);
    expect(r.completed.map((x) => x.taskId)).toEqual(['t-fast']);
    expect(r.pending).toEqual(['t-slow']);

    slowGate.release();
    await director.awaitTasks(['t-slow']);
    await director.shutdown();
  });

  it('timeoutMs resolves {timedOut:true} while nothing completes', async () => {
    const { director, gateFor } = buildGatedDirector();
    const gate = gateFor('t-slow');
    await director.spawn({ id: 'w1', name: 'W1' });
    await director.assign({ id: 't-slow', description: 'long', subagentId: 'w1' });

    const r = await director.awaitTasksAny(['t-slow'], { timeoutMs: 20 });
    expect(r).toEqual({ completed: [], pending: ['t-slow'], timedOut: true });

    gate.release();
    await director.awaitTasks(['t-slow']);
    await director.shutdown();
  });

  it('workComplete() drain wakes an in-flight awaitTasksAny for a post-complete assign', async () => {
    const { director } = buildGatedDirector();
    await director.spawn({ id: 'w1', name: 'W1' });
    director.workComplete();

    // Assign AFTER workComplete: the task never reaches the coordinator;
    // the drain synthesizes a stopped result and must wake any-awaiters.
    const anyPromise = director.awaitTasksAny(['post-wc']);
    const id = await director.assign({ id: 'post-wc', description: 'never runs' });
    expect(id).toBe('post-wc');

    const r = await anyPromise;
    expect(r.completed[0]?.taskId).toBe('post-wc');
    expect(r.completed[0]?.status).toBe('stopped');
    expect(r.completed[0]?.error?.kind).toBe('aborted_by_parent');
    await director.shutdown();
  });

  it('shutdown() resolves any-waiter promises with a stopped result (no hang)', async () => {
    vi.useFakeTimers();
    try {
      const { director, gateFor } = buildGatedDirector();
      gateFor('t-never');
      await director.spawn({ id: 'w1', name: 'W1' });
      await director.assign({ id: 't-never', description: 'never finishes', subagentId: 'w1' });
      // Park an any-await with a long timeout, then shut down.
      let settled: unknown = null;
      void director.awaitTasksAny(['t-never'], { timeoutMs: 3_600_000 }).then((r) => {
        settled = r;
      });
      await director.shutdown();
      // shutdown now resolves pending any-waiters with a synthetic
      // 'stopped' result instead of leaving the promise dangling.
      // Use a microtask to let the settled assignment run.
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toBeNull();
      const result = settled as {
        completed: Array<{ taskId: string; status: string }>;
        pending: string[];
      };
      expect(result.completed).toHaveLength(1);
      expect(result.completed[0]?.taskId).toBe('t-never');
      expect(result.completed[0]?.status).toBe('stopped');
      expect(result.pending).toEqual([]);
      // Confirm the original timeout no longer fires (timer was cleared).
      await vi.advanceTimersByTimeAsync(3_600_000 + 1_000);
      expect(settled).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

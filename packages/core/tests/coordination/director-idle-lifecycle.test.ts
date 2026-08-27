import { afterEach, describe, expect, it, vi } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import type {
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

function makeDirector(opts: {
  idleMs?: number;
  retireOnComplete?: boolean;
  runner?: (task: TaskSpec, ctx: SubagentRunContext) => Promise<SubagentRunOutcome>;
}): Director {
  return new Director({
    sessionId: TEST_SESSION_ID,
    config: {
      coordinatorId: 'idle-lifecycle-test',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 1,
    },
    subagentIdleTimeoutMs: opts.idleMs,
    retireSubagentOnTaskComplete: opts.retireOnComplete,
    runner: opts.runner ?? (async () => ({ result: 'final answer', iterations: 1, toolCalls: 0 })),
  });
}

afterEach(() => vi.useRealTimers());

describe('Director subagent idle lifecycle', () => {
  it('removes a spawned subagent after the configured idle timeout', async () => {
    vi.useFakeTimers();
    const director = makeDirector({ idleMs: 50 });
    const removed: string[] = [];
    const off = director.fleet.filter('subagent.removed', (event) => {
      removed.push(event.subagentId);
    });

    await director.spawn({ id: 'idle-worker', name: 'Idle worker' });
    await vi.advanceTimersByTimeAsync(49);
    expect(director.status().subagents.some((a) => a.id === 'idle-worker')).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(director.status().subagents.some((a) => a.id === 'idle-worker')).toBe(false);
    expect(removed).toEqual(['idle-worker']);

    off();
    await director.shutdown();
  });

  it('retires a subagent immediately after its final task result is delivered', async () => {
    vi.useFakeTimers();
    const director = makeDirector({ idleMs: 60_000, retireOnComplete: true });
    await director.spawn({ id: 'one-shot', name: 'One shot' });
    await director.assign({ id: 'task-1', description: 'finish', subagentId: 'one-shot' });

    const [result] = await director.awaitTasks(['task-1']);
    expect(result?.result).toBe('final answer');
    expect(director.status().subagents.some((a) => a.id === 'one-shot')).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(director.status().subagents.some((a) => a.id === 'one-shot')).toBe(false);
    expect(director.completedResults().map((r) => r.taskId)).toContain('task-1');

    await director.shutdown();
  });

  it('lets queued work reuse the worker before retiring it', async () => {
    vi.useFakeTimers();
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const director = makeDirector({
      idleMs: 60_000,
      retireOnComplete: true,
      runner: async (task) => {
        if (task.id === 'task-1') await firstGate;
        return { result: task.id, iterations: 1, toolCalls: 0 };
      },
    });
    await director.spawn({ id: 'reused-worker', name: 'Reusable' });
    await director.assign({ id: 'task-1', description: 'first', subagentId: 'reused-worker' });
    await director.assign({ id: 'task-2', description: 'second', subagentId: 'reused-worker' });

    releaseFirst();
    const results = await director.awaitTasks(['task-1', 'task-2']);
    expect(results.map((r) => r.result)).toEqual(['task-1', 'task-2']);

    await vi.advanceTimersByTimeAsync(0);
    expect(director.status().subagents.some((a) => a.id === 'reused-worker')).toBe(false);
    await director.shutdown();
  });

  it('internal tasks are exempt from retire-on-complete but still bounded by the idle window', async () => {
    vi.useFakeTimers();
    const director = makeDirector({ idleMs: 50, retireOnComplete: true });
    await director.spawn({ id: 'resident', name: 'Resident' });
    await director.assignInternal({ id: 'probe-1', description: 'probe', subagentId: 'resident' });

    const [result] = await director.awaitTasks(['probe-1']);
    expect(result?.result).toBe('final answer');

    await vi.advanceTimersByTimeAsync(0);
    // Retire-on-complete fires for leader-visible tasks only — an internal
    // probe completing must NOT retire the resident.
    expect(director.status().subagents.some((a) => a.id === 'resident')).toBe(true);

    // Exemption is not immortality: internal completion arms the regular
    // idle window, so the resident is reaped once idle.
    await vi.advanceTimersByTimeAsync(50);
    expect(director.status().subagents.some((a) => a.id === 'resident')).toBe(false);
    await director.shutdown();
  });

  it('re-arms retirement when the idle tick fires while the subagent is busy (no immortal residents)', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const director = makeDirector({
      idleMs: 50,
      retireOnComplete: true,
      runner: async () => {
        await gate;
        return { result: 'done', iterations: 1, toolCalls: 0 };
      },
    });
    await director.spawn({ id: 'resident', name: 'Resident' });
    await director.assignInternal({ id: 'probe-1', description: 'probe', subagentId: 'resident' });

    // The spawn-armed idle tick fires while the internal task is still
    // running. Old behavior dropped retirement there, and the internal
    // completion armed nothing — the resident was stranded in the fleet
    // forever. Re-arming must keep a timer armed.
    await vi.advanceTimersByTimeAsync(50);
    release();
    await director.awaitTasks(['probe-1']);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(director.status().subagents.some((a) => a.id === 'resident')).toBe(false);
    await director.shutdown();
  });

  it('internal completion re-arms with the spawn-time idleTimeoutMs override, not the Director default', async () => {
    vi.useFakeTimers();
    // No Director-wide idle window — the ONLY bound is the per-subagent
    // override. Pins that the internal-completion re-arm reads the spawn-
    // time map entry; arming with the Director default (undefined here)
    // would leave the resident immortal.
    const director = makeDirector({ retireOnComplete: true });
    await director.spawn({ id: 'resident', name: 'Resident', idleTimeoutMs: 30 });
    await director.assignInternal({ id: 'probe-1', description: 'probe', subagentId: 'resident' });

    const [result] = await director.awaitTasks(['probe-1']);
    expect(result?.result).toBe('final answer');

    await vi.advanceTimersByTimeAsync(0);
    expect(director.status().subagents.some((a) => a.id === 'resident')).toBe(true);

    await vi.advanceTimersByTimeAsync(30);
    expect(director.status().subagents.some((a) => a.id === 'resident')).toBe(false);
    await director.shutdown();
  });

  it('non-internal completion re-arms with the spawn-time override when retire-on-complete is off', async () => {
    vi.useFakeTimers();
    // Director-wide window is far longer than the override — if completion
    // re-armed with the Director default, the configured 30ms window would
    // silently stretch to 60s after the first task.
    const director = makeDirector({ idleMs: 60_000, retireOnComplete: false });
    await director.spawn({ id: 'worker', name: 'Worker', idleTimeoutMs: 30 });
    await director.assign({ id: 'task-1', description: 'work', subagentId: 'worker' });

    const [result] = await director.awaitTasks(['task-1']);
    expect(result?.result).toBe('final answer');

    await vi.advanceTimersByTimeAsync(30);
    expect(director.status().subagents.some((a) => a.id === 'worker')).toBe(false);
    await director.shutdown();
  });
});

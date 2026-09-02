import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import { GoalRunner, createGoalRunnerFromTaskGraph } from '../../src/goal/goal-runner.js';
import type { PhaseTemplate } from '../../src/goal/types.js';
import type { WorktreeHandle, WorktreeManager } from '../../src/worktree/worktree-manager.js';

function fakeWorktrees() {
  const calls: string[] = [];
  const handles = new Map<string, WorktreeHandle>();
  const wm = {
    async allocate(ownerId: string, opts: { slugHint?: string; ownerLabel?: string } = {}) {
      calls.push(`allocate:${ownerId}`);
      const handle: WorktreeHandle = {
        id: ownerId,
        ownerId,
        ownerLabel: opts.ownerLabel ?? ownerId,
        slug: opts.slugHint ?? ownerId,
        dir: `/wt/${ownerId}`,
        branch: `wstack/ap/${ownerId}`,
        baseBranch: 'main',
        status: 'active',
        createdAt: 0,
        updatedAt: 0,
        insertions: 0,
        deletions: 0,
        files: 0,
      };
      handles.set(ownerId, handle);
      return handle;
    },
    async commitAll(handle: WorktreeHandle) {
      calls.push(`commit:${handle.ownerId}`);
      return { committed: true };
    },
    async merge(handle: WorktreeHandle) {
      calls.push(`merge:${handle.ownerId}`);
      handle.status = 'merged';
      return { ok: true };
    },
    async release(handle: WorktreeHandle, opts: { keep?: boolean } = {}) {
      calls.push(`release:${handle.ownerId}:${opts.keep ? 'keep' : 'remove'}`);
      if (!opts.keep) handles.delete(handle.ownerId);
    },
    get: (id: string) => handles.get(id),
    list: () => [...handles.values()],
  };
  return { wm: wm as never as WorktreeManager, calls };
}

function phases(): PhaseTemplate[] {
  return [
    {
      name: 'Build',
      description: 'Build the feature',
      priority: 'high',
      estimateHours: 1,
      parallelizable: false,
      taskTemplates: [
        {
          title: 'Implement feature',
          description: 'Make the change',
          type: 'feature',
          priority: 'high',
          estimateHours: 1,
        },
      ],
    },
  ];
}

describe('GoalRunner', () => {
  it('forwards worktree env and verification hooks to the orchestrator', async () => {
    const wt = fakeWorktrees();
    const taskCwds: Array<string | undefined> = [];
    const verifyCwds: Array<string | undefined> = [];

    const runner = new GoalRunner({
      title: 'Runner propagation',
      phases: phases(),
      worktrees: wt.wm,
      executeTask: async (_task, _phaseId, env) => {
        taskCwds.push(env?.cwd);
      },
      verifyPhase: async (_phase, env) => {
        verifyCwds.push(env?.cwd);
        return { ok: true };
      },
    });

    const graph = await runner.start();
    const phaseId = Array.from(graph.phases.keys())[0]!;

    expect(taskCwds).toEqual([`/wt/${phaseId}`]);
    expect(verifyCwds).toEqual([`/wt/${phaseId}`]);
    expect(wt.calls).toContain(`allocate:${phaseId}`);
    expect(wt.calls).toContain(`commit:${phaseId}`);
    expect(wt.calls).toContain(`merge:${phaseId}`);
    expect(wt.calls).toContain(`release:${phaseId}:remove`);
  });

  it('forwards maxVerifyAttempts and repairPhase', async () => {
    let verifies = 0;
    let repairs = 0;

    const runner = new GoalRunner({
      title: 'Runner repair',
      phases: phases(),
      maxVerifyAttempts: 1,
      executeTask: async () => {},
      verifyPhase: async () => {
        verifies++;
        return verifies === 1 ? { ok: false, output: 'broken' } : { ok: true };
      },
      repairPhase: async () => {
        repairs++;
      },
    });

    const graph = await runner.start();
    const phase = Array.from(graph.phases.values())[0]!;

    expect(phase.status).toBe('completed');
    expect(verifies).toBe(2);
    expect(repairs).toBe(1);
  });

  it('subscribes to a real EventBus without losing `this` (regression)', async () => {
    // Regression: the runner used `const onUntyped = events.on as never`, which
    // detached the method — calling it then threw "Cannot read properties of
    // undefined (reading 'listeners')" on a real EventBus (plain prototype
    // methods). start() must register its graph.completed/failed listeners on
    // the bus and run to completion without throwing.
    const events = new EventBus();
    const runner = new GoalRunner({
      title: 'Runner events',
      phases: phases(),
      events,
      executeTask: async () => {},
    });
    const graph = await runner.start();
    expect(Array.from(graph.phases.values())[0]!.status).toBe('completed');
  });
});

describe('GoalRunner event handlers + lifecycle', () => {
  it('graph.completed fires onComplete + cleanup', async () => {
    const events = new EventBus();
    const onComplete = vi.fn();
    const runner = new GoalRunner({
      title: 't',
      phases: phases(),
      events,
      executeTask: async () => {},
      onComplete,
    });
    const graph = await runner.start();
    (events as unknown as { emit: (t: string, p: unknown) => void }).emit('graph.completed', {
      graphId: graph.id,
      durationMs: 500,
    });
    expect(onComplete).toHaveBeenCalledWith(graph);
  });

  it('graph.failed fires onFail; stopOnFailure=true cleans up', async () => {
    const events = new EventBus();
    const onFail = vi.fn();
    const runner = new GoalRunner({
      title: 't',
      phases: phases(),
      events,
      executeTask: async () => {},
      onFail,
      stopOnFailure: true,
    });
    const graph = await runner.start();
    const phaseId = Array.from(graph.phases.keys())[0]!;
    (events as unknown as { emit: (t: string, p: unknown) => void }).emit('graph.failed', {
      graphId: graph.id,
      failedPhaseId: phaseId,
      error: 'boom',
    });
    expect(onFail).toHaveBeenCalledTimes(1);
    // cleanup ran (handler unsubscribed) — a second emit is a no-op.
    (events as unknown as { emit: (t: string, p: unknown) => void }).emit('graph.failed', {
      graphId: graph.id,
      failedPhaseId: phaseId,
      error: 'x',
    });
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('graph.failed with stopOnFailure=false does not clean up', async () => {
    const events = new EventBus();
    const onFail = vi.fn();
    const runner = new GoalRunner({
      title: 't',
      phases: phases(),
      events,
      executeTask: async () => {},
      onFail,
      stopOnFailure: false,
    });
    const graph = await runner.start();
    const phaseId = Array.from(graph.phases.keys())[0]!;
    (events as unknown as { emit: (t: string, p: unknown) => void }).emit('graph.failed', {
      graphId: graph.id,
      failedPhaseId: phaseId,
      error: 'boom',
    });
    expect(onFail).toHaveBeenCalledTimes(1);
    // not cleaned up — second emit fires onFail again.
    (events as unknown as { emit: (t: string, p: unknown) => void }).emit('graph.failed', {
      graphId: graph.id,
      failedPhaseId: phaseId,
      error: 'x',
    });
    expect(onFail).toHaveBeenCalledTimes(2);
  });

  it('ignores graph events for a different graph id', async () => {
    const events = new EventBus();
    const onComplete = vi.fn();
    const runner = new GoalRunner({
      title: 't',
      phases: phases(),
      events,
      executeTask: async () => {},
      onComplete,
    });
    await runner.start();
    (events as unknown as { emit: (t: string, p: unknown) => void }).emit('graph.completed', {
      graphId: 'other',
      durationMs: 500,
    });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('forwards phase callbacks + exposes delegate methods + stop/cleanup', async () => {
    const onPhaseComplete = vi.fn();
    const onPhaseFail = vi.fn();
    const onTick = vi.fn();
    const runner = new GoalRunner({
      title: 't',
      phases: phases(),
      executeTask: async () => {},
      verifyPhase: async () => ({ ok: false }), // force a verify failure → onPhaseFail path
      maxRetries: 0,
      maxVerifyAttempts: 0,
      onPhaseComplete,
      onPhaseFail,
      onTick,
      resolveConflict: async () => true,
    });
    const graph = await runner.start();
    const phaseId = Array.from(graph.phases.keys())[0]!;
    expect(runner.getGraph()).toBe(graph);
    expect(runner.getProgress()).toBeTruthy();
    runner.pause();
    expect(typeof runner.isPaused()).toBe('boolean');
    runner.resume();
    expect(typeof runner.isRunning()).toBe('boolean');
    runner.assignAgent(phaseId, 'agent-1');
    runner.releaseAgent(phaseId, 'agent-1');
    runner.stop();
  });

  it('maxRunDurationMs <= 0 cancels the safety-net timer immediately', async () => {
    const runner = new GoalRunner({
      title: 't',
      phases: phases(),
      executeTask: async () => {},
      maxRunDurationMs: 0,
    });
    await runner.start();
    runner.stop();
  });

  it('fires the progress interval and the max-run safety-net timer', async () => {
    vi.useFakeTimers();
    try {
      const onProgress = vi.fn();
      const runner = new GoalRunner({
        title: 't',
        phases: phases(),
        executeTask: async () => {},
        onProgress,
        maxRunDurationMs: 5_000,
      });
      await runner.start();
      // Progress interval (2s) fires first, before the 5s safety net.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onProgress).toHaveBeenCalled();
      const before = onProgress.mock.calls.length;
      // Advance past the safety-net timeout → it calls onProgress(zeros) + stop() (cleanup).
      await vi.advanceTimersByTimeAsync(4_000);
      expect(onProgress.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createGoalRunnerFromTaskGraph', () => {
  it('builds a runner from a TaskGraph (not started)', async () => {
    const taskGraph = {
      title: 'TG',
      nodes: new Map([
        [
          'n1',
          { id: 'n1', title: 'T1', description: 'd', status: 'pending', dependsOn: [] as string[] },
        ],
      ]),
      edges: [],
      rootNodes: ['n1'],
    } as never;
    const runner = await createGoalRunnerFromTaskGraph(taskGraph, { executeTask: async () => {} });
    expect(runner).toBeInstanceOf(GoalRunner);
    expect(runner.getGraph()).toBeNull(); // not started
  });
});

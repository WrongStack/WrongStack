import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoalRunner } from '../src/goal-runner.js';
import { summarizeGoal } from '../src/goal-summary.js';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseOrchestrator } from '../src/phase-orchestrator.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function graph(taskCount = 1) {
  return new PhaseGraphBuilder({
    title: 'Controls',
    phases: [
      {
        name: 'Build',
        description: '',
        priority: 'high',
        estimateHours: 1,
        parallelizable: false,
        taskTemplates: Array.from({ length: taskCount }, (_, i) => ({
          title: `Task ${i}`,
          description: '',
          type: 'chore' as const,
          priority: 'high' as const,
          estimateHours: 1,
        })),
      },
    ],
  }).build();
}

afterEach(() => vi.useRealTimers());

describe('Goal pause task admission', () => {
  it('finishes the active task, holds the next task, then resumes it', async () => {
    vi.useFakeTimers();
    const entered = deferred();
    const release = deferred();
    const completed = deferred();
    const calls: string[] = [];
    const saved = await graph(2);
    const orchestrator = new PhaseOrchestrator({
      graph: saved,
      maxConcurrentTasks: 1,
      ctx: {
        executeTask: async (task) => {
          calls.push(task.title);
          if (calls.length === 1) {
            entered.resolve();
            await release.promise;
          }
        },
        onTaskUpdate: (_phase, task) => {
          if (task.status === 'completed') completed.resolve();
        },
      },
    });
    const run = orchestrator.start();
    await entered.promise;
    orchestrator.pause();
    orchestrator.pause();
    release.resolve();
    await completed.promise;
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toEqual(['Task 0']);
    expect(orchestrator.getProgress().completedTasks).toBe(1);
    orchestrator.resume();
    await vi.advanceTimersByTimeAsync(100);
    await run;
    expect(calls).toEqual(['Task 0', 'Task 1']);
    expect(saved.completedAt).toBeDefined();
  });

  it('stop exits a paused batch without admitting the next task', async () => {
    const entered = deferred();
    const release = deferred();
    const executeTask = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const saved = await graph(2);
    const orchestrator = new PhaseOrchestrator({
      graph: saved,
      maxConcurrentTasks: 1,
      ctx: { executeTask },
    });
    const run = orchestrator.start();
    await entered.promise;
    orchestrator.pause();
    orchestrator.stop();
    release.resolve();
    await run;
    expect(executeTask).toHaveBeenCalledTimes(1);
    // The task fulfilled before the stop was processed: its completion is
    // recorded (never re-queued), while the next task is not admitted.
    expect(orchestrator.getProgress().completedTasks).toBe(1);
    expect([...saved.phases.values()][0]!.status).toBe('paused');
  });
});

describe('Goal stop fences suspended verification', () => {
  for (const gate of ['phase', 'final'] as const) {
    for (const outcome of ['pass', 'fail', 'throw'] as const) {
      it(`drops late ${outcome} from ${gate} verification`, async () => {
        const entered = deferred();
        const release = deferred();
        const events: string[] = [];
        const saved = await graph();
        const verify = async () => {
          entered.resolve();
          await release.promise;
          if (outcome === 'throw') throw new Error('late verifier error');
          return { ok: outcome === 'pass', output: 'late verdict' };
        };
        const repairPhase = vi.fn();
        const orchestrator = new PhaseOrchestrator({
          graph: saved,
          events: { emit: (event: string) => events.push(event) } as never,
          ctx: {
            executeTask: async () => {},
            repairPhase,
            ...(gate === 'phase' ? { verifyPhase: verify } : { verifyGoal: verify }),
          },
        });
        const run = orchestrator.start();
        await entered.promise;
        orchestrator.stop();
        const before = [...events];
        release.resolve();
        await run;
        expect(events).toEqual(before);
        expect(repairPhase).not.toHaveBeenCalled();
        expect(saved.completedAt).toBeUndefined();
        expect(saved.finalVerification).toBeUndefined();
        if (gate === 'phase') expect([...saved.phases.values()][0]!.status).toBe('paused');
      });
    }
  }
});

describe('Goal timed-out worker ownership', () => {
  for (const outcome of ['resolve', 'reject'] as const) {
    it(`admits a retry only after the aborted worker ${outcome}s`, async () => {
      vi.useFakeTimers();
      const entered = deferred();
      const release = deferred();
      let calls = 0;
      let firstSignal: AbortSignal | undefined;
      const saved = await graph();
      const orchestrator = new PhaseOrchestrator({
        graph: saved,
        taskTimeoutMs: 10,
        maxRetries: 1,
        ctx: {
          executeTask: async (_task, _phaseId, _env, signal) => {
            calls++;
            if (calls === 1) {
              firstSignal = signal;
              entered.resolve();
              await release.promise;
              if (outcome === 'reject') throw new Error('abort settled');
            }
          },
        },
      });
      const run = orchestrator.start();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(100);
      expect(firstSignal?.aborted).toBe(true);
      // Within the settle-grace window the aborted worker still owns the
      // run: no retry is admitted alongside it.
      expect(calls).toBe(1);
      // The grace can expire, but checkout ownership still blocks the retry
      // until the original worker settles. Stop at the grace boundary so the
      // queued retry's own timeout has not elapsed before release.
      await vi.advanceTimersByTimeAsync(4_910);
      expect(calls).toBe(1);
      release.resolve();
      await run;
      expect(calls).toBe(2);
      expect(orchestrator.getProgress().completedTasks).toBe(1);
    });
  }

  it('clears stale terminal graph/phase fields on requeueTask and invokes GoalRunner.onFail on graph-level failure (F767)', async () => {
    const saved = await graph(1);
    const orchestrator = new PhaseOrchestrator({
      graph: saved,
      ctx: {
        executeTask: async () => {},
        verifyGoal: async () => ({ ok: false, output: 'final check failed' }),
      },
    });
    await orchestrator.start();

    const phase = [...saved.phases.values()][0]!;
    const task = [...phase.taskGraph.nodes.values()][0]!;
    saved.runState = 'failed';
    saved.runError = 'Final verification failed: final check failed';

    expect(orchestrator.requeueTask(task.id)).toBe(true);
    expect(phase.completedAt).toBeUndefined();
    expect(saved.completedAt).toBeUndefined();
    expect(saved.finalVerification).toBeUndefined();
    expect(saved.runError).toBeUndefined();
    expect(saved.runState).toBeUndefined();
    expect(summarizeGoal(saved).status).toBe('stopped');
    expect(summarizeGoal(saved).blockers).toEqual([]);

    const listeners = new Map<string, Set<(p: unknown) => void>>();
    const bus = {
      emit(ev: string, p: unknown) {
        for (const h of listeners.get(ev) ?? []) h(p);
      },
      on(ev: string, h: (p: unknown) => void) {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev)!.add(h);
        return () => listeners.get(ev)!.delete(h);
      },
    };
    const onFail = vi.fn();
    const runner = new GoalRunner({
      title: 'Runner Graph Fail',
      events: bus as never,
      phases: [
        {
          name: 'P1',
          description: '',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            { title: 'T1', description: '', type: 'chore', priority: 'high', estimateHours: 1 },
          ],
        },
      ],
      executeTask: async () => {
        bus.emit('graph.failed', {
          graphId: runner.getGraph()!.id,
          failedPhaseId: '',
          error: 'graph-level failure',
        });
      },
      onFail,
    });
    await runner.start();
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('reopens completed phases on addTask/moveTask, resets moved blocked tasks to pending, clears activePhaseIds/phaseWorktrees on stop, and releases worktrees when merge throws (F42)', async () => {
    const { prepareGoalGraphForResume } = await import('../src/goal-run-lifecycle.js');
    const g = await graph(1);
    const orchestrator = new PhaseOrchestrator({
      graph: g,
      ctx: { executeTask: async () => 'done' },
    });
    await orchestrator.start();
    const phaseId = g.rootPhaseIds[0]!;
    const phase = g.phases.get(phaseId)!;
    expect(phase.status).toBe('completed');

    const addedId = orchestrator.addTask(phaseId, { title: 'Added Task' });
    expect(addedId).toBeTruthy();
    expect(phase.status).toBe('pending');
    expect(g.completedPhaseIds).not.toContain(phaseId);
    expect(g.completedAt).toBeUndefined();
    await expect(prepareGoalGraphForResume(g)).resolves.toBeUndefined();

    const moveGraph = await new PhaseGraphBuilder({
      title: 'Move Blocked',
      phases: [
        {
          name: 'P1',
          description: '',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            { title: 'T1', description: '', type: 'feature', priority: 'high', estimateHours: 1 },
            {
              title: 'T2',
              description: '',
              type: 'feature',
              priority: 'high',
              estimateHours: 1,
              dependsOn: [0],
            },
          ],
        },
        {
          name: 'P2',
          description: '',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            { title: 'T3', description: '', type: 'feature', priority: 'high', estimateHours: 1 },
          ],
        },
      ],
    }).build();
    const [p1, p2] = Array.from(moveGraph.phases.values());
    const [, t2] = Array.from(p1!.taskGraph.nodes.values());
    t2!.status = 'blocked';
    const moveOrch = new PhaseOrchestrator({
      graph: moveGraph,
      ctx: { executeTask: async () => 'done' },
    });
    expect(moveOrch.moveTask(t2!.id, p2!.id)).toBe(true);
    expect(p2!.taskGraph.nodes.get(t2!.id)?.status).toBe('pending');

    let acquireCalls = 0;
    let releaseOnMergeThrow = false;
    const stopGraph = await graph(1);
    let firstRun = true;
    const stopOrch = new PhaseOrchestrator({
      graph: stopGraph,
      worktrees: {
        async allocate(id: string) {
          acquireCalls += 1;
          return {
            id,
            dir: `/tmp/wt-${id}`,
            branch: `goal/${id}`,
            baseBranch: 'main',
            status: 'active',
            createdAt: Date.now(),
          };
        },
        async adopt(id: string, info: { dir: string; branch: string; baseBranch: string }) {
          acquireCalls += 1;
          return {
            id,
            dir: info.dir,
            branch: info.branch,
            baseBranch: info.baseBranch,
            status: 'active',
            createdAt: Date.now(),
          };
        },
        async commitAll() {
          return true;
        },
        async merge() {
          throw new Error('merge boom');
        },
        async release() {
          if (!firstRun) releaseOnMergeThrow = true;
        },
        list() {
          return [];
        },
      } as never,
      ctx: {
        executeTask: async (_t, _p, _env, sig) => {
          if (firstRun) {
            firstRun = false;
            stopOrch.stop();
            sig?.throwIfAborted();
          }
          return 'done';
        },
      },
    });
    await stopOrch.start();
    expect(stopGraph.activePhaseIds).toEqual([]);
    await stopOrch.start();
    expect(acquireCalls).toBe(2);
    expect(releaseOnMergeThrow).toBe(true);
  });
});

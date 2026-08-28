import { describe, expect, it, vi } from 'vitest';
import { PhaseGraphBuilder } from '../../src/goal/phase-graph-builder.js';
import { PhaseOrchestrator } from '../../src/goal/phase-orchestrator.js';
import type { PhaseGraph } from '../../src/goal/types.js';
import type { WorktreeHandle, WorktreeManager } from '../../src/worktree/worktree-manager.js';

async function singlePhase(): Promise<PhaseGraph> {
  return new PhaseGraphBuilder({
    title: 'Single',
    phases: [
      {
        name: 'Build',
        description: '',
        priority: 'high',
        estimateHours: 1,
        parallelizable: false,
        taskTemplates: [
          { title: 'T', description: '', type: 'feature', priority: 'high', estimateHours: 1 },
        ],
      },
    ],
  }).build();
}

async function twoPhase(): Promise<PhaseGraph> {
  return new PhaseGraphBuilder({
    title: 'Two',
    phases: [
      {
        name: 'A',
        description: '',
        priority: 'high',
        estimateHours: 1,
        parallelizable: false,
        taskTemplates: [
          { title: 'a', description: '', type: 'chore', priority: 'high', estimateHours: 1 },
        ],
      },
      {
        name: 'B',
        description: '',
        priority: 'high',
        estimateHours: 1,
        parallelizable: false,
        taskTemplates: [
          { title: 'b', description: '', type: 'chore', priority: 'high', estimateHours: 1 },
        ],
      },
    ],
  }).build();
}

/** Minimal worktree manager whose merge() rejects, to drive the mergeOne catch. */
function throwingMergeWorktrees(): WorktreeManager {
  const handles = new Map<string, WorktreeHandle>();
  return {
    async allocate(ownerId: string, o: { slugHint?: string; ownerLabel?: string } = {}) {
      const h = {
        id: ownerId,
        ownerId,
        ownerLabel: o.ownerLabel ?? ownerId,
        slug: o.slugHint ?? ownerId,
        dir: `/wt/${ownerId}`,
        branch: `b/${ownerId}`,
        baseBranch: 'main',
        status: 'active',
        createdAt: 0,
        updatedAt: 0,
        insertions: 0,
        deletions: 0,
        files: 0,
      } as WorktreeHandle;
      handles.set(ownerId, h);
      return h;
    },
    async commitAll() {
      return { committed: true };
    },
    async merge() {
      throw new Error('merge exploded');
    },
    async release() {},
    get: (id: string) => handles.get(id),
    list: () => [...handles.values()],
  } as never as WorktreeManager;
}

describe('PhaseOrchestrator — autonomous tick loop', () => {
  it('arms a tick interval in autonomous mode and stop() clears it', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      autonomous: true,
    });
    await orch.start();
    expect((orch as never as { tickInterval: unknown }).tickInterval).not.toBeNull();
    orch.stop();
    expect((orch as never as { tickInterval: unknown }).tickInterval).toBeNull();
  });

  it('tick() is a no-op when stopped or paused', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      autonomous: false,
    });
    orch.stop();
    await (orch as never as { tick: () => Promise<void> }).tick(); // stopped → early return
    orch.resume(); // clears paused, fires a tick (no running phases)
  });

  it('tick() starts a pending phase when a slot is open and completes the graph', async () => {
    const graph = await singlePhase();
    const completed: string[] = [];
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {}, onPhaseComplete: (p) => completed.push(p.id) },
      autonomous: true,
      phaseDelayMs: 1,
    });
    await (orch as never as { tick: () => Promise<void> }).tick();
    // the phase ran via tick and the graph completed → orchestrator stopped
    expect(completed.length).toBe(1);
    expect(orch.isRunning()).toBe(false);
  });

  it('tick() invokes onGraphFailed when stopOnFailure and a phase has failed', async () => {
    const graph = await twoPhase();
    const events: string[] = [];
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      autonomous: true,
      stopOnFailure: true,
      events: { emit: (e: string) => events.push(e) } as never,
    });
    const phases = Array.from(graph.phases.values());
    // phase A failed, phase B "running" (an active slot) so tick neither starts B nor completes.
    phases[0]!.status = 'failed';
    graph.failedPhaseIds.push(phases[0]!.id);
    phases[1]!.status = 'running';
    await (orch as never as { tick: () => Promise<void> }).tick();
    await (orch as { tick: () => Promise<void> }).tick();
    expect(events).toContain('graph.failed');
  });
});

describe('PhaseOrchestrator — task retry + failure', () => {
  it('fails closed when a phase has no executable tasks', async () => {
    const graph = await new PhaseGraphBuilder({
      title: 'Dynamic work',
      phases: [
        {
          name: 'Remediation',
          description: 'Added after synthesis',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    }).build();
    const events: string[] = [];
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      autonomous: false,
      events: { emit: (event: string) => events.push(event) } as never,
    });

    await orch.start();

    const phase = Array.from(graph.phases.values())[0]!;
    expect(phase.status).toBe('failed');
    expect(graph.completedPhaseIds).not.toContain(phase.id);
    expect(graph.failedPhaseIds).toContain(phase.id);
    expect(events).toContain('phase.failed');
    expect(events).not.toContain('phase.completed');
  });

  it('does not release a dependent phase after its prerequisite failed', async () => {
    const graph = await new PhaseGraphBuilder({
      title: 'Fail closed dependency graph',
      phases: [
        {
          name: 'Synthesis',
          description: '',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'Collect findings',
              description: '',
              type: 'chore',
              priority: 'high',
              estimateHours: 1,
            },
          ],
        },
        {
          name: 'Remediation',
          description: '',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'Fix verified finding',
              description: '',
              type: 'feature',
              priority: 'high',
              estimateHours: 1,
            },
          ],
        },
      ],
    }).build();
    const ran: string[] = [];
    const orch = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async (task) => {
          ran.push(task.title);
          throw new Error('synthesis failed');
        },
      },
      autonomous: false,
      maxRetries: 0,
    });

    await orch.start();

    expect(ran).toEqual(['Collect findings']);
    const phases = Array.from(graph.phases.values());
    expect(phases[0]?.status).toBe('failed');
    expect(phases[1]?.status).toBe('pending');
  });

  it('fails the phase after task failure when stopOnFailure is omitted', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {
          throw new Error('task boom');
        },
      },
      autonomous: false,
      maxRetries: 0,
    });

    await orch.start();

    const phase = Array.from(graph.phases.values())[0]!;
    const task = Array.from(phase.taskGraph.nodes.values())[0]!;
    expect(task.status).toBe('failed');
    expect(phase.status).toBe('failed');
    expect(graph.failedPhaseIds).toContain(phase.id);
  });

  it('retries a failing task up to maxRetries, then marks it failed', async () => {
    const graph = await singlePhase();
    let attempts = 0;
    const events: string[] = [];
    const orch = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {
          attempts++;
          throw new Error('task boom');
        },
      },
      autonomous: false,
      maxRetries: 1,
      events: { emit: (e: string) => events.push(e) } as never,
    });
    await orch.start();
    expect(attempts).toBe(2); // initial + 1 retry
    expect(events).toContain('phase.taskRetrying');
    expect(events).toContain('phase.taskFailed');
  });

  it('fails the phase when stopOnFailure and a task fails (no worktrees → keepWorktreeForReview early-returns)', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {
          throw new Error('boom');
        },
      },
      autonomous: false,
      maxRetries: 0,
      stopOnFailure: true,
    });
    await orch.start();
    const phase = Array.from(graph.phases.values())[0]!;
    expect(phase.status).toBe('failed');
  });
});

describe('PhaseOrchestrator — phase-level error + verify edge cases', () => {
  it('catches an error thrown inside startPhase and marks the phase failed', async () => {
    const graph = await singlePhase();
    const onPhaseFail = vi.fn();
    // An events bus that throws on phase.allTasksDone forces the startPhase try/catch.
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {}, onPhaseFail },
      autonomous: false,
      events: {
        emit: (e: string) => {
          if (e === 'phase.allTasksDone') throw new Error('emit boom');
        },
      } as never,
    });
    await orch.start();
    const phase = Array.from(graph.phases.values())[0]!;
    expect(phase.status).toBe('failed');
    expect(onPhaseFail).toHaveBeenCalled();
  });

  it('treats a thrown verifyPhase as a failed verdict', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {},
        verifyPhase: async () => {
          throw new Error('verifier crashed');
        },
      },
      autonomous: false,
      maxVerifyAttempts: 0,
    });
    await orch.start();
    const phase = Array.from(graph.phases.values())[0]!;
    expect(phase.status).toBe('failed');
  });

  it('records merge_failed metadata when the worktree merge throws', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      worktrees: throwingMergeWorktrees(),
      autonomous: false,
    });
    await orch.start();
    const phase = Array.from(graph.phases.values())[0]!;
    expect(phase.metadata?.integrationStatus).toBe('merge_failed');
  });

  it('resumes an interrupted graph: a running phase + in_progress task become runnable', async () => {
    // Simulate a graph reloaded after a crash mid-run: the phase was left
    // `running` and its task `in_progress`, with a stale active id. A fresh
    // orchestrator must normalize this so the stuck task actually runs and the
    // phase completes (rather than stalling — the scheduler only runs `pending`).
    const graph = await singlePhase();
    const phase = Array.from(graph.phases.values())[0]!;
    phase.status = 'running';
    graph.activePhaseIds = [phase.id];
    const task = Array.from(phase.taskGraph.nodes.values())[0]!;
    task.status = 'in_progress';

    const ran: string[] = [];
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async (t) => void ran.push(t.id) },
      autonomous: false,
    });
    await orch.start();

    expect(ran).toContain(task.id);
    expect(phase.status).toBe('completed');
  });

  it('does not re-run already-completed tasks on resume', async () => {
    // A phase reloaded with its only task already `completed` should finish
    // immediately without re-executing it.
    const graph = await singlePhase();
    const phase = Array.from(graph.phases.values())[0]!;
    const task = Array.from(phase.taskGraph.nodes.values())[0]!;
    task.status = 'completed';

    const ran: string[] = [];
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async (t) => void ran.push(t.id) },
      autonomous: false,
    });
    await orch.start();

    expect(ran).toEqual([]); // completed work is never re-run
    expect(phase.status).toBe('completed');
  });

  it('a failed merge corrects the graph: phase becomes failed, not falsely completed', async () => {
    const graph = await singlePhase();
    const failedPhases: string[] = [];
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {}, onPhaseFail: (p) => failedPhases.push(p.id) },
      worktrees: throwingMergeWorktrees(),
      autonomous: false,
    });
    await orch.start();
    const phase = Array.from(graph.phases.values())[0]!;
    // The phase's work never reached base, so it must not read as completed.
    expect(phase.status).toBe('failed');
    expect(graph.failedPhaseIds).toContain(phase.id);
    expect(graph.completedPhaseIds).not.toContain(phase.id);
    expect(failedPhases).toContain(phase.id); // onPhaseFail fired (host persists on this)
  });
});

describe('PhaseOrchestrator — accessors + noop event bus', () => {
  it('exposes getGraph/getProgress/isRunning and a usable no-op event bus', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      autonomous: false,
    });
    expect(orch.getGraph()).toBe(graph);
    expect(orch.isRunning()).toBe(false);

    // Exercise every method on the auto-created no-op EventBus (no `events` passed).
    const bus = (orch as never as { events: Record<string, (...a: unknown[]) => unknown> }).events;
    expect(bus.emit('x', {})).toBeUndefined();
    expect(typeof bus.on('x', () => {})).toBe('function');
    expect(bus.off('x', () => {})).toBeUndefined();
    expect(typeof bus.once('x', () => {})).toBe('function');
    expect(bus.setLogger(undefined)).toBeUndefined();
    expect(typeof bus.onAny(() => {})).toBe('function');
    expect(bus.offAny(() => {})).toBeUndefined();
    await expect(bus.emitAsync('x', {})).resolves.toEqual([]);
    await expect(bus.waitFor('x')).resolves.toBeUndefined();
  });

  it('reports isRunning true while a phase is active', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      autonomous: false,
    });
    const phase = Array.from(graph.phases.values())[0]!;
    phase.status = 'running';
    (orch as never as { runningPhases: Set<string> }).runningPhases.add(phase.id);
    expect(orch.isRunning()).toBe(true);
  });

  it('counts every phase status bucket in getProgress', async () => {
    const graph = await twoPhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      autonomous: false,
    });
    const [a, b] = Array.from(graph.phases.values());
    orch.getProgress(); // both phases pending → pending bucket
    a!.status = 'ready';
    b!.status = 'running';
    orch.getProgress();
    a!.status = 'paused';
    b!.status = 'failed';
    orch.getProgress();
    a!.status = 'skipped';
    b!.status = 'weird-status' as never;
    const prog = orch.getProgress();
    expect(prog.skipped).toBe(1);
  });

  it('assignAgent/releaseAgent ignore an unknown phase id', () => {
    const orch = new PhaseOrchestrator({
      graph: {
        phases: new Map(),
        id: 'g',
        activePhaseIds: [],
        completedPhaseIds: [],
        failedPhaseIds: [],
      } as never,
      ctx: { executeTask: async () => {} },
      autonomous: false,
    });
    expect(() => orch.assignAgent('nope', 'a')).not.toThrow();
    expect(() => orch.releaseAgent('nope', 'a')).not.toThrow();
  });
});

describe('PhaseOrchestrator — start/stop lifecycle edges', () => {
  it('breaks out of the start loop when stopped while paused', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      autonomous: false,
    });
    orch.pause();
    const run = orch.start();
    await new Promise((r) => setTimeout(r, 20)); // let start() block in waitWhilePaused
    orch.stop();
    await run; // exits via the `if (this.stopped) break` after waitWhilePaused
    expect(orch.isRunning()).toBe(false);
  });

  it('leaves no autonomous tick interval behind when stop() lands during start()', async () => {
    const graph = await singlePhase();
    // Hold start() at a deterministic awaited seam: executeTask() returns a
    // promise that only resolves after stop() has already landed, so the
    // interval-install tail of start() genuinely runs with stopped=true.
    let releaseTask: () => void = () => {};
    let taskStarted = false;
    const taskBlocked = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const orch = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: () => {
          taskStarted = true;
          return taskBlocked;
        },
      },
      autonomous: true,
    });
    const run = orch.start();
    await vi.waitFor(() => expect(taskStarted).toBe(true)); // start() blocked at the task seam
    orch.stop();
    releaseTask();
    await run;
    expect(
      (orch as never as { tickInterval: ReturnType<typeof setInterval> | null }).tickInterval,
    ).toBeNull();
    expect(orch.isRunning()).toBe(false);
  });

  it('applies a phase delay between batches in start()', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      autonomous: false,
      phaseDelayMs: 2,
    });
    await orch.start();
    expect(Array.from(graph.phases.values())[0]!.status).toBe('completed');
  });

  it('stop() releases live worktrees with keep=true', async () => {
    const graph = await singlePhase();
    const released: Array<{ keep?: boolean }> = [];
    const handle = {
      id: 'h',
      ownerId: 'h',
      dir: '/wt/h',
      branch: 'b',
      status: 'active',
    } as WorktreeHandle;
    const wm = {
      list: () => [handle],
      release: async (_h: WorktreeHandle, o: { keep?: boolean } = {}) => {
        released.push(o);
      },
    } as never as WorktreeManager;
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      worktrees: wm,
      autonomous: false,
    });
    const phase = Array.from(graph.phases.values())[0]!;
    phase.status = 'running';
    (orch as never as { runningPhases: Set<string> }).runningPhases.add(phase.id);
    orch.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(released).toEqual([{ keep: true }]);
    expect(phase.status).toBe('paused');
  });

  it('startPhase returns early for a phase that is neither pending nor ready', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      autonomous: false,
    });
    const phase = Array.from(graph.phases.values())[0]!;
    phase.status = 'completed';
    await (orch as never as { startPhase: (p: unknown) => Promise<void> }).startPhase(phase);
    expect(phase.status).toBe('completed'); // untouched
  });

  it('runVerifyGate bails immediately when the orchestrator is stopped', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {}, verifyPhase: async () => ({ ok: true }) },
      autonomous: false,
    });
    (orch as never as { stopped: boolean }).stopped = true;
    const phase = Array.from(graph.phases.values())[0]!;
    const verdict = await (
      orch as never as { runVerifyGate: (p: unknown) => Promise<{ ok: boolean }> }
    ).runVerifyGate(phase);
    expect(verdict.ok).toBe(false);
  });
});

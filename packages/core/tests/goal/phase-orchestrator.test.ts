import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import { PhaseGraphBuilder } from '../../src/goal/phase-graph-builder.js';
import { PhaseOrchestrator } from '../../src/goal/phase-orchestrator.js';
import type { PhaseExecutionContext, PhaseGraph } from '../../src/goal/types.js';
import type { TaskNode } from '../../src/types/task-graph.js';
import type { WorktreeHandle, WorktreeManager } from '../../src/worktree/worktree-manager.js';

/**
 * Records every call and hands out one active handle per owner. `conflictOn`
 * forces `merge()` to report a conflict for matching slug hints.
 */
function fakeWorktrees(opts: { conflictOn?: (label: string) => boolean } = {}) {
  const calls: string[] = [];
  const handles = new Map<string, WorktreeHandle>();
  let liveMerges = 0;
  let maxLiveMerges = 0;
  const wm = {
    async allocate(ownerId: string, o: { slugHint?: string; ownerLabel?: string } = {}) {
      calls.push(`allocate:${ownerId}`);
      const h: WorktreeHandle = {
        id: ownerId,
        ownerId,
        ownerLabel: o.ownerLabel ?? ownerId,
        slug: o.slugHint ?? ownerId,
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
      handles.set(ownerId, h);
      return h;
    },
    async commitAll(h: WorktreeHandle) {
      calls.push(`commit:${h.ownerId}`);
      return { committed: true };
    },
    async merge(
      h: WorktreeHandle,
      mergeOpts: {
        resolve?: (info: { conflictFiles: string[]; cwd: string }) => Promise<boolean>;
      } = {},
    ) {
      liveMerges++;
      maxLiveMerges = Math.max(maxLiveMerges, liveMerges);
      await new Promise((r) => setTimeout(r, 5));
      liveMerges--;
      const conflict = opts.conflictOn?.(h.slug) ?? false;
      if (conflict && mergeOpts.resolve) {
        const ok = await mergeOpts.resolve({ conflictFiles: ['x.ts'], cwd: '/proj' });
        if (ok) {
          calls.push(`merge:${h.ownerId}:resolved`);
          h.status = 'merged';
          return { ok: true, resolved: true, conflictFiles: ['x.ts'] };
        }
      }
      calls.push(`merge:${h.ownerId}:${conflict ? 'conflict' : 'ok'}`);
      if (conflict) h.status = 'needs-review';
      return { ok: !conflict, conflict, conflictFiles: conflict ? ['x.ts'] : [] };
    },
    async release(h: WorktreeHandle, o: { keep?: boolean } = {}) {
      calls.push(`release:${h.ownerId}:${o.keep ? 'keep' : 'remove'}`);
      if (!o.keep) handles.delete(h.ownerId);
    },
    get: (id: string) => handles.get(id),
    list: () => [...handles.values()],
  };
  return {
    wm: wm as never as WorktreeManager,
    calls,
    get maxLiveMerges() {
      return maxLiveMerges;
    },
  };
}

describe('PhaseOrchestrator', () => {
  async function buildGraph(): Promise<PhaseGraph> {
    const builder = new PhaseGraphBuilder({
      title: 'Test Orchestrator',
      phases: [
        {
          name: 'Setup',
          description: 'Setup phase',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'Task 1',
              description: 'First task',
              type: 'chore',
              priority: 'high',
              estimateHours: 0.5,
            },
            {
              title: 'Task 2',
              description: 'Second task',
              type: 'chore',
              priority: 'medium',
              estimateHours: 0.5,
            },
          ],
        },
        {
          name: 'Build',
          description: 'Build phase',
          priority: 'critical',
          estimateHours: 2,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'Task 3',
              description: 'Third task',
              type: 'feature',
              priority: 'critical',
              estimateHours: 1,
            },
          ],
        },
      ],
    });
    return builder.build();
  }

  it('should start root phase and mark it running', async () => {
    const graph = await buildGraph();
    const executedTasks: string[] = [];

    const ctx: PhaseExecutionContext = {
      executeTask: async (task: TaskNode) => {
        executedTasks.push(task.title);
        await new Promise((r) => setTimeout(r, 10));
      },
    };

    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx,
      autonomous: false,
      maxConcurrentTasks: 2,
    });

    await orchestrator.start();

    const phases = Array.from(graph.phases.values());
    expect(phases[0]!.status).toBe('completed');
    expect(phases[1]!.status).toBe('completed');
    expect(executedTasks).toContain('Task 1');
    expect(executedTasks).toContain('Task 2');
    expect(executedTasks).toContain('Task 3');
  });

  it('should calculate progress correctly', async () => {
    const graph = await buildGraph();

    const ctx: PhaseExecutionContext = {
      executeTask: async () => {
        await new Promise((r) => setTimeout(r, 10));
      },
    };

    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx,
      autonomous: false,
    });

    await orchestrator.start();

    const progress = orchestrator.getProgress();
    expect(progress.totalPhases).toBe(2);
    expect(progress.completed).toBe(2);
    expect(progress.percentComplete).toBe(100);
    expect(progress.totalTasks).toBe(3);
    expect(progress.completedTasks).toBe(3);
  });

  it('should support pause and resume', async () => {
    const graph = await buildGraph();

    const ctx: PhaseExecutionContext = {
      executeTask: async () => {
        await new Promise((r) => setTimeout(r, 10));
      },
    };

    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx,
      autonomous: false,
    });

    orchestrator.pause();
    expect(orchestrator.isPaused()).toBe(true);

    orchestrator.resume();
    expect(orchestrator.isPaused()).toBe(false);
  });

  it('does not start the next phase while paused', async () => {
    const graph = await buildGraph();
    const phases = Array.from(graph.phases.values());
    const first = phases[0]!;
    const second = phases[1]!;
    const started: string[] = [];

    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async (_task, phaseId) => {
          started.push(phaseId);
        },
        onPhaseComplete: (phase) => {
          if (phase.id === first.id) orchestrator.pause();
        },
      },
      autonomous: false,
    });

    const run = orchestrator.start();
    await new Promise((r) => setTimeout(r, 150));

    expect(first.status).toBe('completed');
    expect(second.status).toBe('pending');
    expect(started).not.toContain(second.id);

    orchestrator.resume();
    await run;

    expect(second.status).toBe('completed');
  });

  it('should assign and release agents', async () => {
    const graph = await buildGraph();
    const phase = Array.from(graph.phases.values())[0]!;

    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      autonomous: false,
    });

    orchestrator.assignAgent(phase.id, 'agent-1');
    expect(phase.assignedAgents).toContain('agent-1');

    orchestrator.releaseAgent(phase.id, 'agent-1');
    expect(phase.assignedAgents).not.toContain('agent-1');
  });
});

describe('PhaseOrchestrator + worktrees', () => {
  async function buildGraph(): Promise<PhaseGraph> {
    return new PhaseGraphBuilder({
      title: 'WT Test',
      phases: [
        {
          name: 'Setup',
          description: '',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            { title: 'T1', description: '', type: 'chore', priority: 'high', estimateHours: 0.5 },
          ],
        },
        {
          name: 'Build',
          description: '',
          priority: 'critical',
          estimateHours: 2,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'T2',
              description: '',
              type: 'feature',
              priority: 'critical',
              estimateHours: 1,
            },
          ],
        },
      ],
    }).build();
  }

  it('allocates one worktree per phase and runs tasks in its dir', async () => {
    const graph = await buildGraph();
    const wt = fakeWorktrees();
    const seenCwds: Array<string | undefined> = [];

    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async (_t, _p, env) => {
          seenCwds.push(env?.cwd);
        },
      },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const phaseIds = Array.from(graph.phases.values()).map((p) => p.id);
    for (const id of phaseIds) expect(wt.calls).toContain(`allocate:${id}`);
    // each task ran with a worktree dir, never the shared (undefined) tree
    expect(seenCwds.every((c) => typeof c === 'string' && c.startsWith('/wt/'))).toBe(true);
  });

  it('commits then merges then removes the worktree on clean completion', async () => {
    const graph = await buildGraph();
    const wt = fakeWorktrees();
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const firstPhase = Array.from(graph.phases.values())[0]!;
    const first = firstPhase.id;
    const order = wt.calls.filter((c) => c.includes(first));
    expect(order).toEqual([
      `allocate:${first}`,
      `commit:${first}`,
      `merge:${first}:ok`,
      `release:${first}:remove`,
    ]);
    expect(firstPhase.metadata?.integrationStatus).toBe('merged');
    expect(firstPhase.metadata?.integrationBranch).toBe(`wstack/ap/${first}`);
  });

  it('a merge conflict keeps the worktree and does NOT fail the run', async () => {
    const graph = await buildGraph();
    const firstName = Array.from(graph.phases.values())[0]!.name;
    const wt = fakeWorktrees({ conflictOn: (slug) => slug === firstName });
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const phases = Array.from(graph.phases.values());
    // run completes; phases are not marked failed by a worktree conflict
    expect(phases.every((p) => p.status === 'completed')).toBe(true);
    const firstPhase = phases[0]!;
    const first = firstPhase.id;
    expect(wt.calls).toContain(`merge:${first}:conflict`);
    expect(wt.calls).toContain(`release:${first}:keep`);
    expect(firstPhase.metadata?.integrationStatus).toBe('needs_review');
    expect(firstPhase.metadata?.integrationConflictFiles).toEqual(['x.ts']);
  });

  it('serializes merges even when phases run in parallel', async () => {
    // two parallelizable phases, concurrency 2 → distinct worktrees, serial merge
    const graph = await new PhaseGraphBuilder({
      title: 'Parallel',
      phases: [
        {
          name: 'A',
          description: '',
          priority: 'high',
          estimateHours: 1,
          parallelizable: true,
          taskTemplates: [
            { title: 'a', description: '', type: 'chore', priority: 'high', estimateHours: 0.5 },
          ],
        },
        {
          name: 'B',
          description: '',
          priority: 'high',
          estimateHours: 1,
          parallelizable: true,
          taskTemplates: [
            { title: 'b', description: '', type: 'chore', priority: 'high', estimateHours: 0.5 },
          ],
        },
      ],
    }).build();
    const wt = fakeWorktrees();
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {
          await new Promise((r) => setTimeout(r, 5));
        },
      },
      worktrees: wt.wm,
      autonomous: false,
      maxConcurrentPhases: 2,
    });
    await orchestrator.start();

    expect(wt.maxLiveMerges).toBe(1); // never two merges touching base at once
  });

  it('does not start a parallelizable phase before its dependency completes (regression)', async () => {
    // Regression for the `depsDone || phase.parallelizable` readiness bug: a
    // parallelizable phase that DEPENDS on an earlier phase (e.g. Testing after
    // Implementation) must still wait for that dependency — `parallelizable`
    // only governs concurrency, not dependency bypass. The builder chains phases
    // sequentially, so B.dependsOn = [A].
    const graph = await new PhaseGraphBuilder({
      title: 'Dep',
      phases: [
        {
          name: 'A',
          description: '',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            { title: 'a', description: '', type: 'chore', priority: 'high', estimateHours: 0.5 },
          ],
        },
        {
          name: 'B',
          description: '',
          priority: 'high',
          estimateHours: 1,
          parallelizable: true, // would have jumped its dependency under the old code
          taskTemplates: [
            { title: 'b', description: '', type: 'chore', priority: 'high', estimateHours: 0.5 },
          ],
        },
      ],
    }).build();

    const events: string[] = [];
    let aDone = false;
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async (task: TaskNode) => {
          events.push(`start:${task.title}`);
          if (task.title === 'b') expect(aDone).toBe(true); // B only after A finished
          await new Promise((r) => setTimeout(r, 5));
          if (task.title === 'a') aDone = true;
          events.push(`done:${task.title}`);
        },
      },
      autonomous: false,
      maxConcurrentPhases: 2, // concurrency allowed; the dependency must still serialize A→B
    });
    await orchestrator.start();

    expect(events).toEqual(['start:a', 'done:a', 'start:b', 'done:b']);
  });

  it('is backward compatible with a 1-arg executeTask and no worktrees', async () => {
    const graph = await buildGraph();
    let count = 0;
    const ctx: PhaseExecutionContext = {
      executeTask: async () => {
        count++;
      },
    };
    const orchestrator = new PhaseOrchestrator({ graph, ctx, autonomous: false });
    await orchestrator.start();
    expect(count).toBe(2);
    expect(Array.from(graph.phases.values()).every((p) => p.status === 'completed')).toBe(true);
  });
});

describe('PhaseOrchestrator + verify gate', () => {
  async function singlePhaseGraph(): Promise<PhaseGraph> {
    return new PhaseGraphBuilder({
      title: 'Verify',
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

  it('merges the phase when verification passes', async () => {
    const graph = await singlePhaseGraph();
    const wt = fakeWorktrees();
    let verifies = 0;
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {},
        verifyPhase: async () => {
          verifies++;
          return { ok: true };
        },
      },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const phase = Array.from(graph.phases.values())[0]!;
    expect(verifies).toBe(1);
    expect(phase.status).toBe('completed');
    expect(wt.calls).toContain(`merge:${phase.id}:ok`);
  });

  it('repairs and re-verifies when the first verification fails, then merges', async () => {
    const graph = await singlePhaseGraph();
    const wt = fakeWorktrees();
    let verifies = 0;
    let repairs = 0;
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {},
        verifyPhase: async () => {
          verifies++;
          return verifies === 1 ? { ok: false, output: 'TS2304: cannot find name' } : { ok: true };
        },
        repairPhase: async () => {
          repairs++;
        },
      },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const phase = Array.from(graph.phases.values())[0]!;
    expect(repairs).toBe(1);
    expect(verifies).toBe(2);
    expect(phase.status).toBe('completed');
    expect(wt.calls).toContain(`merge:${phase.id}:ok`);
  });

  it('fails the phase and never merges when verification never passes', async () => {
    const graph = await singlePhaseGraph();
    const wt = fakeWorktrees();
    let repairs = 0;
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {},
        verifyPhase: async () => ({ ok: false, output: 'still broken' }),
        repairPhase: async () => {
          repairs++;
        },
      },
      worktrees: wt.wm,
      autonomous: false,
      maxVerifyAttempts: 2,
    });
    await orchestrator.start();

    const phase = Array.from(graph.phases.values())[0]!;
    expect(phase.status).toBe('failed');
    expect(repairs).toBe(2); // one repair per failed attempt, up to maxVerifyAttempts
    // broken code is never merged; the worktree is kept for review
    expect(wt.calls.some((c) => c.startsWith(`merge:${phase.id}`))).toBe(false);
    expect(wt.calls).toContain(`release:${phase.id}:keep`);
    expect(phase.metadata?.integrationStatus).toBe('not_merged_failed_phase');
  });

  it('skips the gate entirely when no verifyPhase is wired (back-compat)', async () => {
    const graph = await singlePhaseGraph();
    const wt = fakeWorktrees();
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const phase = Array.from(graph.phases.values())[0]!;
    expect(phase.status).toBe('completed');
    expect(wt.calls).toContain(`merge:${phase.id}:ok`);
  });
});

describe('PhaseOrchestrator + conflict resolution', () => {
  async function singlePhaseGraph(): Promise<PhaseGraph> {
    return new PhaseGraphBuilder({
      title: 'Conflict',
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

  it('resolves a merge conflict via ctx.resolveConflict instead of parking the phase', async () => {
    const graph = await singlePhaseGraph();
    const name = Array.from(graph.phases.values())[0]!.name;
    const wt = fakeWorktrees({ conflictOn: (slug) => slug === name });
    let resolves = 0;
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {},
        resolveConflict: async () => {
          resolves++;
          return true;
        },
      },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const phase = Array.from(graph.phases.values())[0]!;
    expect(resolves).toBe(1);
    expect(phase.status).toBe('completed');
    expect(wt.calls).toContain(`merge:${phase.id}:resolved`);
    expect(wt.calls).toContain(`release:${phase.id}:remove`);
    expect(phase.metadata?.integrationStatus).toBe('merged');
  });

  it('parks the worktree for review when conflict resolution fails (run still completes)', async () => {
    const graph = await singlePhaseGraph();
    const name = Array.from(graph.phases.values())[0]!.name;
    const wt = fakeWorktrees({ conflictOn: (slug) => slug === name });
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {},
        resolveConflict: async () => false,
      },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const phase = Array.from(graph.phases.values())[0]!;
    // a merge conflict never fails the phase itself — work is parked, run continues
    expect(phase.status).toBe('completed');
    expect(wt.calls).toContain(`merge:${phase.id}:conflict`);
    expect(wt.calls).toContain(`release:${phase.id}:keep`);
    expect(phase.metadata?.integrationStatus).toBe('needs_review');
    expect(phase.metadata?.integrationConflictFiles).toEqual(['x.ts']);
  });

  it('asks Brain before attempting conflict resolution and parks when Brain does not answer resolve', async () => {
    const graph = await singlePhaseGraph();
    const name = Array.from(graph.phases.values())[0]!.name;
    const wt = fakeWorktrees({ conflictOn: (slug) => slug === name });
    let brainCalls = 0;
    let resolves = 0;
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {},
        brain: {
          decide: async () => {
            brainCalls++;
            return { type: 'ask_human', prompt: 'Need human decision' };
          },
        },
        resolveConflict: async () => {
          resolves++;
          return true;
        },
      },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const phase = Array.from(graph.phases.values())[0]!;
    expect(brainCalls).toBe(1);
    expect(resolves).toBe(0);
    expect(phase.metadata?.brainConflictDecision).toBe('ask_human');
    expect(phase.metadata?.integrationStatus).toBe('needs_review');
    expect(wt.calls).toContain(`release:${phase.id}:keep`);
  });

  it('attempts conflict resolution when Brain answers with the resolve option', async () => {
    const graph = await singlePhaseGraph();
    const name = Array.from(graph.phases.values())[0]!.name;
    const wt = fakeWorktrees({ conflictOn: (slug) => slug === name });
    let resolves = 0;
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {},
        brain: {
          decide: async () => ({ type: 'answer', optionId: 'resolve', text: 'Try resolver' }),
        },
        resolveConflict: async () => {
          resolves++;
          return true;
        },
      },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const phase = Array.from(graph.phases.values())[0]!;
    expect(resolves).toBe(1);
    expect(phase.metadata?.brainConflictDecision).toBe('answer');
    expect(phase.metadata?.integrationStatus).toBe('merged');
    expect(wt.calls).toContain(`merge:${phase.id}:resolved`);
  });
});

describe('PhaseOrchestrator — interactive board mutations', () => {
  async function buildTwoPhaseGraph(): Promise<PhaseGraph> {
    return new PhaseGraphBuilder({
      title: 'Board Mutations',
      phases: [
        {
          name: 'Alpha',
          description: 'first',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            { title: 'A1', description: 'a1', type: 'chore', priority: 'high', estimateHours: 0.5 },
            { title: 'A2', description: 'a2', type: 'chore', priority: 'low', estimateHours: 0.5 },
          ],
        },
        {
          name: 'Beta',
          description: 'second',
          priority: 'medium',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            { title: 'B1', description: 'b1', type: 'feature', priority: 'medium', estimateHours: 1 },
          ],
        },
      ],
    }).build();
  }

  function makeIdle(graph: PhaseGraph, events?: EventBus): PhaseOrchestrator {
    const ctx: PhaseExecutionContext = { executeTask: async () => {} };
    return new PhaseOrchestrator({ graph, ctx, autonomous: false, events });
  }

  function phaseByName(graph: PhaseGraph, name: string) {
    return Array.from(graph.phases.values()).find((p) => p.name === name)!;
  }
  function taskByTitle(graph: PhaseGraph, title: string) {
    for (const p of graph.phases.values()) {
      for (const n of p.taskGraph.nodes.values()) if (n.title === title) return n;
    }
    throw new Error(`task ${title} not found`);
  }

  it('moveTask relocates a task to the target phase and emits an event', async () => {
    const graph = await buildTwoPhaseGraph();
    const events = new EventBus();
    const moved: Array<{ taskId: string; fromPhaseId: string; toPhaseId: string }> = [];
    (events.on as (e: string, h: (p: unknown) => void) => void)('phase.taskMoved', (p) =>
      moved.push(p as { taskId: string; fromPhaseId: string; toPhaseId: string }),
    );
    const orch = makeIdle(graph, events);
    const alpha = phaseByName(graph, 'Alpha');
    const beta = phaseByName(graph, 'Beta');
    const a2 = taskByTitle(graph, 'A2');

    const ok = orch.moveTask(a2.id, beta.id);

    expect(ok).toBe(true);
    expect(alpha.taskGraph.nodes.has(a2.id)).toBe(false);
    expect(beta.taskGraph.nodes.has(a2.id)).toBe(true);
    expect(beta.taskGraph.rootNodes).toContain(a2.id);
    expect(moved).toEqual([{ taskId: a2.id, fromPhaseId: alpha.id, toPhaseId: beta.id }]);
  });

  it('moveTask is a no-op for unknown task or same phase', async () => {
    const graph = await buildTwoPhaseGraph();
    const orch = makeIdle(graph);
    const alpha = phaseByName(graph, 'Alpha');
    const a1 = taskByTitle(graph, 'A1');
    expect(orch.moveTask('nope', alpha.id)).toBe(false);
    expect(orch.moveTask(a1.id, alpha.id)).toBe(false);
  });

  it('setTaskAssignee writes the assignee onto the node', async () => {
    const graph = await buildTwoPhaseGraph();
    const orch = makeIdle(graph);
    const a1 = taskByTitle(graph, 'A1');
    expect(orch.setTaskAssignee(a1.id, undefined, 'Einstein')).toBe(true);
    expect(taskByTitle(graph, 'A1').assignee).toBe('Einstein');
  });

  it('addTask appends a pending task and returns its id', async () => {
    const graph = await buildTwoPhaseGraph();
    const orch = makeIdle(graph);
    const beta = phaseByName(graph, 'Beta');
    const before = beta.taskGraph.nodes.size;
    const id = orch.addTask(beta.id, { title: 'B2', priority: 'high', type: 'test' });
    expect(id).toBeTruthy();
    expect(beta.taskGraph.nodes.size).toBe(before + 1);
    const node = beta.taskGraph.nodes.get(id!)!;
    expect(node.status).toBe('pending');
    expect(node.title).toBe('B2');
    expect(orch.addTask('missing-phase', { title: 'x' })).toBeNull();
  });

  it('requeueTask resets a failed phase to pending so it reruns', async () => {
    const graph = await buildTwoPhaseGraph();
    const orch = makeIdle(graph);
    const alpha = phaseByName(graph, 'Alpha');
    const a1 = taskByTitle(graph, 'A1');
    // Simulate a finished/failed phase with a failed task.
    alpha.status = 'failed';
    graph.failedPhaseIds.push(alpha.id);
    const tracker = (
      orch as never as {
        getTrackerForPhase: (p: typeof alpha) => { updateNodeStatus: (id: string, s: string) => void };
      }
    ).getTrackerForPhase(alpha);
    tracker.updateNodeStatus(a1.id, 'failed');

    expect(orch.requeueTask(a1.id)).toBe(true);
    expect(alpha.status).toBe('pending');
    expect(graph.failedPhaseIds).not.toContain(alpha.id);
    expect(taskByTitle(graph, 'A1').status).toBe('pending');
  });

  it('emits phase.taskStarted when a task begins executing', async () => {
    const graph = await buildTwoPhaseGraph();
    const events = new EventBus();
    const started: string[] = [];
    (events.on as (e: string, h: (p: unknown) => void) => void)('phase.taskStarted', (p) =>
      started.push((p as { taskTitle: string }).taskTitle),
    );
    const ctx: PhaseExecutionContext = { executeTask: async () => {} };
    const orch = new PhaseOrchestrator({ graph, ctx, autonomous: false, events });
    await orch.start();
    expect(started).toEqual(expect.arrayContaining(['A1', 'A2', 'B1']));
  });

  // ─── stop()/timeout abort plumbing (signal regression tests) ──────────────

  /** Self-contained single-phase/one-task graph (this describe has no buildGraph). */
  async function buildSignalGraph(): Promise<PhaseGraph> {
    const builder = new PhaseGraphBuilder({
      title: 'Signal Regression',
      phases: [
        {
          name: 'Only',
          description: 'Only phase',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'S1',
              description: 'first',
              type: 'chore',
              priority: 'high',
              estimateHours: 0.5,
            },
          ],
        },
      ],
    });
    return builder.build();
  }

  it('stop() aborts in-flight task executions and leaves the phase resumable', async () => {
    const graph = await buildSignalGraph();
    let taskStarted = false;
    let abortObserved = false;
    let capturedTask: TaskNode | undefined;

    // Signal-honoring implementor: the execution hangs forever on its own and
    // only settles when the orchestrator aborts it — the worst case stop()
    // must handle. Before the signal existed, this run never settled and
    // start() hung with the phase stuck between running and worktree release.
    const ctx: PhaseExecutionContext = {
      executeTask: (task, _phaseId, _env, signal) =>
        new Promise((_resolve, reject) => {
          // executeSingleTask hands us the live graph node; capturing it lets
          // the test assert the node-level reset below.
          capturedTask = task;
          taskStarted = true;
          signal?.addEventListener(
            'abort',
            () => {
              abortObserved = true;
              reject(new Error('aborted by stop()'));
            },
            { once: true },
          );
        }),
    };

    const orch = new PhaseOrchestrator({ graph, ctx, autonomous: false });
    const runPromise = orch.start();
    for (let i = 0; i < 100 && !taskStarted; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(taskStarted).toBe(true);

    orch.stop();
    await runPromise; // must settle instead of hanging on the aborted batch

    expect(abortObserved).toBe(true);
    const phases = Array.from(graph.phases.values());
    // Stopped mid-flight: not completed (no merge of aborted work), still
    // 'paused' so a resume can re-run the interrupted tasks.
    expect(phases[0]!.status).toBe('paused');
    expect(phases[0]!.status).not.toBe('completed');
    // The actual resumability mechanism: markTaskFailed's stop path resets the
    // aborted node itself to 'pending' (without burning a retry), so a later
    // start() re-runs it via getExecutableTasks instead of skipping it as
    // 'in_progress' forever.
    expect(capturedTask).toBeDefined();
    expect(capturedTask!.status).toBe('pending');
  });

  it('a timed-out task settles before its retry starts (no duplicate concurrent instance)', async () => {
    const graph = await buildSignalGraph();
    let calls = 0;
    let aborts = 0;
    let live = 0;
    let maxLive = 0;
    /** Ordered lifecycle events: 'call-N:start' | 'call-N:aborted' | 'call-N:settled'. */
    const events: string[] = [];

    // Signal-honoring implementor that would run 400ms on its own — far past
    // the 50ms timeout — and, critically, does NOT settle synchronously on
    // abort: it acknowledges the abort but takes another 60ms to actually
    // settle. A double that settles instantly on abort cannot distinguish
    // "retry waited for settlement" from "retry raced and got lucky", so the
    // delayed settle is what makes the ordering assertion below meaningful.
    // Pre-fix behavior: the timeout neither aborted the run nor waited, so
    // the retry started while instance 1 was still executing (maxLive 2 and
    // 'call-2:start' before 'call-1:settled').
    const ctx: PhaseExecutionContext = {
      executeTask: async (_task, _phaseId, _env, signal) => {
        const n = ++calls;
        const tag = `call-${n}`;
        events.push(`${tag}:start`);
        live++;
        maxLive = Math.max(maxLive, live);
        try {
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              events.push(`${tag}:settled`);
              resolve('slow-done');
            }, 400);
            const onAbort = () => {
              clearTimeout(timer);
              aborts++;
              events.push(`${tag}:aborted`);
              // Delayed settlement: the abort is observed now, but the
              // execution only actually finishes 60ms later.
              setTimeout(() => {
                events.push(`${tag}:settled`);
                reject(new Error('aborted by timeout'));
              }, 60);
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          });
        } finally {
          live--;
        }
      },
    };

    const orch = new PhaseOrchestrator({
      graph,
      ctx,
      autonomous: false,
      maxConcurrentTasks: 1,
      taskTimeoutMs: 50,
      // Single-task graph: initial attempt + 2 retries exhaust the budget and
      // fail the phase (stopOnFailure), keeping every call attributable to
      // the same task.
      maxRetries: 2,
    });
    await orch.start();

    // Initial attempt + 2 retries, each aborted by its own timeout.
    expect(calls).toBe(3);
    expect(aborts).toBe(3);
    // The core regression assertion: never two instances of the same task.
    expect(maxLive).toBe(1);
    // Ordering: each attempt fully settled before the next one started —
    // this is the duplicate-concurrent-instance race in event form.
    expect(events.indexOf('call-1:settled')).toBeLessThan(events.indexOf('call-2:start'));
    expect(events.indexOf('call-2:settled')).toBeLessThan(events.indexOf('call-3:start'));
    const phases = Array.from(graph.phases.values());
    expect(phases[0]!.status).toBe('failed');
  });
});

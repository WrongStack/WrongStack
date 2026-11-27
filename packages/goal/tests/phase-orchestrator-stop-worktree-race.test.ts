import type { TaskGraph } from '@wrongstack/contracts/types/task-graph';
import { describe, expect, it } from 'vitest';
import { PhaseOrchestrator } from '../src/phase-orchestrator.js';
import type { PhaseGraph, PhaseNode } from '../src/types.js';

function makeGraph(): PhaseGraph {
  const taskGraph: TaskGraph = {
    id: 'tg-1',
    specId: 'spec-1',
    title: 'tg',
    nodes: new Map([
      [
        't-1',
        {
          id: 't-1',
          title: 'Task 1',
          description: 'desc',
          type: 'feature',
          status: 'pending',
          priority: 'medium',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    ]),
    edges: [],
    rootNodes: ['t-1'],
    createdAt: 0,
    updatedAt: 0,
  };
  const phase: PhaseNode = {
    id: 'p-1',
    name: 'Phase 1',
    description: 'desc',
    status: 'pending',
    dependsOn: [],
    taskGraph,
    nextPhases: [],
    parallelizable: false,
    priority: 'medium',
    estimateHours: 0,
    assignedAgents: [],
    createdAt: 0,
    updatedAt: 0,
  };
  return {
    id: 'g-1',
    title: 'Goal',
    description: 'desc',
    phases: new Map([[phase.id, phase]]),
    rootPhaseIds: [phase.id],
    autonomous: false,
    stopOnComplete: false,
    activePhaseIds: [],
    completedPhaseIds: [],
    failedPhaseIds: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('PhaseOrchestrator stop during worktree allocation', () => {
  it('does not emit phase.started and releases late worktree handle when stopped during allocate', async () => {
    let markAllocateStarted!: () => void;
    const allocateStarted = new Promise<void>((r) => {
      markAllocateStarted = r;
    });
    let resolveAllocate!: (handle: unknown) => void;

    const events: string[] = [];
    const released: Array<{ id: string; keep: boolean }> = [];
    const orchestrator = new PhaseOrchestrator({
      graph: makeGraph(),
      events: {
        emit: (name: string) => events.push(name),
        on: () => () => {},
      } as never,
      worktrees: {
        allocate: () => {
          markAllocateStarted();
          return new Promise((r) => {
            resolveAllocate = r;
          });
        },
        commitAll: async () => {},
        merge: async () => ({ ok: true }),
        release: async (h: { id: string }, opts?: { keep?: boolean }) => {
          released.push({ id: h.id, keep: Boolean(opts?.keep) });
        },
        list: () => [],
      } as never,
      ctx: {
        executeTask: async () => ({ ok: true }),
      },
    });

    const runPromise = orchestrator.start();
    await allocateStarted;
    orchestrator.stop();
    resolveAllocate({
      id: 'wt-1',
      dir: '/tmp/wt-1',
      branch: 'feat/p1',
      baseBranch: 'main',
      status: 'active',
    });
    await runPromise;

    expect(events).not.toContain('phase.started');
    expect(released).toEqual([{ id: 'wt-1', keep: true }]);
  });
});

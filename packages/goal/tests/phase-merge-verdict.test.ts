import { expect, it } from 'vitest';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import {
  commitAndEnqueueMerge,
  markPhaseMergeFailed,
} from '../src/phase-orchestrator-integration.js';

type MergeVerdict = { ok: false; stderr?: string; conflict?: boolean; conflictFiles?: string[] };

async function mergeVerdictFixture(result: MergeVerdict) {
  const graph = await new PhaseGraphBuilder({
    title: 'Merge verdict',
    phases: [
      { name: 'Build', description: '', priority: 'high', estimateHours: 1, parallelizable: false },
    ],
  }).build();
  const phase = [...graph.phases.values()][0]!;
  phase.status = 'completed';
  graph.completedPhaseIds = [phase.id];
  const failed: string[] = [];
  let queue = Promise.resolve();
  const context: any = {
    graph,
    ctx: {},
    logger: { error: () => {} },
    runningPhases: new Set(),
    phaseWorktrees: new Map([[phase.id, { dir: '/fixture/worktree', branch: 'fixture/phase' }]]),
    phaseMergePromise: new Map(),
    getMergeQueue: () => queue,
    setMergeQueue: (value: Promise<void>) => {
      queue = value;
    },
    updatePhaseStatus: (_phase: typeof phase, status: typeof phase.status) => {
      phase.status = status;
    },
    emit: (event: string) => {
      if (event === 'phase.failed') failed.push(event);
    },
    worktrees: { commitAll: async () => ({}), merge: async () => result, release: async () => {} },
  };
  await commitAndEnqueueMerge(context, phase);
  await Promise.all([...context.phaseMergePromise.values()]);
  return { context, graph, phase, failed };
}

// Hard merge failures (no conflict) must fail the phase and correct the graph.
for (const result of [{ ok: false, stderr: 'commit refused' } as const, { ok: false } as const]) {
  it(`propagates unsuccessful integration ${JSON.stringify(result)} into the phase graph`, async () => {
    const { context, graph, phase, failed } = await mergeVerdictFixture({ ...result });
    expect(phase.status).toBe('failed');
    expect(graph.completedPhaseIds).toEqual([]);
    expect(graph.failedPhaseIds).toEqual([phase.id]);
    expect(failed).toHaveLength(1);
    markPhaseMergeFailed(context, phase, 'repeated verdict');
    expect(graph.failedPhaseIds).toEqual([phase.id]);
  });
}

// An unresolved conflict (ok:false + conflict:true) is a park-and-continue
// outcome: the handle is kept needs-review and the run continues, so the
// phase must NOT be failed, moved to failedPhaseIds, or emit phase.failed.
it('parks an unresolved merge conflict for review instead of failing the phase', async () => {
  const { graph, phase, failed } = await mergeVerdictFixture({
    ok: false,
    conflict: true,
    conflictFiles: ['file.ts'],
  });
  expect(phase.status).toBe('completed');
  expect(graph.completedPhaseIds).toEqual([phase.id]);
  expect(graph.failedPhaseIds).toEqual([]);
  expect(failed).toHaveLength(0);
  const meta = phase.metadata as
    | { integrationStatus?: string; integrationError?: string }
    | undefined;
  expect(meta?.integrationStatus).toBe('needs_review');
  expect(meta?.integrationError).toBeUndefined();
});

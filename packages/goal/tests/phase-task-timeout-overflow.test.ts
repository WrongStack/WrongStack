import { describe, expect, it } from 'vitest';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseOrchestrator } from '../src/phase-orchestrator.js';

async function graph() {
  return new PhaseGraphBuilder({
    title: 'Timeout overflow',
    phases: [
      {
        name: 'Build',
        description: '',
        priority: 'high',
        estimateHours: 1,
        parallelizable: false,
        taskTemplates: [
          { title: 'Build', description: '', type: 'chore', priority: 'high', estimateHours: 1 },
        ],
      },
    ],
  }).build();
}

// `taskTimeoutMs` is a per-task timeout (types.ts) and only `0` disables it.
// A value past the 2^31-1 ms timer ceiling used to reach setTimeout as-is,
// which the runtime clamps to ~1 ms: every task "timed out" at once.
//
// Ordering, not sleeping: the worker arms its own 1 ms release timer after the
// task timer was armed. Equal-duration timers fire FIFO, so an overflowed task
// timer would fire first and fail the task.
describe('PhaseOrchestrator taskTimeoutMs above the timer ceiling', () => {
  for (const taskTimeoutMs of [2 ** 31, Number.POSITIVE_INFINITY]) {
    it(`does not time a task out immediately when taskTimeoutMs=${taskTimeoutMs}`, async () => {
      const saved = await graph();
      let aborted = false;
      const orchestrator = new PhaseOrchestrator({
        graph: saved,
        maxRetries: 0,
        taskTimeoutMs,
        ctx: {
          executeTask: (_task, _phaseId, _env, signal) =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                aborted = signal?.aborted === true;
                resolve();
              }, 1);
            }),
        },
      });
      await orchestrator.start();
      expect(aborted).toBe(false);
      const [phase] = [...saved.phases.values()];
      expect(phase?.status).toBe('completed');
      expect([...(phase?.taskGraph.nodes.values() ?? [])].map((task) => task.status)).toEqual([
        'completed',
      ]);
    });
  }
});

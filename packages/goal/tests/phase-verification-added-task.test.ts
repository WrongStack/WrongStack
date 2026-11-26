import { expect, it } from 'vitest';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseOrchestrator } from '../src/phase-orchestrator.js';

it.each([false, true])(
  'verifies all work before completion (task added: %s)',
  async (addTask) => {
    const graph = await new PhaseGraphBuilder({
      title: 'Goal',
      phases: [
        {
          name: 'Build',
          description: '',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'Initial task',
              description: '',
              estimateHours: 1,
              priority: 'high',
              type: 'chore',
            },
          ],
        },
      ],
    }).build();
    const phase = [...graph.phases.values()][0];
    if (!phase) throw new Error('Expected one phase');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async (task) => {
          events.push(task.title);
        },
        verifyPhase: async () => {
          events.push('verify');
          entered.resolve();
          await release.promise;
          return { ok: true };
        },
        onPhaseComplete: () => {
          events.push('complete');
        },
      },
    });
    const run = orchestrator.start();
    let added: string | null = null;
    try {
      await Promise.race([
        entered.promise,
        run.then(() => {
          throw new Error('Verifier never ran');
        }),
      ]);
      if (addTask) added = orchestrator.addTask(phase.id, { title: 'Added task' });
    } finally {
      release.resolve();
      await run;
    }
    expect(events).toEqual(
      addTask
        ? ['Initial task', 'verify', 'Added task', 'verify', 'complete']
        : ['Initial task', 'verify', 'complete'],
    );
    if (addTask) expect(added && phase.taskGraph.nodes.get(added)?.status).toBe('completed');
    expect(phase.status).toBe('completed');
    expect(graph.completedAt).toBeDefined();
  },
  5_000,
);

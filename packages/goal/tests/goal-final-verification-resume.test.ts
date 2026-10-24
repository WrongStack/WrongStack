import { expect, it, vi } from 'vitest';
import { prepareGoalGraphForResume } from '../src/goal-run-lifecycle.js';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseOrchestrator } from '../src/phase-orchestrator.js';

async function stoppedBeforeFinalGate() {
  const graph = await new PhaseGraphBuilder({
    title: 'Final gate',
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
  graph.worktrees = false;
  graph.runState = 'stopped';
  const phase = [...graph.phases.values()][0]!;
  phase.status = 'completed';
  graph.completedPhaseIds = [phase.id];
  [...phase.taskGraph.nodes.values()][0]!.status = 'completed';
  return graph;
}

it('resumes only the final gate after stop without rerunning completed work', async () => {
  const graph = await stoppedBeforeFinalGate();
  await prepareGoalGraphForResume(graph);
  const executeTask = vi.fn();
  const verifyGoal = vi.fn(async () => ({ ok: true }));
  await new PhaseOrchestrator({ graph, ctx: { executeTask, verifyGoal } }).start();
  expect(executeTask).not.toHaveBeenCalled();
  expect(verifyGoal).toHaveBeenCalledOnce();
  expect(graph.finalVerification?.status).toBe('passed');
});

it('refuses final-only resume when a completed phase still has unmerged work', async () => {
  const graph = await stoppedBeforeFinalGate();
  graph.worktrees = true;
  const phase = [...graph.phases.values()][0]!;
  phase.metadata = { worktreeResume: { dir: '/phase', branch: 'phase', baseBranch: 'goal' } };
  await expect(prepareGoalGraphForResume(graph, {} as never)).rejects.toThrow('unmerged');
});

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { summarizeGoal } from '../src/goal-summary.js';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseStore } from '../src/phase-store.js';

async function graph() {
  return new PhaseGraphBuilder({
    title: 'Goal',
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
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe('project Goal catalog', () => {
  it('tracks distinct isolated owners and refuses a duplicate owner of one goal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-catalog-'));
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const store = new PhaseStore({ baseDir: dir });
    const first = await graph();
    const second = await graph();
    for (const saved of [first, second]) {
      saved.workspace = {
        dir: path.join(dir, saved.id),
        branch: `wstack/ap/${saved.id}`,
        baseBranch: 'main',
      };
      saved.runState = 'running';
      saved.sessionId = saved.id;
      await store.save(saved);
    }
    const releaseFirst = await store.acquireGoalRunLease(
      first.id,
      `test:${process.pid}:${first.id}`,
    );
    cleanup.push(releaseFirst);
    const releaseSecond = await store.acquireGoalRunLease(
      second.id,
      `test:${process.pid}:${second.id}`,
    );
    cleanup.push(releaseSecond);
    await expect(store.acquireGoalRunLease(first.id, 'duplicate')).rejects.toThrow(
      'Another Goal run',
    );
    expect((await store.listGoals()).map((goal) => goal.status)).toEqual(['running', 'running']);
    await releaseFirst();
    const summaries = await store.listGoals();
    expect(summaries.find((goal) => goal.id === first.id)?.status).toBe('stopped');
    expect(summaries.find((goal) => goal.id === second.id)?.status).toBe('running');
    expect((await store.load(first.id))?.workspace).toEqual(first.workspace);
  });

  it('does not confuse task progress with verified goal completion', async () => {
    const saved = await graph();
    const phase = [...saved.phases.values()][0]!;
    [...phase.taskGraph.nodes.values()][0]!.status = 'completed';
    expect(summarizeGoal(saved)).toMatchObject({
      percentComplete: 100,
      status: 'pending',
      reachability: 'unknown',
      verification: 'not_run',
    });
    phase.status = 'completed';
    saved.completedAt = 1;
    saved.finalVerification = { status: 'passed', checkedAt: 1, skipped: true };
    expect(summarizeGoal(saved)).toMatchObject({
      status: 'completed',
      reachability: 'unknown',
      verification: 'not_run',
    });
    saved.finalVerification = { status: 'passed', checkedAt: 2 };
    expect(summarizeGoal(saved).reachability).toBe('verified');
    phase.metadata = { integrationStatus: 'needs_review' };
    expect(summarizeGoal(saved)).toMatchObject({
      reachability: 'blocked',
      blockers: ['Build: integration needs review'],
    });
  });

  it('keeps zero-task goals unknown and failed goals visibly blocked', async () => {
    const empty = await new PhaseGraphBuilder({ title: 'Unplanned', phases: [] }).build();
    expect(summarizeGoal(empty)).toMatchObject({
      status: 'pending',
      percentComplete: null,
      reachability: 'unknown',
    });
    const saved = await graph();
    const phase = [...saved.phases.values()][0]!;
    phase.status = 'failed';
    [...phase.taskGraph.nodes.values()][0]!.status = 'failed';
    expect(summarizeGoal(saved)).toMatchObject({
      status: 'failed',
      reachability: 'blocked',
      blockers: ['Build: phase failed', 'Build: Build (failed)'],
    });
  });

  it('reports persisted pause only for a live owner and stopped after owner exit', async () => {
    const saved = await graph();
    saved.runState = 'paused';
    expect(summarizeGoal(saved, 'owner').status).toBe('paused');
    expect(summarizeGoal(saved).status).toBe('stopped');
  });
});

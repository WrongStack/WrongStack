import { describe, expect, it, vi } from 'vitest';
import { GoalRunPersistence, prepareGoalGraphForResume } from '../src/goal-run-lifecycle.js';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import type { WorktreeManager } from '@wrongstack/core/worktree';

async function graph() {
  return new PhaseGraphBuilder({
    title: 'Resume test',
    phases: [
      {
        name: 'Build',
        description: 'work',
        priority: 'high',
        estimateHours: 1,
        parallelizable: false,
        taskTemplates: [
          {
            title: 'Build',
            description: 'work',
            type: 'feature',
            priority: 'high',
            estimateHours: 1,
          },
        ],
      },
    ],
  }).build();
}

describe('prepareGoalGraphForResume', () => {
  it('preserves completed task evidence and clears a stale final verdict', async () => {
    const saved = await graph();
    saved.worktrees = false;
    saved.finalVerification = { status: 'failed', checkedAt: 1, error: 'old result' };
    saved.completedAt = 1;
    const phase = Array.from(saved.phases.values())[0]!;
    phase.status = 'paused';
    Array.from(phase.taskGraph.nodes.values())[0]!.status = 'completed';

    await prepareGoalGraphForResume(saved);

    expect(saved.finalVerification).toBeUndefined();
    expect(saved.completedAt).toBeUndefined();
    expect(Array.from(phase.taskGraph.nodes.values())[0]!.status).toBe('completed');
  });

  it('rejects completed and failed graphs', async () => {
    const completed = await graph();
    Array.from(completed.phases.values())[0]!.status = 'completed';
    await expect(prepareGoalGraphForResume(completed)).rejects.toThrow('already complete');

    const failed = await graph();
    failed.failedPhaseIds.push(Array.from(failed.phases.keys())[0]!);
    await expect(prepareGoalGraphForResume(failed)).rejects.toThrow('Retry the failed task');
  });

  it('requires an isolated checkout for a saved worktree run', async () => {
    const saved = await graph();
    saved.worktrees = true;
    await expect(prepareGoalGraphForResume(saved)).rejects.toThrow('requires git worktrees');
  });

  it('rejects an ambiguous legacy paused phase with retained git work', async () => {
    const saved = await graph();
    Array.from(saved.phases.values())[0]!.status = 'paused';
    const worktrees = {
      listManaged: async () => ({ worktrees: [], branches: ['wstack/ap/old-branch'] }),
    } as never as WorktreeManager;
    await expect(prepareGoalGraphForResume(saved, worktrees)).rejects.toThrow(
      'without a saved phase identity',
    );
  });
});

describe('GoalRunPersistence', () => {
  it('writes terminal state after pending live snapshots', async () => {
    const saved = await graph();
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const snapshots: string[] = [];
    const save = vi.fn(async (value: typeof saved) => {
      if (snapshots.length === 0) {
        snapshots.push('live');
        await held;
      } else {
        snapshots.push(value.completedAt ? 'terminal' : 'stale');
      }
    });
    const persistence = new GoalRunPersistence({ save });
    const live = persistence.save(saved);
    await vi.waitFor(() => expect(snapshots).toEqual(['live']));
    saved.completedAt = Date.now();
    const terminal = persistence.save(saved);
    releaseFirst();
    await Promise.all([live, terminal]);
    expect(snapshots).toEqual(['live', 'terminal']);
  });
});

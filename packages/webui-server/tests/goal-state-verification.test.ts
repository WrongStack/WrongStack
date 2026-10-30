import { PhaseGraphBuilder } from '@wrongstack/goal';
import { describe, expect, it } from 'vitest';
import { buildGoalState } from '../src/server/goal-state.js';

describe('goal state phase verification', () => {
  it('projects recorded verification attempts and the integration status', async () => {
    const graph = await new PhaseGraphBuilder({
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
    const phase = [...graph.phases.values()][0]!;
    phase.metadata = {
      verificationAttempts: [{ attempt: 0, ok: false, at: 1, output: 'tsc failed' }],
      integrationStatus: 'needs_review',
    };
    const state = buildGoalState(graph);
    const projected = (state['phases'] as Record<string, unknown>[])[0]!;
    expect(projected['verificationAttempts']).toEqual([
      { attempt: 0, ok: false, at: 1, output: 'tsc failed' },
    ]);
    expect(projected['integrationStatus']).toBe('needs_review');
  });
});

import { describe, expect, it } from 'vitest';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseOrchestrator } from '../src/phase-orchestrator.js';

async function singlePhase() {
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

describe('phase verification record', () => {
  it('keeps every verification attempt and its output on the phase', async () => {
    const graph = await singlePhase();
    let calls = 0;
    const orch = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {},
        verifyPhase: async () =>
          ++calls === 1 ? { ok: false, output: 'tsc: 2 errors' } : { ok: true },
        repairPhase: async () => {},
      },
      autonomous: false,
      maxVerifyAttempts: 2,
    });
    await orch.start();
    const phase = Array.from(graph.phases.values())[0]!;
    expect(phase.status).toBe('completed');
    expect(phase.metadata?.['verificationAttempts']).toEqual([
      expect.objectContaining({ attempt: 0, ok: false, output: 'tsc: 2 errors' }),
      expect.objectContaining({ attempt: 1, ok: true }),
    ]);
  });
  it('bounds the stored output', async () => {
    const graph = await singlePhase();
    const orch = new PhaseOrchestrator({
      graph,
      ctx: {
        executeTask: async () => {},
        verifyPhase: async () => ({ ok: false, output: 'x'.repeat(20_000) }),
      },
      autonomous: false,
      maxVerifyAttempts: 0,
    });
    await orch.start();
    const phase = Array.from(graph.phases.values())[0]!;
    const attempts = phase.metadata?.['verificationAttempts'] as { output: string }[];
    expect(phase.status).toBe('failed');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.output.length).toBeLessThanOrEqual(4000);
  });
});

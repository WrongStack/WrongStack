import type { BrainArbiter, BrainDecisionRequest } from '@wrongstack/contracts/types/brain';
import { describe, expect, it, vi } from 'vitest';
import { GoalRunner } from '../src/goal-runner.js';

describe('GoalRunner Brain arbitration after 2 consecutive verification regressions', () => {
  it('consults Brain on the 2nd consecutive verification failure and triggers onFoldFailedAttempt when fold_back is chosen', async () => {
    const brainRequests: BrainDecisionRequest[] = [];
    const brain: BrainArbiter = {
      decide: vi.fn(async (req: BrainDecisionRequest) => {
        brainRequests.push(req);
        return {
          type: 'answer' as const,
          optionId: 'fold_back',
          text: 'fold_back',
          rationale: 'Speculative refactor broke 12 tests twice; fold back to clean checkpoint.',
        };
      }),
    };

    const repairPhase = vi.fn(async () => {});
    const onFoldFailedAttempt = vi.fn<
      NonNullable<ConstructorParameters<typeof GoalRunner>[0]['onFoldFailedAttempt']>
    >(async () => {});
    const onFail = vi.fn<NonNullable<ConstructorParameters<typeof GoalRunner>[0]['onFail']>>();

    const runner = new GoalRunner({
      title: 'Speculative Parser Refactor',
      phases: [
        {
          name: 'Rewrite AST',
          description: 'Rewrite AST parser phase',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'Swap parser',
              description: 'Rewrite AST parser',
              type: 'refactor',
              priority: 'high',
              estimateHours: 1,
            },
          ],
        },
      ],
      executeTask: async () => 'done',
      verifyPhase: async () => ({ ok: false, output: 'TS2322: incompatible AST node' }),
      repairPhase,
      onFoldFailedAttempt,
      brain,
      maxVerifyAttempts: 3,
      autonomous: true,
      stopOnFailure: true,
      onFail,
    });

    await runner.start();

    // Attempt 0 fails -> repair #1 runs without asking Brain yet.
    // Attempt 1 fails (2nd consecutive verification regression!) -> Brain is asked and chooses fold_back,
    // halting repair #2 & #3 and invoking onFoldFailedAttempt once.
    expect(repairPhase).toHaveBeenCalledTimes(1);
    expect(brainRequests).toHaveLength(1);
    expect(brainRequests[0]?.question).toContain('2 consecutive verification regressions');
    expect(brainRequests[0]?.options?.map((o) => o.id)).toEqual(['continue_repair', 'fold_back']);
    expect(onFoldFailedAttempt).toHaveBeenCalledTimes(1);
    expect(onFoldFailedAttempt.mock.calls[0]?.[2]).toBe(2);
    expect(onFail).toHaveBeenCalledTimes(1);
    const failedPhase = onFail.mock.calls[0]?.[1];
    expect(failedPhase?.status).toBe('failed');
    expect(failedPhase?.metadata?.['brainRegressionDecision']).toBe('fold_back');
  });

  it('continues repairing normally when Brain selects the recommended continue_repair option', async () => {
    let verifyCalls = 0;
    const repairPhase = vi.fn(async () => {});
    const onFoldFailedAttempt = vi.fn(async () => {});
    const brain: BrainArbiter = {
      decide: vi.fn(async () => ({
        type: 'answer' as const,
        optionId: 'continue_repair',
        text: 'continue_repair',
      })),
    };

    const runner = new GoalRunner({
      title: 'Recoverable Fix',
      phases: [
        {
          name: 'Add Helper',
          description: 'Add helper implementation phase',
          priority: 'medium',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'Write helper',
              description: 'Add helper implementation',
              type: 'feature',
              priority: 'medium',
              estimateHours: 1,
            },
          ],
        },
      ],
      executeTask: async () => 'done',
      verifyPhase: async () => {
        verifyCalls += 1;
        // Fail twice, pass on the 3rd verification (after 2 repairs)
        return verifyCalls >= 3 ? { ok: true } : { ok: false, output: 'lint warning' };
      },
      repairPhase,
      onFoldFailedAttempt,
      brain,
      maxVerifyAttempts: 2,
      autonomous: true,
    });

    const graph = await runner.start();
    const phase = Array.from(graph.phases.values())[0];
    expect(repairPhase).toHaveBeenCalledTimes(2);
    expect(onFoldFailedAttempt).not.toHaveBeenCalled();
    expect(phase?.status).toBe('completed');
    expect(phase?.metadata?.['brainRegressionDecision']).toBe('continue_repair');
  });
});

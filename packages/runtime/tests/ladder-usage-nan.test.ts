import { describe, expect, it } from 'vitest';
import type { ReviewerAttempt } from '../src/chimera/chimera-reviewer-policy.js';
import { runSubagentModelLadder } from '../src/chimera/chimera-subagent-ladder.js';

describe('runSubagentModelLadder non-finite usage guard', () => {
  it('ignores NaN and Infinity usage fields so accumulatedUsage stays finite', async () => {
    const ladder: ReviewerAttempt[] = [
      { provider: 'p1', model: 'm1', fallbackModels: [], tier: 'primary' },
      { provider: 'p2', model: 'm2', fallbackModels: [], tier: 'fallback' },
    ];

    let callCount = 0;
    const director = {
      spawn: async () => `sub-${++callCount}`,
      assign: async () => `task-${callCount}`,
      awaitTasks: async () => [
        callCount === 1
          ? {
              status: 'error',
              output: 'fail',
              iterations: 1,
              toolCalls: 1,
              durationMs: 100,
              usage: {
                inputTokens: Number.NaN,
                outputTokens: 50,
                totalTokens: 50,
                costUsd: Number.POSITIVE_INFINITY,
              },
            }
          : {
              status: 'success',
              output: 'ok',
              iterations: 1,
              toolCalls: 1,
              durationMs: 100,
              usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.05 },
            },
      ],
      terminate: async () => {},
    } as never;

    const outcome = await runSubagentModelLadder({
      director,
      ladder,
      buildConfig: () => ({ name: 'r', role: 'reviewer' }) as never,
      buildTask: () => 'review',
    });

    expect(outcome.accumulatedUsage).toEqual({
      inputTokens: 100,
      outputTokens: 70,
      totalTokens: 170,
      costUsd: 0.05,
    });
  });
});

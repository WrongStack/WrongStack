import { describe, expect, it } from 'vitest';
import { refineGoalWithProvider } from '../src/mission-refinement.js';

describe('refineGoalWithProvider timeout clamping (F388)', () => {
  it('clamps timeoutMs above 32-bit signed max instead of aborting in 1ms', async () => {
    const provider = {
      id: 'mock',
      async complete() {
        await new Promise((r) => setTimeout(r, 30));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                refinedGoal: 'Test goal',
                acceptanceCriteria: ['Done'],
              }),
            },
          ],
          usage: { input: 1, output: 1 },
        };
      },
    };

    let abortedEarly = false;
    await refineGoalWithProvider('Test goal', provider as never, 'mock-model', {
      timeoutMs: 3_000_000_000,
      onError: (reason) => {
        if (reason.includes('timeout') || reason.includes('abort')) abortedEarly = true;
      },
    });

    expect(abortedEarly).toBe(false);
  });
});

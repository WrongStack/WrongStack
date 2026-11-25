import { describe, expect, it } from 'vitest';
import { DirectorIdleRetirement } from '../src/director-idle-retirement.js';
import type { DefaultMultiAgentCoordinator } from '../src/multi-agent-coordinator.js';

describe('DirectorIdleRetirement.arm non-finite delayMs guard', () => {
  it('ignores NaN and Infinity delays instead of retiring immediately', async () => {
    const coordinator = {
      getStatus: () => ({ subagents: [{ id: 'sub-1', status: 'idle' }] }),
      listPendingTasks: () => [],
    } as unknown as DefaultMultiAgentCoordinator;

    let removed = 0;
    const retirement = new DirectorIdleRetirement(
      () => coordinator,
      async () => {
        removed += 1;
      },
      () => {},
    );
    retirement.arm('sub-1', Number.NaN);
    retirement.arm('sub-1', Number.POSITIVE_INFINITY);
    await new Promise((resolve) => setTimeout(resolve, 40));
    retirement.dispose();

    expect(removed).toBe(0);
  });
});

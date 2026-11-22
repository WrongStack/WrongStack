/**
 * F1156 — a per-subagent `idleTimeoutMs` larger than setTimeout's 2^31-1 ms
 * ceiling must not retire the subagent immediately. `spawn_subagent`
 * accepts any finite `idleTimeoutMs >= 1`; Node and Bun clamp an
 * overflowing delay to ~1 ms, so an idle subagent spawned with a long
 * keep-alive window was removed right after spawn.
 */
import type { SubagentRunOutcome } from '@wrongstack/contracts/types/multi-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Director } from '../src/director.js';
import { DirectorIdleRetirement } from '../src/director-idle-retirement.js';

const MAX_TIMER_MS = 2_147_483_647;

describe('director idle retirement timeout overflow (F1156)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not retire an idle subagent spawned with an over-ceiling idleTimeoutMs', async () => {
    const director = new Director({
      sessionId: 'sess_test',
      config: {
        coordinatorId: 'idle-overflow',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 1,
      },
      retireSubagentOnTaskComplete: false,
      runner: async (): Promise<SubagentRunOutcome> => ({
        result: 'ok',
        iterations: 1,
        toolCalls: 0,
      }),
    });
    try {
      const id = await director.spawn({
        id: 'long-lived',
        name: 'Long lived',
        idleTimeoutMs: 3_000_000_000,
      });
      // An overflowing delay fires after ~1 ms; give it ample room to misfire.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(director.status().subagents.find((s) => s.id === id)?.status).toBe('idle');
    } finally {
      await director.shutdown();
    }
  });

  it('arms no timer above the 32-bit ceiling', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const remove = vi.fn(async () => {});
    const retirement = new DirectorIdleRetirement(
      () =>
        ({
          getStatus: () => ({ subagents: [{ id: 'sa-1', status: 'idle' }] }),
          listPendingTasks: () => [],
        }) as never,
      remove,
      () => undefined,
    );
    retirement.arm('sa-1', 3_000_000_000);
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays.length).toBe(1);
    expect(delays[0]).toBeLessThanOrEqual(MAX_TIMER_MS);
    retirement.dispose();
    expect(remove).not.toHaveBeenCalled();
  });
});

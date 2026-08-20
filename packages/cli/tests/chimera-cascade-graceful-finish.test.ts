/**
 * Integrated ladder test: graceful finish on a Chimera cascade rung.
 *
 * Real components wired together — no mocks in the chain under test:
 *
 *   runSubagentModelLadder (cli)
 *     → real Director + DefaultMultiAgentCoordinator
 *       → real executeSubagentWithTimeout watchdog
 *         → runner that plays the cascade rung: it keeps working until the
 *           wall-clock deadline crossing delivers the in-band
 *           `subagent.finish_requested` notification, then completes its own
 *           turn within the grace window.
 *
 * Pins the three-part contract:
 *   1. The deadline crossing NOTIFIES in-band — the rung is never aborted.
 *   2. The rung's own-turn completion is preserved as the task result.
 *   3. The ladder does NOT retry the rung, even though a second rung exists.
 */
import { Director } from '@wrongstack/core/coordination';
import { EventBus } from '@wrongstack/core/kernel';
import type { SubagentRunContext, SubagentRunOutcome, TaskSpec } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewerAttempt } from '../src/chimera-reviewer-policy.js';
import { runSubagentModelLadder } from '../src/chimera-subagent-ladder.js';

type Runner = (task: TaskSpec, ctx: SubagentRunContext) => Promise<SubagentRunOutcome>;

/** Two rungs, mirroring a cascade ladder — rung 1 must never be reached. */
const LADDER: ReviewerAttempt[] = [
  { provider: 'prov', model: 'model-a', fallbackModels: [], tier: 'inherit' },
  { provider: 'prov', model: 'model-b', fallbackModels: [], tier: 'fallback' },
];

describe('cascade ladder × graceful finish (integrated)', () => {
  it('notifies the rung in-band, the rung finishes within grace, and the ladder does not retry it', async () => {
    const notifications: Array<{ reason: string; notice: string; graceMs: number }> = [];

    const runner = vi.fn<Runner>(async (_task, ctx) => {
      // Mirror makeAgentSubagentRunner: the runner owns wiring the budget's
      // EventBus — this is the production seam for in-band delivery. Without
      // it, notifyFinish() has no channel and the watchdog would fall back to
      // the terminal stop.
      const bus = new EventBus();
      ctx.budget._events = bus;

      const notified = new Promise<void>((resolve) => {
        bus.on('subagent.finish_requested', (e) => {
          notifications.push({ reason: e.reason, notice: e.notice, graceMs: e.graceMs });
          resolve();
        });
      });

      // The model works across iterations/tool calls, then — exactly like a
      // rung reading its /btw note at the next iteration boundary — completes
      // its own turn once the notification lands, inside the grace window.
      ctx.budget.recordIteration();
      ctx.budget.recordToolCall();
      await notified;
      ctx.budget.recordIteration();
      ctx.budget.recordToolCall();

      return {
        result: 'fixed: applied the patch in src/foo.ts and verified with pnpm typecheck',
        iterations: 2,
        toolCalls: 2,
      };
    });

    const director = new Director({
      config: {
        coordinatorId: 'cascade-graceful-finish',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 1,
      },
      runner,
    });

    const outcome = await runSubagentModelLadder({
      director,
      ladder: LADDER,
      // Cross the rung's wall clock quickly so the notification path fires
      // within test time; the grace window (default 120s) is never waited
      // out because the rung finishes immediately on notification. The
      // ladder budget must clear REVIEWER_MIN_ATTEMPT_MS (120s), otherwise
      // reviewerAttemptTimeoutMs returns 0 and the ladder breaks before
      // spawning anything.
      attemptTimeoutMs: 150,
      budgetMs: 300_000,
      // Mirrors execution-chimera-cascade.ts buildConfig verbatim — including
      // the gracefulFinish opt-in the cascade handler now sets.
      buildConfig: (attempt, timeoutMs) => ({
        name: 'chimera-cascade-bug-hunter',
        role: 'bug-hunter',
        maxIterations: 40,
        maxToolCalls: 200,
        timeoutMs,
        spawnBudgetExempt: true,
        gracefulFinish: true,
        ...(attempt.tier === 'inherit'
          ? {}
          : {
              provider: attempt.provider,
              model: attempt.model,
              fallbackModels: attempt.fallbackModels,
            }),
      }),
      buildTask: () => 'Fix the finding in src/foo.ts',
    });

    // 1. The deadline crossing notified in-band — no abort, the rung stayed
    //    alive long enough to read the notice and act on it.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.reason).toContain('wall-clock budget');
    expect(notifications[0]!.notice).toContain('The leader agent has finished its work.');
    expect(notifications[0]!.graceMs).toBeGreaterThan(0);

    // 2. The rung's own-turn completion is the preserved task result.
    expect(outcome.result?.status).toBe('success');
    expect(outcome.result?.result).toContain('fixed: applied the patch');

    // 3. The ladder did NOT retry the rung — one attempt, first rung won,
    //    no failures recorded, and a second rung was available but unused.
    expect(outcome.attemptsUsed).toBe(1);
    expect(outcome.wonAt).toBe(1);
    expect(outcome.failures).toHaveLength(0);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

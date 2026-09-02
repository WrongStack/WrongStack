import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureLearnedFromAgentOutputDetailed,
  DEFAULT_AUTO_OPTIMIZE_POLICY,
  evaluateAutoOptimize,
  getProjectAgentLearnStats,
  LearningOptimizationScheduler,
  listProjectSkillAugmentations,
  loadConsolidationMetadata,
  resetCaptureWindows,
  resolveAutoOptimizePolicy,
  saveProjectAgentConsolidated,
  updateProjectAgentLearningPolicy,
} from '../../src/coordination/agents/index.js';
import type { Provider, Request, Response } from '../../src/types/index.js';

let projectRoot: string;

const policy = (overrides: Partial<typeof DEFAULT_AUTO_OPTIMIZE_POLICY> = {}) => ({
  ...DEFAULT_AUTO_OPTIMIZE_POLICY,
  minEntries: 1,
  minPendingSkillDirectives: 1,
  debounceMs: 0,
  ...overrides,
});

function stubLlm(reply: string, onCall?: () => void) {
  return {
    model: 'stub-model',
    provider: {
      capabilities: {},
      async complete(_req: Request): Promise<Response> {
        onCall?.();
        return { content: [{ type: 'text', text: reply }] } as unknown as Response;
      },
    } as unknown as Provider,
  };
}

/** Capture a tagged directive, bypassing cooldown via the manual flag. */
function learn(role: string, text: string, skill?: string): void {
  const heading = skill ? `## LEARNED [skill: ${skill}]` : '## LEARNED';
  captureLearnedFromAgentOutputDetailed(`${heading}\n${text}`, role, projectRoot, true);
}

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ws-auto-opt-'));
  resetCaptureWindows();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  resetCaptureWindows();
});

describe('eligibility', () => {
  it('declines an empty or nearly-empty buffer', () => {
    expect(evaluateAutoOptimize('executor', projectRoot, policy({ minEntries: 4 }))).toEqual({
      eligible: false,
      reason: 'too-few-entries',
    });
  });

  it('becomes eligible once enough directives await a skill they have not reached', () => {
    learn(
      'verifier',
      'Always run `pnpm vitest run` from the repository root, never per package.',
      'testing',
    );
    expect(evaluateAutoOptimize('verifier', projectRoot, policy())).toEqual({
      eligible: true,
      reason: 'pending-skills',
    });
  });

  it('becomes eligible on buffer size even with nothing routed', () => {
    learn('executor', 'Always verify the release checklist before publishing any package here.');
    expect(evaluateAutoOptimize('executor', projectRoot, policy({ thresholdBytes: 1 }))).toEqual({
      eligible: true,
      reason: 'size',
    });
  });

  it('respects a paused role', () => {
    learn('executor', 'Always verify the release checklist before publishing any package here.');
    updateProjectAgentLearningPolicy('executor', { enabled: false }, projectRoot);
    expect(evaluateAutoOptimize('executor', projectRoot, policy({ thresholdBytes: 1 }))).toEqual({
      eligible: false,
      reason: 'learning-paused',
    });
  });

  it('respects the per-role cooldown', () => {
    learn('executor', 'Always verify the release checklist before publishing any package here.');
    saveProjectAgentConsolidated('executor', '# Consolidated', projectRoot);
    // A consolidation just happened, so the role is cooling down…
    expect(
      evaluateAutoOptimize('executor', projectRoot, policy({ thresholdBytes: 1 })),
    ).toMatchObject({ eligible: false, reason: 'cooling-down' });
    // …and becomes eligible again once the interval has elapsed.
    learn('executor', 'Always attach the failing command output when reporting a broken build.');
    const later = Date.now() + DEFAULT_AUTO_OPTIMIZE_POLICY.minIntervalMs + 1_000;
    expect(
      evaluateAutoOptimize('executor', projectRoot, policy({ thresholdBytes: 1 }), later).eligible,
    ).toBe(true);
  });

  it('is a no-op when switched off', () => {
    learn('executor', 'Always verify the release checklist before publishing any package here.');
    expect(evaluateAutoOptimize('executor', projectRoot, policy({ enabled: false }))).toEqual({
      eligible: false,
      reason: 'disabled',
    });
  });
});

describe('policy resolution', () => {
  it('falls back to defaults for missing or invalid overrides', () => {
    expect(resolveAutoOptimizePolicy(undefined)).toEqual(DEFAULT_AUTO_OPTIMIZE_POLICY);
    expect(
      resolveAutoOptimizePolicy({ thresholdBytes: -1, minEntries: Number.NaN, debounceMs: 500 }),
    ).toEqual({
      ...DEFAULT_AUTO_OPTIMIZE_POLICY,
      debounceMs: 500,
    });
    expect(resolveAutoOptimizePolicy({ enabled: false }).enabled).toBe(false);
  });
});

describe('scheduler', () => {
  function makeScheduler(
    overrides: Partial<ConstructorParameters<typeof LearningOptimizationScheduler>[0]> = {},
    policyOverrides: Partial<typeof DEFAULT_AUTO_OPTIMIZE_POLICY> = {},
  ) {
    const events: Array<{ role: string; status?: string }> = [];
    const scheduler = new LearningOptimizationScheduler({
      projectRoot,
      getPolicy: () => policy(policyOverrides),
      getLlm: () => stubLlm('# Consolidated\n\n- Distilled.'),
      onEvent: (event) => events.push({ role: event.role, status: event.result?.status }),
      // Fire debounce timers synchronously so the test does not sleep.
      scheduleTimer: ((fn: () => void) => {
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as never,
      cancelTimer: (() => {}) as never,
      ...overrides,
    });
    return { scheduler, events };
  }

  it('runs a pass after a capture and writes the skill addendum', async () => {
    learn(
      'verifier',
      'Always run `pnpm vitest run` from the repository root, never per package.',
      'testing',
    );
    const { scheduler, events } = makeScheduler();
    scheduler.notifyCaptured('verifier');
    await scheduler.idle();

    expect(events).toEqual([{ role: 'verifier', status: 'optimized' }]);
    expect(listProjectSkillAugmentations('verifier', projectRoot)).toEqual(['testing']);
    // The raw buffer was archived and reset, so the role can keep learning.
    expect(getProjectAgentLearnStats('verifier', projectRoot).entryCount).toBe(0);
    expect(loadConsolidationMetadata('verifier', projectRoot)?.trigger).toBe('automatic');
    scheduler.dispose();
  });

  it('does nothing for a role that is not eligible', async () => {
    const { scheduler, events } = makeScheduler({}, { minEntries: 99 });
    learn('executor', 'Always verify the release checklist before publishing any package here.');
    scheduler.notifyCaptured('executor');
    await scheduler.idle();
    expect(events).toEqual([]);
    scheduler.dispose();
  });

  it('serializes passes instead of running them concurrently', async () => {
    learn(
      'verifier',
      'Always run `pnpm vitest run` from the repository root, never per package.',
      'testing',
    );
    learn(
      'executor',
      'Always rebase onto the latest main before opening a pull request.',
      'git-flow',
    );
    let concurrent = 0;
    let peak = 0;
    const { scheduler } = makeScheduler({
      getLlm: () =>
        stubLlm('# Consolidated', () => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          concurrent--;
        }),
    });
    scheduler.notifyCaptured('verifier');
    scheduler.notifyCaptured('executor');
    await scheduler.idle();
    expect(peak).toBe(1);
    scheduler.dispose();
  });

  it('still develops the skill layer when no model is available', async () => {
    learn(
      'verifier',
      'Always run `pnpm vitest run` from the repository root, never per package.',
      'testing',
    );
    const { scheduler, events } = makeScheduler({ getLlm: () => undefined });
    scheduler.notifyCaptured('verifier');
    await scheduler.idle();
    expect(events[0]?.status).toBe('no-llm');
    expect(listProjectSkillAugmentations('verifier', projectRoot)).toEqual(['testing']);
    scheduler.dispose();
  });

  it('backs off after a failure instead of retrying in a loop', async () => {
    learn(
      'verifier',
      'Always run `pnpm vitest run` from the repository root, never per package.',
      'testing',
    );
    let calls = 0;
    const { scheduler } = makeScheduler({
      getLlm: () => {
        calls++;
        throw new Error('provider exploded');
      },
    });
    scheduler.notifyCaptured('verifier');
    await scheduler.idle();
    expect(calls).toBe(1);
    // A second capture inside the backoff window must not re-run the pass.
    scheduler.notifyCaptured('verifier');
    await scheduler.idle();
    expect(calls).toBe(1);
    scheduler.dispose();
  });

  it('sweeps roles that became eligible before the session started', async () => {
    learn(
      'verifier',
      'Always run `pnpm vitest run` from the repository root, never per package.',
      'testing',
    );
    const { scheduler, events } = makeScheduler();
    scheduler.sweep(['verifier', 'nonexistent-role']);
    await scheduler.idle();
    expect(events.map((e) => e.role)).toEqual(['verifier']);
    scheduler.dispose();
  });

  it('stops scheduling once disposed', async () => {
    learn(
      'verifier',
      'Always run `pnpm vitest run` from the repository root, never per package.',
      'testing',
    );
    const { scheduler, events } = makeScheduler();
    scheduler.dispose();
    scheduler.notifyCaptured('verifier');
    await scheduler.idle();
    expect(events).toEqual([]);
  });
});

/**
 * Pins the shared Chimera model ladder runner: a review, fix, or cascade agent
 * is never abandoned because one model blew up — it walks to the next model and
 * only stops on a deliberate stop or an exhausted budget.
 */
import type { SubagentConfig, SubagentError, TaskResult } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  buildMutatingAgentLadder,
  MAX_MUTATING_ATTEMPTS,
  type ReviewerAttempt,
} from '../src/chimera-reviewer-policy.js';
import {
  attemptLabel,
  buildRetryPreamble,
  type LadderAttemptFailure,
  runSubagentModelLadder,
} from '../src/chimera-subagent-ladder.js';

type Director = Parameters<typeof runSubagentModelLadder>[0]['director'];

type AttemptBehavior =
  | {
      kind: 'result';
      status: TaskResult['status'];
      error?: SubagentError | undefined;
      toolCalls?: number | undefined;
      result?: unknown;
    }
  | { kind: 'spawnThrows'; message: string };

function makeDirector(behaviors: AttemptBehavior[]) {
  const spawned: SubagentConfig[] = [];
  const descriptions: string[] = [];
  const terminated: string[] = [];
  let attemptIdx = 0;

  const director = {
    spawn: async (cfg: SubagentConfig) => {
      const behavior = behaviors[attemptIdx];
      attemptIdx++;
      spawned.push(cfg);
      if (behavior?.kind === 'spawnThrows') throw new Error(behavior.message);
      return `sub-${attemptIdx}`;
    },
    assign: async (spec: { id: string; description: string; subagentId?: string | undefined }) => {
      descriptions.push(spec.description);
    },
    awaitTasks: async (): Promise<TaskResult[]> => {
      const behavior = behaviors[attemptIdx - 1];
      if (behavior?.kind !== 'result') throw new Error('unexpected awaitTasks');
      return [
        {
          subagentId: `sub-${attemptIdx}`,
          taskId: 'task',
          status: behavior.status,
          error: behavior.error,
          result: behavior.result,
          iterations: 1,
          toolCalls: behavior.toolCalls ?? 0,
          durationMs: 1,
        },
      ];
    },
    terminate: async (id: string) => {
      terminated.push(id);
    },
  } as unknown as Director;

  return { director, spawned, descriptions, terminated };
}

const ladder: ReviewerAttempt[] = [
  { provider: 'anthropic', model: 'opus', fallbackModels: ['openai/gpt-x'], tier: 'primary' },
  { provider: 'openai', model: 'gpt-x', fallbackModels: [], tier: 'fallback' },
  { provider: 'groq', model: 'llama', fallbackModels: [], tier: 'session' },
];

const run = (
  behaviors: AttemptBehavior[],
  overrides: Partial<Parameters<typeof runSubagentModelLadder>[0]> = {},
) => {
  const harness = makeDirector(behaviors);
  return {
    harness,
    outcome: runSubagentModelLadder({
      director: harness.director,
      ladder,
      buildConfig: (attempt, timeoutMs) => ({
        name: 'agent',
        timeoutMs,
        provider: attempt.provider,
        model: attempt.model,
      }),
      buildTask: () => 'do the thing',
      ...overrides,
    }),
  };
};

describe('runSubagentModelLadder', () => {
  it('spawns once and retires the winner when the first rung succeeds', async () => {
    const { harness, outcome: pending } = run([{ kind: 'result', status: 'success' }]);
    const outcome = await pending;

    expect(harness.spawned).toHaveLength(1);
    expect(harness.spawned[0]!.model).toBe('opus');
    expect(outcome.wonAt).toBe(1);
    expect(outcome.failures).toEqual([]);
    expect(harness.terminated).toEqual(['sub-1']);
    expect(outcome.subagentId).toBeUndefined();
  });

  it('hands the winner back alive when keepWinnerAlive is set', async () => {
    const { harness, outcome: pending } = run([{ kind: 'result', status: 'success' }], {
      keepWinnerAlive: true,
    });
    const outcome = await pending;

    expect(outcome.subagentId).toBe('sub-1');
    expect(harness.terminated).toEqual([]);
  });

  it('advances to the next model when a rung fails, retiring the dead one', async () => {
    const onAttemptFailed = vi.fn();
    const onRecovered = vi.fn();
    const { harness, outcome: pending } = run(
      [
        { kind: 'result', status: 'failed', error: rateLimit(), toolCalls: 3 },
        { kind: 'result', status: 'success', result: 'report' },
      ],
      { onAttemptFailed, onRecovered },
    );
    const outcome = await pending;

    expect(harness.spawned.map((c) => c.model)).toEqual(['opus', 'gpt-x']);
    expect(harness.terminated).toEqual(['sub-1', 'sub-2']);
    expect(outcome.wonAt).toBe(2);
    expect(outcome.result?.result).toBe('report');
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({
      model: 'anthropic/opus',
      tier: 'primary',
      attempt: 1,
      threw: false,
      toolCalls: 3,
    });
    expect(onAttemptFailed).toHaveBeenCalledWith(outcome.failures[0], ladder[1]);
    expect(onRecovered).toHaveBeenCalledWith(ladder[1], outcome.failures);
  });

  it('walks the whole ladder and reports exhaustion', async () => {
    const { harness, outcome: pending } = run([
      { kind: 'result', status: 'failed', error: rateLimit() },
      { kind: 'result', status: 'timeout' },
      { kind: 'result', status: 'failed', error: rateLimit() },
    ]);
    const outcome = await pending;

    expect(harness.spawned).toHaveLength(3);
    expect(outcome.attemptsUsed).toBe(3);
    expect(outcome.wonAt).toBeUndefined();
    expect(outcome.failures).toHaveLength(3);
  });

  it('does not advance past a deliberate stop', async () => {
    const { harness, outcome: pending } = run([{ kind: 'result', status: 'stopped' }]);
    await pending;

    expect(harness.spawned).toHaveLength(1);
  });

  it('does not advance past a parent abort', async () => {
    const { harness, outcome: pending } = run([
      { kind: 'result', status: 'failed', error: abortedByParent() },
    ]);
    await pending;

    expect(harness.spawned).toHaveLength(1);
  });

  it('treats a spawn crash as a retryable rung', async () => {
    const { harness, outcome: pending } = run([
      { kind: 'spawnThrows', message: 'provider offline' },
      { kind: 'result', status: 'success' },
    ]);
    const outcome = await pending;

    expect(harness.spawned).toHaveLength(2);
    // Nothing to retire — the spawn never produced a subagent.
    expect(harness.terminated).toEqual(['sub-2']);
    expect(outcome.failures[0]).toMatchObject({ threw: true, reason: 'provider offline' });
    expect(outcome.wonAt).toBe(2);
  });

  it('stops when the ladder budget runs out instead of spawning again', async () => {
    // start-of-ladder, then rung 0's budget check, then a jump that leaves
    // less than the minimum a rung needs.
    const clock = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(950_000);
    const { harness, outcome: pending } = run(
      [
        { kind: 'result', status: 'failed', error: rateLimit() },
        { kind: 'result', status: 'success' },
      ],
      { attemptTimeoutMs: 500_000, budgetMs: 1_000_000, now: clock },
    );
    const outcome = await pending;

    expect(harness.spawned).toHaveLength(1);
    expect(harness.spawned[0]!.timeoutMs).toBe(500_000);
    expect(outcome.attemptsUsed).toBe(1);
    expect(String((outcome.lastError as Error).message)).toContain('budget exhausted');
  });

  it('passes the accumulated failures to buildTask so a retry can be warned', async () => {
    const { harness, outcome: pending } = run(
      [
        { kind: 'result', status: 'failed', error: rateLimit(), toolCalls: 4 },
        { kind: 'result', status: 'success' },
      ],
      {
        buildTask: (_attempt, failures) => `${buildRetryPreamble(failures)}fix it`,
      },
    );
    await pending;

    expect(harness.descriptions[0]).toBe('fix it');
    expect(harness.descriptions[1]).toContain('⚠ RETRY');
    expect(harness.descriptions[1]).toContain('half-finished state');
    expect(harness.descriptions[1]).toContain('fix it');
  });
});

describe('buildRetryPreamble', () => {
  it('is empty on the first attempt', () => {
    expect(buildRetryPreamble([])).toBe('');
  });

  it('warns about partial edits when a failed attempt made tool calls', () => {
    expect(buildRetryPreamble([failure({ toolCalls: 2 })])).toContain('do not apply it twice');
  });

  it('warns about partial edits when a failed attempt threw', () => {
    expect(buildRetryPreamble([failure({ threw: true })])).toContain('half-finished state');
  });

  it('states the tree is clean when nothing ran', () => {
    expect(buildRetryPreamble([failure({})])).toContain('working tree is untouched');
  });
});

describe('buildMutatingAgentLadder', () => {
  it('leaves the first rung unpinned so the role model matrix still decides', () => {
    const built = buildMutatingAgentLadder({
      profileChain: ['openai/gpt-x'],
      session: { provider: 'anthropic', model: 'opus' },
      maxAttempts: 3,
    });

    expect(built[0]).toEqual({ provider: '', model: '', fallbackModels: [], tier: 'inherit' });
    expect(attemptLabel(built[0]!)).toBe('inherited model');
    expect(built.slice(1).map(attemptLabel)).toEqual(['openai/gpt-x', 'anthropic/opus']);
    expect(built.at(-1)!.tier).toBe('session');
  });

  it('defaults to one retry — mutating agents re-enter a tree they may have touched', () => {
    const built = buildMutatingAgentLadder({
      profileChain: ['openai/gpt-x', 'groq/llama'],
      session: { provider: 'anthropic', model: 'opus' },
    });

    expect(built).toHaveLength(MAX_MUTATING_ATTEMPTS);
    expect(built[0]!.tier).toBe('inherit');
    // The single retry rung is still the guaranteed session model.
    expect(attemptLabel(built[1]!)).toBe('anthropic/opus');
  });

  it('collapses to the unpinned spawn when only one attempt is allowed', () => {
    const built = buildMutatingAgentLadder({
      session: { provider: 'anthropic', model: 'opus' },
      maxAttempts: 1,
    });

    expect(built).toEqual([{ provider: '', model: '', fallbackModels: [], tier: 'inherit' }]);
  });
});

function rateLimit(): SubagentError {
  return { kind: 'provider_rate_limit', message: 'rate limited', retryable: true };
}

function abortedByParent(): SubagentError {
  return { kind: 'aborted_by_parent', message: 'aborted', retryable: false };
}

function failure(over: Partial<LadderAttemptFailure>): LadderAttemptFailure {
  return {
    model: 'anthropic/opus',
    tier: 'primary',
    attempt: 1,
    reason: 'failed: boom',
    threw: false,
    toolCalls: 0,
    ...over,
  };
}

import type { SubagentConfig } from '@wrongstack/contracts/types/multi-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  instantiateRosterConfig,
  prepareDelegation,
  validateDelegationInput,
} from '../../src/coordination/delegation/delegation-preparation.js';
import { Director } from '../../src/coordination/director.js';
import { applyRosterBudget } from '../../src/coordination/fleet.js';
import {
  createSubagentTaskBudget,
  executeSubagentTask,
} from '../../src/coordination/multi-agent-runner-helpers.js';

const sessionId = 'sess_acp_budget';
const defaultBudget = {
  timeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  maxIterations: 7,
  maxToolCalls: 12,
  maxTokens: 1000,
  maxCostUsd: 0.25,
};
function budgetFor(subagentConfig: SubagentConfig) {
  return createSubagentTaskBudget({
    subagentConfig,
    defaultBudget,
    subagentId: 'worker',
    sessionOf: () => sessionId,
    applyRosterBudget,
  });
}

afterEach(() => vi.useRealTimers());

describe('external ACP task budgets', () => {
  it('uses inactivity instead of inheriting the internal worker budget', () => {
    const budget = budgetFor({ name: 'claude-code', provider: 'acp' });
    expect(budget.limits).toEqual({
      timeoutMs: undefined,
      idleTimeoutMs: 600_000,
      maxIterations: undefined,
      maxToolCalls: undefined,
      maxTokens: undefined,
      maxCostUsd: undefined,
    });
    expect(budgetFor({ name: 'internal' }).limits).toEqual(defaultBudget);
  });

  it('preserves limits explicitly supplied for an ACP worker', () => {
    expect(budgetFor({ name: 'claude-code', provider: 'acp', ...defaultBudget }).limits).toEqual(
      defaultBudget,
    );
  });

  it('keeps an active external task running past internal and idle time windows', async () => {
    vi.useFakeTimers();
    const budget = budgetFor({ name: 'claude-code', provider: 'acp' });
    const controller = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = executeSubagentTask({
      runner: async (_task, ctx) => {
        await finished;
        expect(ctx.signal.aborted).toBe(false);
        return { result: 'done', iterations: 1, toolCalls: 55 };
      },
      task: { id: 'task', description: 'long ACP turn' },
      subagentId: 'worker',
      config: { name: 'claude-code', provider: 'acp' },
      budget,
      abortController: controller,
      sessionId,
      parentBridge: null,
      abortSubagent: () => controller.abort(),
      sessionOf: () => sessionId,
    });
    for (let i = 0; i < 31; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      budget.markActivity();
    }
    finish();
    await expect(pending).resolves.toMatchObject({ status: 'success', toolCalls: 55 });
  });

  it.each([undefined, 20_000, 30_000])(
    'delegate keeps ACP wall-clock opt-in (requested %s)',
    async (timeoutMs) => {
      const director = new Director({
        sessionId,
        config: { coordinatorId: 'acp-policy', doneCondition: { type: 'all_tasks_done' } },
      });
      try {
        const input = validateDelegationInput(
          {
            name: 'claude-code',
            provider: 'acp',
            task: 'inspect',
            scope: 'ACP task',
            outOfScope: ['No edits'],
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          },
          undefined,
        );
        if (input.kind !== 'ok') throw new Error('invalid fixture');
        const result = await prepareDelegation(
          input,
          {
            host: {
              isDirectorMode: () => true,
              ensureDirector: async () => director,
              promoteToDirector: async () => director,
            },
            defaultTimeoutMs: 30_000,
          },
          { sessionId, mode: 'background' },
        );
        if (result.kind !== 'ready') throw new Error('unavailable director');
        expect(result.prepared.cfg.timeoutMs).toBe(timeoutMs);
        expect(result.prepared.cfg.maxIterations).toBeUndefined();
        expect(result.prepared.cfg.maxToolCalls).toBeUndefined();
      } finally {
        await director.shutdown();
      }
    },
  );

  it.each([
    [{ name: 'claude-code', provider: 'acp' }, 600_000, 'idle_timeout'],
    [{ name: 'claude-code', provider: 'acp', timeoutMs: 30_000 }, 30_000, 'timeout'],
    [{ name: 'claude-code', provider: 'acp', idleTimeoutMs: 45_000 }, 45_000, 'idle_timeout'],
  ] as const)(
    'cancels the external worker at its effective deadline (%s)',
    async (config, limit, kind) => {
      vi.useFakeTimers();
      const budget = budgetFor(config);
      const controller = new AbortController();
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const pending = executeSubagentTask({
        runner: async () => {
          await finished;
          return { result: 'late', iterations: 1, toolCalls: 0 };
        },
        task: { id: 'task', description: 'silent ACP turn' },
        subagentId: 'worker',
        config,
        budget,
        abortController: controller,
        sessionId,
        parentBridge: null,
        abortSubagent: () => controller.abort(),
        sessionOf: () => sessionId,
      });
      await vi.advanceTimersByTimeAsync(limit + 1);
      await expect(pending).resolves.toMatchObject({
        status: 'timeout',
        error: { message: expect.stringContaining(kind) },
      });
      expect(controller.signal.aborted).toBe(true);
      finish();
    },
  );

  it('does not apply an internal role budget to another external ACP agent', () => {
    const budget = budgetFor({ name: 'codex-cli', role: 'shadow-agent', provider: 'acp' });
    expect(budget.limits).toEqual(budgetFor({ name: 'claude-code', provider: 'acp' }).limits);
  });

  it('keeps roster ACP task deadlines opt-in and preserves configured overrides', () => {
    const base = { name: 'claude-code', provider: 'acp' };
    const cfg = instantiateRosterConfig('critic', base, undefined, 30_000);
    expect(cfg.timeoutMs).toBeUndefined();
    expect(cfg.maxIterations).toBeUndefined();
    expect(instantiateRosterConfig('critic', base, 20_000, 30_000).timeoutMs).toBe(20_000);
    expect(
      instantiateRosterConfig('critic', { ...base, timeoutMs: 90_000 }, undefined, 30_000)
        .timeoutMs,
    ).toBe(90_000);
  });
});

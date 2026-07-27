import { describe, expect, it } from 'vitest';
import { MemoryInjectorAgent } from '../src/middleware/memory-injector-agent.js';

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    todos: [],
    meta: {},
    provider: { capabilities: { maxContext: 100_000 } },
    ...overrides,
  } as never;
}

describe('MemoryInjectorAgent', () => {
  it('adds live todo and Kanban content to the retrieval plan', () => {
    const agent = new MemoryInjectorAgent();
    const plan = agent.plan({
      ctx: makeCtx({
        todos: [{ id: 't1', content: 'Refactor authentication package', status: 'in_progress' }],
        meta: { kanban: { title: 'Token refresh migration', tags: ['auth', 'oauth'] } },
      }),
      trigger: 'read',
      toolQuery: 'src/auth/session.ts',
      baseMaxHints: 8,
      baseMaxChars: 2800,
    });

    expect(plan.queryText).toContain('Refactor authentication package');
    expect(plan.queryText).toContain('Token refresh migration');
    expect(plan.maxHints).toBe(8);
    expect(plan.maxChars).toBe(2800);
  });

  it('limits high-pressure injection to one compact memory', () => {
    const agent = new MemoryInjectorAgent();
    const ctx = makeCtx({ lastRequestTokens: 90_000 });
    const plan = agent.plan({
      ctx,
      trigger: 'read',
      toolQuery: 'pnpm test',
      baseMaxHints: 8,
      baseMaxChars: 2800,
    });

    expect(plan.contextPressure).toBe(0.9);
    expect(plan.maxHints).toBe(1);
    expect(plan.maxChars).toBe(600);

    agent.record(ctx, plan, { candidates: 12, eligible: 5, injected: 3, injectedChars: 900 });
    expect(
      (ctx as never as { meta: Record<string, any> }).meta['memoryInjectorLastRun'],
    ).toMatchObject({
      candidates: 12,
      eligible: 5,
      injected: 3,
      injectedChars: 900,
    });
  });

  it('disables injection when the provider context is effectively full', () => {
    const agent = new MemoryInjectorAgent();
    const plan = agent.plan({
      ctx: makeCtx({ lastRequestTokens: 96_000 }),
      trigger: 'read',
      toolQuery: 'src/auth/session.ts',
      baseMaxHints: 8,
      baseMaxChars: 2800,
    });

    expect(plan.maxHints).toBe(0);
    expect(plan.maxChars).toBe(0);
  });

  it('does not mix pending todo chatter into the active retrieval query', () => {
    const agent = new MemoryInjectorAgent();
    const plan = agent.plan({
      ctx: makeCtx({
        todos: [
          { id: 'active', content: 'Repair memory retrieval scoring', status: 'in_progress' },
          { id: 'later', content: 'Unrelated Telegram queue cleanup', status: 'pending' },
        ],
      }),
      trigger: 'read',
      toolQuery: 'packages/sage/src/store.ts',
      baseMaxHints: 8,
      baseMaxChars: 2800,
    });

    expect(plan.queryText).toContain('Repair memory retrieval scoring');
    expect(plan.queryText).not.toContain('Telegram');
  });
});

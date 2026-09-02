import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { buildRecoveryStrategies } from '../../src/execution/error-handler.js';
import { DefaultErrorHandler, ProviderError } from '../../src/index.js';
import type { Compactor } from '../../src/types/compactor.js';
import type { ModelsRegistry } from '../../src/types/models-registry.js';

const provErr = (msg: string, status: number) => new ProviderError(msg, status, false, 'test');

describe('DefaultErrorHandler.classify', () => {
  const eh = new DefaultErrorHandler();

  it('classifies 429 as rate_limit (retryable)', () => {
    expect(eh.classify(provErr('rate limited', 429))).toEqual({
      kind: 'rate_limit',
      retryable: true,
    });
  });

  it('classifies 529 as overloaded (retryable)', () => {
    expect(eh.classify(provErr('overloaded', 529))).toEqual({
      kind: 'overloaded',
      retryable: true,
    });
  });

  it('classifies 500 as server (retryable)', () => {
    const c = eh.classify(provErr('boom', 500));
    expect(c.kind).toBe('server');
    expect(c.retryable).toBe(true);
  });

  it('classifies 413 as context_overflow (not retryable)', () => {
    expect(eh.classify(provErr('payload too large', 413))).toEqual({
      kind: 'context_overflow',
      retryable: false,
    });
  });

  it('classifies 400 with "context" in message as context_overflow', () => {
    expect(eh.classify(provErr('context length exceeded', 400)).kind).toBe('context_overflow');
  });

  it('classifies provider body context-window messages as context_overflow', () => {
    const err = new ProviderError('openai HTTP 400', 400, false, 'openai', {
      body: { message: 'Your input exceeds the context window of this model.' },
    });
    expect(eh.classify(err)).toEqual({ kind: 'context_overflow', retryable: false });
  });

  it('classifies the Codex agent-run overflow phrasing as context_overflow', () => {
    // The ChatGPT backend surfaces a subscription throttled-drop with the
    // Codex CLI's own agent wrapper prefix and a follow-up instruction. The
    // classifier must still land on context_overflow (not client), so the
    // recovery path compacts and retries.
    const err = new ProviderError('openai-codex HTTP 400', 400, false, 'openai-codex', {
      body: {
        message:
          'Failed [error]: AGENT_RUN_FAILED: Your input exceeds the context window of this model. Please adjust your input and try again.',
      },
    });
    expect(eh.classify(err)).toEqual({ kind: 'context_overflow', retryable: false });
  });

  it('classifies generic 4xx as client (not retryable)', () => {
    expect(eh.classify(provErr('bad', 404))).toEqual({
      kind: 'client',
      retryable: false,
    });
  });

  it('classifies AbortError as abort', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(eh.classify(err)).toEqual({ kind: 'abort', retryable: false });
  });

  it('classifies fetch failures as network', () => {
    expect(eh.classify(new Error('fetch failed: ECONNRESET'))).toEqual({
      kind: 'network',
      retryable: true,
    });
  });

  it('classifies unknown errors', () => {
    expect(eh.classify(new Error('?'))).toEqual({ kind: 'unknown', retryable: false });
  });

  it('recover returns null by default', async () => {
    const res = await eh.recover(new Error('x'), {} as never);
    expect(res).toBeNull();
  });
});

describe('recovery strategies', () => {
  function makeCtx(overrides: Partial<Context> = {}): Context {
    return {
      model: 'gpt-4',
      provider: { id: 'openai' } as never,
      messages: [],
      ...overrides,
    } as Context;
  }

  it('context_overflow strategy compacts on 413 and asks the agent to retry', async () => {
    const compactor: Compactor = {
      compact: vi.fn(async () => ({
        before: 10_000,
        after: 3_000,
        reductions: [{ phase: 'system', saved: 7000 }],
      })),
    } as never as Compactor;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ compactor }));
    const res = await eh.recover(provErr('payload too big', 413), makeCtx());
    expect(res).toEqual({ action: 'retry', reason: 'context_compacted' });
    expect(compactor.compact).toHaveBeenCalled();
  });

  it('learns a smaller session-local ceiling from a provider overflow', async () => {
    const compactor: Compactor = {
      compact: vi.fn(async () => ({ before: 647_000, after: 500_000, reductions: [] })),
    } as never as Compactor;
    const ctx = makeCtx({
      lastRequestTokens: 647_000,
      meta: {},
      provider: {
        id: 'gateway',
        capabilities: { maxContext: 1_000_000 },
      } as never,
    });
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ compactor }));

    await eh.recover(provErr('context window exceeded', 400), ctx);

    expect(ctx.meta['effectiveMaxContext']).toBe(655_192);
    expect(ctx.meta['providerOverflowMaxContext']).toBe(655_192);
    expect(ctx.meta['effectiveMaxContextSource']).toBe('provider_overflow');
  });

  it('context_overflow returns null when compactor failed to shrink anything', async () => {
    const compactor: Compactor = {
      compact: vi.fn(async () => ({
        before: 10_000,
        after: 10_000,
        reductions: [],
      })),
    } as never as Compactor;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ compactor }));
    const res = await eh.recover(provErr('payload too big', 413), makeCtx());
    expect(res).toBeNull();
  });

  it('context_overflow swallows compactor throws', async () => {
    const compactor: Compactor = {
      compact: vi.fn(async () => {
        throw new Error('compaction failed');
      }),
    } as never as Compactor;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ compactor }));
    const res = await eh.recover(provErr('payload too big', 413), makeCtx());
    expect(res).toBeNull();
  });

  // Fake timers, not wall-clock asserts: real setTimeout can fire ~1ms early
  // (observed 999ms for the 1000ms clamp under coverage instrumentation).
  it('rate_limit_backoff waits then asks the agent to retry', async () => {
    vi.useFakeTimers();
    try {
      const eh = new DefaultErrorHandler(buildRecoveryStrategies());
      const err = new ProviderError('rate limited', 429, true, 'test', {
        body: { retryAfterMs: 1100 },
      });
      let res: unknown;
      const done = eh.recover(err, makeCtx()).then((r) => {
        res = r;
      });
      await vi.advanceTimersByTimeAsync(1099);
      expect(res).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(res).toEqual({ action: 'retry', reason: 'rate_limit_backoff' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate_limit_backoff clamps suggested wait to 1s minimum', async () => {
    vi.useFakeTimers();
    try {
      const eh = new DefaultErrorHandler(buildRecoveryStrategies());
      const err = new ProviderError('slow down', 429, true, 'test', { body: { retryAfterMs: 10 } });
      let res: unknown;
      const done = eh.recover(err, makeCtx()).then((r) => {
        res = r;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(res).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(res).toEqual({ action: 'retry', reason: 'rate_limit_backoff' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('downgrades on 529 (overloaded), not just 5xx', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => ({
        id: 'openai',
        family: 'openai',
        models: [
          { id: 'gpt-4', cost: { input: 30 }, tool_call: true, modalities: { input: ['text'] } },
          { id: 'gpt-3.5', cost: { input: 1 }, tool_call: true, modalities: { input: ['text'] } },
        ],
      })),
      getModel: vi.fn(async (_p: string, m: string) => ({
        id: m,
        cost: { input: 30 },
        capabilities: { tools: true, vision: false },
      })),
    } as never as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    const res = await eh.recover(provErr('overloaded', 529), makeCtx());
    expect(res).toEqual({ action: 'retry', reason: 'model_downgrade', model: 'gpt-3.5' });
  });

  it('429 backs off and never reaches downgrade_model even with a registry', {
    timeout: 10_000,
  }, async () => {
    // rate_limit_backoff returns first for 429, so downgrade_model (which no
    // longer lists 429 in its guard) is never consulted. getProvider must not
    // be called.
    const getProvider = vi.fn(async () => ({ id: 'openai', models: [] }));
    const modelsRegistry = { getProvider, getModel: vi.fn() } as never as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    const err = new ProviderError('rate limited', 429, true, 'test', {
      body: { retryAfterMs: 10 },
    });
    const res = await eh.recover(err, makeCtx());
    expect(res).toEqual({ action: 'retry', reason: 'rate_limit_backoff' });
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('downgrade_model picks cheapest compatible fallback on 500', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => ({
        id: 'openai',
        family: 'openai',
        models: [
          { id: 'gpt-4', cost: { input: 30 }, tool_call: true, modalities: { input: ['text'] } },
          { id: 'gpt-3.5', cost: { input: 1 }, tool_call: true, modalities: { input: ['text'] } },
          { id: 'gpt-3.7', cost: { input: 5 }, tool_call: true, modalities: { input: ['text'] } },
        ],
      })),
      getModel: vi.fn(async (_p: string, m: string) => ({
        id: m,
        cost: { input: 30 },
        capabilities: { tools: true, vision: false },
      })),
    } as never as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    const res = await eh.recover(provErr('server', 503), makeCtx());
    expect(res).toEqual({
      action: 'retry',
      reason: 'model_downgrade',
      model: 'gpt-3.5',
    });
  });

  it('downgrade_model skips models hidden by provider visibility', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => ({
        id: 'openai',
        family: 'openai',
        models: [
          { id: 'gpt-4', cost: { input: 30 }, tool_call: true, modalities: { input: ['text'] } },
          { id: 'gpt-3.5', cost: { input: 1 }, tool_call: true, modalities: { input: ['text'] } },
          { id: 'gpt-3.7', cost: { input: 5 }, tool_call: true, modalities: { input: ['text'] } },
        ],
      })),
      getModel: vi.fn(async (_p: string, m: string) => ({
        id: m,
        cost: { input: 30 },
        capabilities: { tools: true, vision: false },
      })),
    } as never as ModelsRegistry;
    const eh = new DefaultErrorHandler(
      buildRecoveryStrategies({
        modelsRegistry,
        getConfig: () =>
          ({
            provider: 'openai',
            model: 'gpt-4',
            providers: { openai: { type: 'openai', models: ['gpt-3.7'] } },
          }) as never,
      }),
    );
    const res = await eh.recover(provErr('server', 503), makeCtx());
    expect(res).toEqual({
      action: 'retry',
      reason: 'model_downgrade',
      model: 'gpt-3.7',
    });
  });

  it('downgrade_model returns null when no cheaper model exists', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => ({
        id: 'openai',
        models: [
          { id: 'gpt-4', cost: { input: 30 }, tool_call: true, modalities: { input: ['text'] } },
        ],
      })),
      getModel: vi.fn(async () => ({
        id: 'gpt-4',
        cost: { input: 30 },
        capabilities: { tools: true, vision: false },
      })),
    } as never as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    expect(await eh.recover(provErr('server', 500), makeCtx())).toBeNull();
  });

  it('downgrade_model returns null when provider not in registry', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => undefined),
      getModel: vi.fn(async () => undefined),
    } as never as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    expect(await eh.recover(provErr('server', 500), makeCtx())).toBeNull();
  });

  it('downgrade_model swallows registry throws', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => {
        throw new Error('catalog gone');
      }),
      getModel: vi.fn(),
    } as never as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    expect(await eh.recover(provErr('server', 500), makeCtx())).toBeNull();
  });

  it('downgrade_model requires vision when original required it', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => ({
        id: 'openai',
        models: [
          {
            id: 'gpt-4-vision',
            cost: { input: 30 },
            tool_call: true,
            modalities: { input: ['text', 'image'] },
          },
          { id: 'gpt-3.5', cost: { input: 1 }, tool_call: true, modalities: { input: ['text'] } },
        ],
      })),
      getModel: vi.fn(async () => ({
        id: 'gpt-4-vision',
        cost: { input: 30 },
        capabilities: { tools: true, vision: true },
      })),
    } as never as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    const res = await eh.recover(provErr('server', 500), makeCtx());
    // gpt-3.5 lacks image input, so no candidates.
    expect(res).toBeNull();
  });

  const contentFilterErr = () =>
    new ProviderError('filtered', 400, false, 'openai', {
      body: { type: 'content_filter', message: 'The response was filtered' },
    });

  it('content_filter_reroute retries with the closest-cost sibling model', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => ({
        id: 'openai',
        family: 'openai',
        models: [
          { id: 'gpt-4', cost: { input: 30 }, tool_call: true, modalities: { input: ['text'] } },
          {
            id: 'gpt-4-alt',
            cost: { input: 28 },
            tool_call: true,
            modalities: { input: ['text'] },
          },
          { id: 'gpt-3.5', cost: { input: 1 }, tool_call: true, modalities: { input: ['text'] } },
        ],
      })),
      getModel: vi.fn(async (_p: string, m: string) => ({
        id: m,
        cost: { input: 30 },
        capabilities: { tools: true, vision: false },
      })),
    } as never as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    const res = await eh.recover(contentFilterErr(), makeCtx());
    // Closest cost to gpt-4 (30) is gpt-4-alt (28) — a reroute, NOT the
    // cheapest downgrade.
    expect(res).toEqual({ action: 'retry', reason: 'content_filter_reroute', model: 'gpt-4-alt' });
  });

  it('content_filter_reroute never picks the model that just filtered', async () => {
    const modelsRegistry = {
      getProvider: vi.fn(async () => ({
        id: 'openai',
        family: 'openai',
        models: [
          { id: 'gpt-4', cost: { input: 30 }, tool_call: true, modalities: { input: ['text'] } },
        ],
      })),
      getModel: vi.fn(async () => ({
        id: 'gpt-4',
        cost: { input: 30 },
        capabilities: { tools: true, vision: false },
      })),
    } as never as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    expect(await eh.recover(contentFilterErr(), makeCtx())).toBeNull();
  });

  it('content_filter_reroute returns null without a registry (surfaces to fallback layer)', async () => {
    const eh = new DefaultErrorHandler(buildRecoveryStrategies());
    expect(await eh.recover(contentFilterErr(), makeCtx())).toBeNull();
  });

  it('content_filter errors never reach downgrade_model', async () => {
    // A content-filtered 400 must not be treated as a server-error downgrade;
    // the reroute strategy owns it (closest-cost, not cheapest).
    const modelsRegistry = {
      getProvider: vi.fn(async () => ({
        id: 'openai',
        family: 'openai',
        models: [
          { id: 'gpt-4', cost: { input: 30 }, tool_call: true, modalities: { input: ['text'] } },
          { id: 'gpt-3.5', cost: { input: 1 }, tool_call: true, modalities: { input: ['text'] } },
        ],
      })),
      getModel: vi.fn(async (_p: string, m: string) => ({
        id: m,
        cost: { input: 30 },
        capabilities: { tools: true, vision: false },
      })),
    } as never as ModelsRegistry;
    const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
    const res = await eh.recover(contentFilterErr(), makeCtx());
    expect(res).toEqual({ action: 'retry', reason: 'content_filter_reroute', model: 'gpt-3.5' });
  });
});

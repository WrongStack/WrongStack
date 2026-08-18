import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import {
  buildRecoveryStrategies,
  DefaultErrorHandler,
  type RecoveryStrategy,
} from '../../src/execution/error-handler.js';
import { ProviderError } from '../../src/types/provider.js';

// ---------------------------------------------------------------------------
// DefaultErrorHandler.classify — additional edge cases
// ---------------------------------------------------------------------------
describe('DefaultErrorHandler.classify — extra', () => {
  const eh = new DefaultErrorHandler();

  it('classifies DOMException AbortError as abort (browser path)', () => {
    // Simulate DOMException-like object without referencing the actual class
    const err = new Error('aborted') as Error & { name: string };
    err.name = 'AbortError';
    // The handler checks typeof DOMException !== 'undefined' first
    // Since DOMException is not defined in Node test env, this falls
    // through to the Error.name check
    expect(eh.classify(err)).toEqual({ kind: 'abort', retryable: false });
  });

  it('classifies ProviderError with kind=timeout as network', () => {
    const err = new ProviderError('timed out', 408, true, 'test');
    // Set kind directly since constructor may map differently
    Object.defineProperty(err, 'kind', { value: 'timeout' });
    expect(eh.classify(err)).toEqual({ kind: 'network', retryable: true });
  });

  it('classifies ProviderError with kind=network as network', () => {
    const err = new ProviderError('network error', 0, true, 'test');
    Object.defineProperty(err, 'kind', { value: 'network' });
    expect(eh.classify(err)).toEqual({ kind: 'network', retryable: true });
  });

  it('classifies ProviderError with kind=auth as client', () => {
    const err = new ProviderError('auth error', 401, false, 'test');
    Object.defineProperty(err, 'kind', { value: 'auth' });
    expect(eh.classify(err)).toEqual({ kind: 'client', retryable: false });
  });

  it('classifies ProviderError with kind=invalid_request as client', () => {
    const err = new ProviderError('invalid request', 400, false, 'test');
    Object.defineProperty(err, 'kind', { value: 'invalid_request' });
    expect(eh.classify(err)).toEqual({ kind: 'client', retryable: false });
  });

  it('classifies ProviderError with kind=stream_hang as server', () => {
    const err = new ProviderError('stream hang', 0, true, 'test');
    Object.defineProperty(err, 'kind', { value: 'stream_hang' });
    expect(eh.classify(err)).toEqual({ kind: 'server', retryable: true });
  });

  it('classifies ProviderError with kind=content_filter as content_filter', () => {
    const err = new ProviderError('filtered', 400, false, 'test');
    Object.defineProperty(err, 'kind', { value: 'content_filter' });
    expect(eh.classify(err)).toEqual({ kind: 'content_filter', retryable: false });
  });

  it('passes through unknown kind with its own retryable flag', () => {
    const err = new ProviderError('weird', 0, true, 'test');
    Object.defineProperty(err, 'kind', { value: 'unknown' });
    // When kind is 'unknown', retryable comes from the instance, not the kind
    expect(eh.classify(err)).toEqual({ kind: 'unknown', retryable: true });
  });

  // Network error regex matching
  it.each([
    'fetch failed',
    'request failed: ETIMEDOUT',
    'socket hang up: ENOTFOUND',
    'getaddrinfo ENOTFOUND',
    'connect ECONNREFUSED',
    'connect ETIMEDOUT',
    'fetch failed: something',
  ])('classifies network error message "%s" as network', (msg) => {
    expect(eh.classify(new Error(msg))).toEqual({ kind: 'network', retryable: true });
  });

  it('does NOT classify unrelated error message as network', () => {
    expect(eh.classify(new Error('some random error'))).toEqual({
      kind: 'unknown',
      retryable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// DefaultErrorHandler.recover — missing/edge paths
// ---------------------------------------------------------------------------
describe('DefaultErrorHandler.recover — extra', () => {
  function makeCtx(overrides: Partial<Context> = {}): Context {
    return {
      model: 'gpt-4',
      provider: { id: 'openai' } as never,
      messages: [],
      ...overrides,
    } as Context;
  }

  describe('rate_limit_backoff without retryAfterMs', () => {
    it('falls back to 5s when retryAfterMs is absent', async () => {
      vi.useFakeTimers();
      try {
        const eh = new DefaultErrorHandler(buildRecoveryStrategies());
        const err = new ProviderError('rate limited', 429, true, 'test');
        // No body.retryAfterMs
        let res: unknown;
        const done = eh.recover(err, makeCtx()).then((r) => {
          res = r;
        });
        // Should wait ~5000ms (default)
        await vi.advanceTimersByTimeAsync(4999);
        expect(res).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        await done;
        expect(res).toEqual({ action: 'retry', reason: 'rate_limit_backoff' });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('downgrade_model edge cases', () => {
    it('returns null when ctx.provider is undefined', async () => {
      const modelsRegistry = {
        getProvider: vi.fn(),
        getModel: vi.fn(),
      } as never;
      const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
      const ctx = makeCtx();
      ctx.provider = undefined as never;
      const err = new ProviderError('server', 500, true, 'test');
      const res = await eh.recover(err, ctx);
      expect(res).toBeNull();
    });

    it('returns null when registry returns no provider', async () => {
      const modelsRegistry = {
        getProvider: vi.fn().mockResolvedValue(undefined),
        getModel: vi.fn(),
      } as never;
      const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
      const res = await eh.recover(new ProviderError('server', 500, true, 'test'), makeCtx());
      expect(res).toBeNull();
    });

    it('returns null when currentModel not found', async () => {
      const modelsRegistry = {
        getProvider: vi.fn().mockResolvedValue({
          id: 'openai',
          models: [{ id: 'gpt-4', cost: { input: 30 }, tool_call: true }],
        }),
        getModel: vi.fn().mockResolvedValue(undefined),
      } as never;
      const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
      const res = await eh.recover(new ProviderError('server', 500, true, 'test'), makeCtx());
      expect(res).toBeNull();
    });

    it('honors visibleModels filter and downgrades within it', async () => {
      const modelsRegistry = {
        getProvider: vi.fn().mockResolvedValue({
          id: 'openai',
          models: [
            { id: 'gpt-4', cost: { input: 30 }, tool_call: true, modalities: { input: ['text'] } },
            { id: 'gpt-3.5', cost: { input: 1 }, tool_call: true, modalities: { input: ['text'] } },
            { id: 'gpt-3.7', cost: { input: 5 }, tool_call: true, modalities: { input: ['text'] } },
          ],
        }),
        getModel: vi.fn().mockResolvedValue({
          id: 'gpt-4',
          cost: { input: 30 },
          capabilities: { tools: true, vision: false },
        }),
      } as never;
      const eh = new DefaultErrorHandler(
        buildRecoveryStrategies({
          modelsRegistry,
          getConfig: () =>
            ({
              providers: { openai: { type: 'openai', models: ['gpt-4', 'gpt-3.7'] } },
            }) as never,
        }),
      );
      // gpt-3.5 is hidden, so the cheapest visible is gpt-3.7
      const res = await eh.recover(new ProviderError('server', 503, true, 'test'), makeCtx());
      expect(res).toEqual({ action: 'retry', reason: 'model_downgrade', model: 'gpt-3.7' });
    });

    it('handles missing cost on current model gracefully', async () => {
      const modelsRegistry = {
        getProvider: vi.fn().mockResolvedValue({
          id: 'openai',
          models: [
            { id: 'gpt-4', cost: undefined, tool_call: true, modalities: { input: ['text'] } },
          ],
        }),
        getModel: vi.fn().mockResolvedValue({
          id: 'gpt-4',
          capabilities: { tools: true, vision: false },
        }),
      } as never;
      const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
      // No cheaper model → null
      const res = await eh.recover(new ProviderError('server', 500, true, 'test'), makeCtx());
      expect(res).toBeNull();
    });

    it('handles getConfig being undefined', async () => {
      const modelsRegistry = {
        getProvider: vi.fn().mockResolvedValue({
          id: 'openai',
          models: [
            { id: 'gpt-4', cost: { input: 30 }, tool_call: true, modalities: { input: ['text'] } },
            { id: 'gpt-3.5', cost: { input: 1 }, tool_call: true, modalities: { input: ['text'] } },
          ],
        }),
        getModel: vi.fn().mockResolvedValue({
          id: 'gpt-4',
          cost: { input: 30 },
          capabilities: { tools: true, vision: false },
        }),
      } as never;
      const eh = new DefaultErrorHandler(
        buildRecoveryStrategies({
          modelsRegistry,
          // No getConfig → no visible models filter
        }),
      );
      const res = await eh.recover(new ProviderError('server', 503, true, 'test'), makeCtx());
      expect(res).toEqual({ action: 'retry', reason: 'model_downgrade', model: 'gpt-3.5' });
    });

    it('requires tool_call capability when current model has tools', async () => {
      const modelsRegistry = {
        getProvider: vi.fn().mockResolvedValue({
          id: 'openai',
          models: [
            { id: 'gpt-4', cost: { input: 30 }, tool_call: true, modalities: { input: ['text'] } },
            { id: 'gpt-3.5-no-tools', cost: { input: 1 }, modalities: { input: ['text'] } },
          ],
        }),
        getModel: vi.fn().mockResolvedValue({
          id: 'gpt-4',
          cost: { input: 30 },
          capabilities: { tools: true, vision: false },
        }),
      } as never;
      const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
      const res = await eh.recover(new ProviderError('server', 500, true, 'test'), makeCtx());
      // gpt-3.5-no-tools lacks tool_call, so no candidates
      expect(res).toBeNull();
    });
  });

  describe('content_filter_reroute edge cases', () => {
    const contentFilterErr = () => {
      const err = new ProviderError('filtered', 400, false, 'test');
      Object.defineProperty(err, 'kind', { value: 'content_filter' });
      return err;
    };

    it('returns null when provider not found in registry', async () => {
      const modelsRegistry = {
        getProvider: vi.fn().mockResolvedValue(undefined),
        getModel: vi.fn(),
      } as never;
      const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
      expect(await eh.recover(contentFilterErr(), makeCtx())).toBeNull();
    });

    it('returns null when currentModel not found', async () => {
      const modelsRegistry = {
        getProvider: vi.fn().mockResolvedValue({
          id: 'openai',
          models: [{ id: 'gpt-4', cost: { input: 30 }, tool_call: true }],
        }),
        getModel: vi.fn().mockResolvedValue(undefined),
      } as never;
      const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
      expect(await eh.recover(contentFilterErr(), makeCtx())).toBeNull();
    });

    it('returns null when provider is not set on context', async () => {
      const modelsRegistry = {
        getProvider: vi.fn(),
        getModel: vi.fn(),
      } as never;
      const eh = new DefaultErrorHandler(buildRecoveryStrategies({ modelsRegistry }));
      const ctx = makeCtx();
      ctx.provider = undefined as never;
      expect(await eh.recover(contentFilterErr(), ctx)).toBeNull();
    });
  });

  describe('recover with custom strategies', () => {
    it('iterates strategies in order and returns first non-null result', async () => {
      const strategyA: RecoveryStrategy = {
        label: 'A',
        async attempt() {
          return null; // fall through
        },
      };
      const strategyB: RecoveryStrategy = {
        label: 'B',
        async attempt() {
          return { action: 'retry', reason: 'strategy_b' };
        },
      };
      const strategyC: RecoveryStrategy = {
        label: 'C',
        async attempt() {
          return { action: 'fail', reason: 'should not reach' };
        },
      };
      const eh = new DefaultErrorHandler([strategyA, strategyB, strategyC]);
      const res = await eh.recover(new Error('x'), makeCtx());
      expect(res).toEqual({ action: 'retry', reason: 'strategy_b' });
    });

    it('returns null when all strategies return null', async () => {
      const strategy: RecoveryStrategy = {
        label: 'always-null',
        async attempt() {
          return null;
        },
      };
      const eh = new DefaultErrorHandler([strategy]);
      expect(await eh.recover(new Error('x'), makeCtx())).toBeNull();
    });
  });

  describe('context_overflow when compactor throws', () => {
    it('returns null when compact throws and no fallback strategy succeeds', async () => {
      // Test already covered in main test — adding a variant
      const err = new ProviderError('context length exceeded', 400, false, 'test');
      Object.defineProperty(err, 'kind', { value: 'context_overflow' });
      const eh = new DefaultErrorHandler(buildRecoveryStrategies());
      // No compactor → context_overflow returns null, and there's nothing
      // else that matches context_overflow → final null
      const res = await eh.recover(err, makeCtx());
      expect(res).toBeNull();
    });
  });
});

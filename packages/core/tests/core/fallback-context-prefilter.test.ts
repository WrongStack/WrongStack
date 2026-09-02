/**
 * Tests for the context-window pre-filter in the fallback chain.
 *
 * When `ctx.lastRequestTokens` is known (set by `stashRequestTokens` before the
 * provider runner executes), the fallback chain must skip entries whose
 * `maxContext` is provably too small for the current request. Without this
 * filter, the fallback dispatches a call that is guaranteed to fail with
 * `context_overflow` — which is NOT fallback-worthy, so it surfaces as an error
 * instead of continuing to the next candidate.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { createFallbackModelExtension } from '../../src/core/fallback-model.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Config } from '../../src/types/config.js';
import type { Provider, Request, Response } from '../../src/types/provider.js';
import { ProviderError } from '../../src/types/provider.js';

function makeProvider(id: string, maxContext: number): Provider {
  return {
    id,
    capabilities: { maxContext, streaming: false, supportsTools: true },
  } as never as Provider;
}

function makeConfig(): Config {
  return {
    provider: 'primary',
    model: 'model-a',
    // Two fallback entries: small-window first, large-window second.
    fallbackModels: ['other/small-model', 'other/large-model'],
    providers: {
      primary: { type: 'openai', apiKey: 'k1' },
      other: { type: 'openai', apiKey: 'k2' },
    },
  } as never as Config;
}

function makeHarness(
  config: Config,
  lastRequestTokens: number | undefined,
  buildProvider: (providerId: string, modelId?: string) => Promise<Provider> | Provider,
) {
  const ext = createFallbackModelExtension({
    getConfig: () => config,
    buildProvider,
    events: new EventBus(),
    now: () => 1_000,
  });
  const ctx = {
    provider: makeProvider('primary', 200_000),
    model: 'model-a',
    session: { id: 's1' },
    lastRequestTokens,
  } as never as Context;
  const request = {
    model: 'model-a',
    messages: [],
    maxTokens: 100,
  } as never as Request;
  return { ext, ctx, request };
}

const okResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stopReason: 'end_turn',
  usage: { input: 1, output: 1 },
  model: 'large-model',
} as never as Response;

describe('fallback-model context-window pre-filter', () => {
  it('defers a primary recovery probe when the target window cannot fit the fallback history', async () => {
    const config = makeConfig();
    let now = 0;
    const events = new EventBus();
    const blocked: Array<{ currentTokens: number; maxContext: number }> = [];
    events.on('provider.primary_probe_context_blocked', (event) => blocked.push(event as never));
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider: async (providerId, modelId) =>
        makeProvider(
          providerId,
          (providerId === 'primary' && modelId === 'model-a') || modelId === 'small-model'
            ? 4_000
            : 200_000,
        ),
      events,
      now: () => now,
      primaryCooldownMs: 100,
    });
    const { ctx, request } = makeHarness(config, 50_000, async (providerId, modelId) =>
      makeProvider(
        providerId,
        (providerId === 'primary' && modelId === 'model-a') || modelId === 'small-model'
          ? 4_000
          : 200_000,
      ),
    );
    ctx.provider = makeProvider('primary', 4_000);
    let calls = 0;
    await ext.wrapProviderRunner?.(ctx, request, (async () => {
      calls++;
      if (calls === 1) throw new ProviderError('rate limited', 429, true, 'primary');
      return okResponse;
    }) as never);

    expect(ctx.model).toBe('large-model');
    now = 100;
    await ext.beforeRun?.(ctx, {} as never);

    expect(ctx.model).toBe('large-model');
    expect(blocked).toEqual([
      expect.objectContaining({
        providerId: 'primary',
        model: 'model-a',
        currentTokens: 50_000,
        maxContext: 4_000,
      }),
    ]);
  });

  it('skips a fallback entry whose context window is smaller than the current request tokens', async () => {
    const config = makeConfig();
    // buildProvider returns providers with different context windows:
    //   small-model → 4K (too small)
    //   large-model → 200K (sufficient)
    const buildProvider = vi.fn(async (_providerId: string, modelId?: string) => {
      if (modelId === 'small-model') return makeProvider('other', 4_000);
      return makeProvider('other', 200_000);
    });
    const { ext, ctx, request } = makeHarness(config, 50_000, buildProvider);

    const inner = vi
      .fn()
      // Primary fails → triggers fallback
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      // Second call is the large-model fallback — succeeds
      .mockResolvedValueOnce(okResponse);

    const res = await ext.wrapProviderRunner?.(ctx, request, inner);

    expect(res).toBe(okResponse);
    // Primary call + large-model call = 2 total inner calls
    expect(inner).toHaveBeenCalledTimes(2);
    // The small-model was built but its inner call was never dispatched
    expect(buildProvider).toHaveBeenCalledWith('other', 'small-model');
    expect(buildProvider).toHaveBeenCalledWith('other', 'large-model');
    // Context ended on the large model
    expect(ctx.model).toBe('large-model');
  });

  it('does NOT skip when lastRequestTokens is undefined', async () => {
    const config = makeConfig();
    const buildProvider = vi.fn(async (_pid: string, modelId?: string) => {
      if (modelId === 'small-model') return makeProvider('other', 4_000);
      return makeProvider('other', 200_000);
    });
    // lastRequestTokens is undefined — pre-filter is inactive
    const { ext, ctx, request } = makeHarness(config, undefined, buildProvider);

    const inner = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      // small-model succeeds despite its small window (filter didn't skip it)
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'small-ok' }],
        stopReason: 'end_turn',
        usage: { input: 1, output: 1 },
        model: 'small-model',
      } as never as Response);

    await ext.wrapProviderRunner?.(ctx, request, inner);

    // small-model was actually called (not skipped)
    expect(inner).toHaveBeenCalledTimes(2);
    expect(ctx.model).toBe('small-model');
  });

  it('does NOT skip when the context window is large enough', async () => {
    const config = makeConfig();
    const buildProvider = vi.fn(async (_pid: string, _modelId?: string) =>
      makeProvider('other', 200_000),
    );
    // 1K tokens — well within both models' windows
    const { ext, ctx, request } = makeHarness(config, 1_000, buildProvider);

    const inner = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      .mockResolvedValueOnce(okResponse);

    const res = await ext.wrapProviderRunner?.(ctx, request, inner);

    expect(res).toBe(okResponse);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('skips ALL entries when none have sufficient context window', async () => {
    const config = makeConfig();
    const buildProvider = vi.fn(async (_pid: string, _modelId?: string) =>
      // Every fallback is 4K
      makeProvider('other', 4_000),
    );
    // 50K tokens — exceeds all entries
    const { ext, ctx, request } = makeHarness(config, 50_000, buildProvider);

    const rateLimit = new ProviderError('rate limited', 429, true, 'primary');
    const inner = vi.fn().mockRejectedValueOnce(rateLimit);

    await expect(ext.wrapProviderRunner?.(ctx, request, inner)).rejects.toThrow();

    // Only the primary was called; all fallback entries were skipped
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

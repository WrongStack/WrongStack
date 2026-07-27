/**
 * Kind-gating of the cross-provider fallback extension: capacity/transport
 * failures (rate_limit, overloaded, server, timeout, network, stream_hang)
 * hop through the chain; request-shaped failures (auth, invalid_request,
 * context_overflow, content_filter) must surface unchanged — they would fail
 * identically on any provider, or need a different remedy (compaction, key
 * fix, model reroute) owned by the recovery-strategy layer.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { createFallbackModelExtension } from '../../src/core/fallback-model.js';
import {
  bindRequestProvider,
  providerBoundToRequest,
} from '../../src/core/request-provider-binding.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Config } from '../../src/types/config.js';
import type { Provider, Request, Response } from '../../src/types/provider.js';
import { ProviderError, StreamHangError } from '../../src/types/provider.js';

function makeProvider(id: string): Provider {
  return { id, capabilities: { streaming: false } } as never as Provider;
}

function makeConfig(): Config {
  return {
    provider: 'primary',
    model: 'model-a',
    fallbackModels: ['other/model-b'],
    providers: {
      primary: { type: 'openai', apiKey: 'k1' },
      other: { type: 'openai', apiKey: 'k2' },
    },
  } as never as Config;
}

function makeHarness(config = makeConfig()) {
  const buildProvider = vi.fn(async (providerId: string) => makeProvider(providerId));
  const ext = createFallbackModelExtension({
    getConfig: () => config,
    buildProvider,
    events: new EventBus(),
    now: () => 1_000,
  });
  const ctx = {
    provider: makeProvider('primary'),
    model: 'model-a',
    session: { id: 's1' },
  } as never as Context;
  const request = { model: 'model-a', messages: [], maxTokens: 100 } as never as Request;
  return { ext, ctx, request, buildProvider };
}

const okResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stopReason: 'end_turn',
  usage: { input: 1, output: 1 },
  model: 'model-b',
} as never as Response;

describe('fallback-model kind gating', () => {
  it('hops the chain on rate_limit (capacity failure)', async () => {
    const { ext, ctx, request, buildProvider } = makeHarness();
    const inner = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      .mockResolvedValueOnce(okResponse);
    const res = await ext.wrapProviderRunner?.(ctx, request, inner);
    expect(res).toBe(okResponse);
    expect(buildProvider).toHaveBeenCalledWith('other', 'model-b');
    expect(ctx.model).toBe('model-b');
  });

  it('rebinds the same request to the fallback provider before retrying it', async () => {
    const { ext, ctx, request } = makeHarness();
    bindRequestProvider(request, ctx.provider);
    const calls: string[] = [];
    const inner = vi.fn(async (_ctx: Context, req: Request) => {
      const provider = providerBoundToRequest(req);
      calls.push(provider?.id ?? 'missing');
      if (calls.length === 1) {
        throw new ProviderError('rate limited', 429, true, 'primary');
      }
      return okResponse;
    });

    await ext.wrapProviderRunner?.(ctx, request, inner);

    expect(calls).toEqual(['primary', 'other']);
    expect(providerBoundToRequest(request)?.id).toBe('other');
  });

  it('keeps the working fallback for an automatic follow-up during primary cooldown', async () => {
    const { ext, ctx, request, buildProvider } = makeHarness();
    const inner = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      .mockResolvedValueOnce(okResponse);

    await ext.wrapProviderRunner?.(ctx, request, inner);
    await ext.beforeRun?.(ctx, {} as never);

    expect(ctx.provider.id).toBe('other');
    expect(ctx.model).toBe('model-b');
    expect(buildProvider).toHaveBeenCalledTimes(1);
  });

  it('honors a manual primary change after fallback instead of restoring the previous model', async () => {
    const config = makeConfig();
    const { ext, ctx, request, buildProvider } = makeHarness(config);
    const inner = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      .mockResolvedValueOnce(okResponse);
    await ext.wrapProviderRunner?.(ctx, request, inner);

    config.provider = 'manual';
    config.model = 'model-c';
    config.providers = {
      ...config.providers,
      manual: { type: 'openai', apiKey: 'k3' },
    };
    ctx.provider = makeProvider('manual');
    ctx.model = 'model-c';
    await ext.beforeRun?.(ctx, {} as never);

    expect(ctx.provider.id).toBe('manual');
    expect(ctx.model).toBe('model-c');
    expect(buildProvider).toHaveBeenLastCalledWith('manual', 'model-c');
  });

  it('skips a calendar-blocked primary without calling it', async () => {
    const config = {
      ...makeConfig(),
      modelAvailabilitySchedule: [
        {
          id: 'primary-night',
          provider: 'primary',
          model: 'model-a',
          start: '00:00',
          end: '00:00',
        },
      ],
    } as Config;
    const { ext, ctx, request, buildProvider } = makeHarness(config);
    const inner = vi.fn().mockResolvedValue(okResponse);

    const res = await ext.wrapProviderRunner?.(ctx, request, inner);

    expect(res).toBe(okResponse);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(buildProvider).toHaveBeenCalledWith('other', 'model-b');
  });

  it('hops immediately on exhausted quota without same-route retry semantics', async () => {
    const { ext, ctx, request, buildProvider } = makeHarness();
    const quota = new ProviderError('primary HTTP 402', 402, false, 'primary', {
      body: { type: 'insufficient_quota', message: 'Account credit exhausted' },
    });
    expect(quota.kind).toBe('quota_exhausted');
    const inner = vi.fn().mockRejectedValueOnce(quota).mockResolvedValueOnce(okResponse);

    const res = await ext.wrapProviderRunner?.(ctx, request, inner);

    expect(res).toBe(okResponse);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(buildProvider).toHaveBeenCalledWith('other', 'model-b');
  });

  it('hops on stream_hang', async () => {
    const { ext, ctx, request, buildProvider } = makeHarness();
    const hang = new StreamHangError({
      providerId: 'primary',
      model: 'model-a',
      hangTimeoutMs: 1000,
      bytesReceived: 0,
      elapsedMs: 1000,
    });
    const inner = vi.fn().mockRejectedValueOnce(hang).mockResolvedValueOnce(okResponse);
    const res = await ext.wrapProviderRunner?.(ctx, request, inner);
    expect(res).toBe(okResponse);
    expect(buildProvider).toHaveBeenCalled();
  });

  it('does NOT hop on context_overflow — surfaces for compaction instead', async () => {
    const { ext, ctx, request, buildProvider } = makeHarness();
    const err = new ProviderError('anthropic HTTP 400', 400, false, 'primary', {
      body: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens' },
    });
    const inner = vi.fn().mockRejectedValue(err);
    await expect(ext.wrapProviderRunner?.(ctx, request, inner)).rejects.toBe(err);
    expect(buildProvider).not.toHaveBeenCalled();
    expect(ctx.model).toBe('model-a');
  });

  it('does NOT hop on content_filter — the reroute strategy owns it', async () => {
    const { ext, ctx, request, buildProvider } = makeHarness();
    const err = new ProviderError('filtered', 400, false, 'primary', {
      body: { type: 'content_filter', message: 'The response was filtered' },
    });
    const inner = vi.fn().mockRejectedValue(err);
    await expect(ext.wrapProviderRunner?.(ctx, request, inner)).rejects.toBe(err);
    expect(buildProvider).not.toHaveBeenCalled();
  });

  it('does NOT hop on auth failures — a different provider needs a different key anyway', async () => {
    const { ext, ctx, request, buildProvider } = makeHarness();
    const err = new ProviderError('bad key', 401, false, 'primary');
    const inner = vi.fn().mockRejectedValue(err);
    await expect(ext.wrapProviderRunner?.(ctx, request, inner)).rejects.toBe(err);
    expect(buildProvider).not.toHaveBeenCalled();
  });

  it('hops on request timeout (408) — new capacity-kind behavior', async () => {
    const { ext, ctx, request, buildProvider } = makeHarness();
    const inner = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('timeout', 408, true, 'primary'))
      .mockResolvedValueOnce(okResponse);
    const res = await ext.wrapProviderRunner?.(ctx, request, inner);
    expect(res).toBe(okResponse);
    expect(buildProvider).toHaveBeenCalled();
  });

  // ── one bad candidate must not abort the rest of the chain ─────────────
  //
  // The gate used to be re-evaluated per entry against `lastErr`, which every
  // failed attempt reassigns. A model id that no longer exists on its
  // provider answers 404 → `invalid_request` → not fallback-worthy → `break`,
  // so every healthy entry after it went untried. Stale entries are easy to
  // acquire: `resolveRefs` never validates `fallbackModels` against the
  // provider's model list and `buildProvider` ignores the model argument, so
  // a retired model sits in the chain looking perfectly valid.
  it('skips a chain entry whose model 404s and still tries the next one', async () => {
    const config = {
      provider: 'primary',
      model: 'model-a',
      fallbackModels: ['stale/retired-model', 'other/model-b'],
      providers: {
        primary: { type: 'openai', apiKey: 'k1' },
        stale: { type: 'openai', apiKey: 'k2' },
        other: { type: 'openai', apiKey: 'k3' },
      },
    } as never as Config;
    const { ext, ctx, request, buildProvider } = makeHarness(config);

    const inner = vi
      .fn()
      // primary is rate limited → fallback-worthy, chain starts
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      // first candidate's model was retired → 404 / invalid_request
      .mockRejectedValueOnce(new ProviderError('model not found', 404, false, 'stale'))
      // second candidate is healthy
      .mockResolvedValueOnce(okResponse);

    const res = await ext.wrapProviderRunner?.(ctx, request, inner);

    expect(res).toBe(okResponse);
    expect(buildProvider).toHaveBeenCalledWith('stale', 'retired-model');
    expect(buildProvider).toHaveBeenCalledWith('other', 'model-b');
    expect(ctx.model).toBe('model-b');
  });

  // The gate itself must survive: a request-shaped PRIMARY failure still
  // refuses to hop at all, because it would fail identically anywhere.
  it('still refuses to hop when the TRIGGERING error is request-shaped', async () => {
    const { ext, ctx, request, buildProvider } = makeHarness();
    const inner = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('bad request', 400, false, 'primary'));

    await expect(ext.wrapProviderRunner?.(ctx, request, inner)).rejects.toThrow('bad request');
    expect(buildProvider).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

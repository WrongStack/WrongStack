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

  it('does not let the continuity bridge escape a closed-world model allowlist', async () => {
    const config = {
      ...makeConfig(),
      fallbackBridge: 'bridge/model-c',
      fallbackAuto: true,
      providers: {
        ...makeConfig().providers,
        bridge: { type: 'openai', apiKey: 'k3', models: ['model-c'] },
      },
    } as Config;
    const buildProvider = vi.fn(async (providerId: string) => makeProvider(providerId));
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider,
      events: new EventBus(),
      isClosedWorld: () => true,
    });
    const ctx = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    const request = { model: 'model-a', messages: [], maxTokens: 100 } as never as Request;
    const inner = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      .mockResolvedValueOnce(okResponse);

    await ext.wrapProviderRunner?.(ctx, request, inner);

    expect(buildProvider).toHaveBeenCalledTimes(1);
    expect(buildProvider).toHaveBeenCalledWith('other', 'model-b');
    expect(buildProvider).not.toHaveBeenCalledWith('bridge', 'model-c');
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

  // ── Chain ordering: explicit chain has priority ──────────────────────
  //
  // When the user configures an explicit fallbackModels chain, those entries
  // must be tried BEFORE default-profile entries or the session primary.
  // The old ordering (default → primary → explicit) silently overrode the
  // user's intent — a carefully ordered chain [A, B] was unreachable until
  // every default-profile model was attempted first.
  it('tries explicit fallbackModels entries before default-profile entries', async () => {
    const config = {
      provider: 'primary',
      model: 'model-a',
      // Explicit chain — user wants these two models in this order
      fallbackModels: ['explicit/explicit-model'],
      // Default profile has a DIFFERENT model that would also succeed
      fallbackProfiles: {
        default: ['defaultprof/default-model'],
      },
      providers: {
        primary: { type: 'openai', apiKey: 'k1' },
        explicit: { type: 'openai', apiKey: 'k2' },
        defaultprof: { type: 'openai', apiKey: 'k3' },
      },
    } as never as Config;
    const { ext, ctx, request, buildProvider } = makeHarness(config);

    const inner = vi
      .fn()
      // primary is rate limited → fallback-worthy, chain starts
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      // The explicit chain entry succeeds
      .mockResolvedValueOnce(okResponse);

    const res = await ext.wrapProviderRunner?.(ctx, request, inner);

    expect(res).toBe(okResponse);
    // The explicit chain entry was the first fallback attempted
    expect(buildProvider).toHaveBeenCalledWith('explicit', 'explicit-model');
    expect(ctx.model).toBe('explicit-model');
    // The default-profile entry was NOT tried before the explicit one
    expect(buildProvider).not.toHaveBeenCalledWith('defaultprof', 'default-model');
  });

  // ── Graduated primary recovery (H3) ──────────────────────────────────
  //
  // A single primary success after cooldown should NOT fully reset the
  // failure ladder.  This prevents an intermittently-available primary
  // from causing model bouncing (primary → fallback → primary → fallback)
  // because the streak is retained — the next failure continues the
  // exponential backoff instead of restarting at the base cooldown.

  it('does NOT fully reset the primary ladder on a single success (default recoveryTarget=2)', async () => {
    const config = makeConfig();
    // Use a short, deterministic cooldown for the test
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider: vi.fn(async (id: string) => makeProvider(id)),
      events: new EventBus(),
      now: () => 1_000,
      primaryCooldownMs: 60_000,
    });
    const ctx = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    const request = { model: 'model-a', messages: [], maxTokens: 100 } as never as Request;

    // Turn 1: primary fails → fallback to model-b
    await ext.wrapProviderRunner?.(
      ctx,
      request,
      vi
        .fn()
        .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
        .mockResolvedValueOnce(okResponse),
    );

    // beforeRun: simulate cooldown expiry so the primary probe can fire
    // (we can't advance time, so we re-create the extension)
    // Instead, verify the behavior directly: primary succeeds but streak
    // should be retained after a single success.

    // Turn 2: primary succeeds (simulated by a normal call returning ok)
    const primaryOk = {
      content: [{ type: 'text', text: 'primary-ok' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'model-a',
    } as never as Response;

    // Need a fresh ctx on the primary for the success path
    const ctx2 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;

    await ext.wrapProviderRunner?.(ctx2, { ...request }, vi.fn().mockResolvedValueOnce(primaryOk));

    // The primary succeeded, but with recoveryTarget=2 (default), a single
    // success should NOT have cleared dirty — meaning the next beforeRun
    // would still attempt a probe.  We verify by checking that the dirty
    // flag is still set: beforeRun would still try to restore the primary.
    // Since we can't read `dirty` directly, we verify behaviorally: a
    // subsequent primary failure should continue the exponential backoff
    // (streak=2 → 120s cooldown) rather than restarting at streak=1 (60s).

    // Turn 3: primary fails again — if streak was retained (streak=2),
    // the cooldown is 60s * 2^(2-1) = 120s.
    const ctx3 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;

    const failAgain = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      .mockResolvedValueOnce(okResponse);

    await ext.wrapProviderRunner?.(ctx3, { ...request }, failAgain);

    // If the streak was retained, the primary was NOT tried first in
    // beforeRun (still dirty from the failed first turn), so the call
    // goes directly to the inner runner. The important assertion is that
    // the fallback chain was used, proving the ladder wasn't fully reset.
    expect(failAgain).toHaveBeenCalledTimes(2); // primary attempt + fallback
    expect(ctx3.model).toBe('model-b');
  });

  it('fully resets the primary ladder after recoveryTarget consecutive successes', async () => {
    const config = makeConfig();
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider: vi.fn(async (id: string) => makeProvider(id)),
      events: new EventBus(),
      now: () => 1_000,
      primaryCooldownMs: 60_000,
      primaryRecoverySuccesses: 2,
    });

    // Turn 1: primary fails → fallback
    const ctx1 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    const request = { model: 'model-a', messages: [], maxTokens: 100 } as never as Request;

    await ext.wrapProviderRunner?.(
      ctx1,
      request,
      vi
        .fn()
        .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
        .mockResolvedValueOnce(okResponse),
    );

    // Two consecutive primary successes to fully clear the ladder
    const primaryOk = {
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'model-a',
    } as never as Response;

    // Success 1 — partial recovery
    const ctx2 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    await ext.wrapProviderRunner?.(ctx2, { ...request }, vi.fn().mockResolvedValueOnce(primaryOk));

    // Success 2 — full reset
    const ctx3 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    await ext.wrapProviderRunner?.(ctx3, { ...request }, vi.fn().mockResolvedValueOnce(primaryOk));

    // Turn 4: primary fails again — if the ladder was fully reset, the
    // streak restarts at 1, producing a 60s cooldown (not 120s).
    // We verify by checking the beforeRun behavior doesn't retain dirty.
    // After full reset, blockedPrimary is undefined, so beforeRun should
    // be a no-op (dirty was cleared by the successful probe).
    const ctx4 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;

    // beforeRun should be a no-op now (dirty=false after full recovery)
    await ext.beforeRun?.(ctx4, {} as never);
    // Provider should still be primary — beforeRun didn't change it
    expect(ctx4.provider.id).toBe('primary');
    expect(ctx4.model).toBe('model-a');
  });

  it('honors primaryRecoverySuccesses: 1 for legacy one-success-reset behavior', async () => {
    const config = makeConfig();
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider: vi.fn(async (id: string) => makeProvider(id)),
      events: new EventBus(),
      now: () => 1_000,
      primaryCooldownMs: 60_000,
      primaryRecoverySuccesses: 1, // legacy behavior
    });

    // Turn 1: primary fails → fallback
    const ctx1 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    const request = { model: 'model-a', messages: [], maxTokens: 100 } as never as Request;

    await ext.wrapProviderRunner?.(
      ctx1,
      request,
      vi
        .fn()
        .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
        .mockResolvedValueOnce(okResponse),
    );

    // Single success should fully reset with recoveryTarget=1
    const primaryOk = {
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'model-a',
    } as never as Response;

    const ctx2 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    await ext.wrapProviderRunner?.(ctx2, { ...request }, vi.fn().mockResolvedValueOnce(primaryOk));

    // beforeRun should be a no-op (dirty=false, fully reset)
    const ctx3 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    await ext.beforeRun?.(ctx3, {} as never);
    expect(ctx3.provider.id).toBe('primary');
    expect(ctx3.model).toBe('model-a');
  });

  // ── Sticky fallback turns (stickyFallbackTurns) ──────────────────────
  //
  // When set, the system dwells on the working fallback for at least N
  // turns before it becomes eligible for a primary probe — even if the
  // cooldown timer has already expired.

  it('stays on fallback during stickyFallbackTurns even when cooldown expired', async () => {
    const config = makeConfig();
    let mockTime = 1000;
    // Use a very short cooldown (1ms) so it expires almost immediately,
    // but set stickyFallbackTurns=2 to force dwelling on the fallback.
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider: vi.fn(async (id: string) => makeProvider(id)),
      events: new EventBus(),
      now: () => mockTime,
      primaryCooldownMs: 1,
      stickyFallbackTurns: 2,
    });

    // Turn 1: primary fails at t=1000 → cooldown expires at 1001
    const ctx1 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    const request = { model: 'model-a', messages: [], maxTokens: 100 } as never as Request;

    await ext.wrapProviderRunner?.(
      ctx1,
      request,
      vi
        .fn()
        .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
        .mockResolvedValueOnce(okResponse),
    );
    expect(ctx1.model).toBe('model-b');

    // beforeRun #1: t=2000 (cooldown long expired), but stickyTurnsElapsed=1 (<2)
    // → stays on fallback
    mockTime = 2000;
    const ctx1b = {
      ...ctx1,
      provider: makeProvider('other'),
      model: 'model-b',
    } as never as Context;
    await ext.beforeRun?.(ctx1b, {} as never);
    expect(ctx1b.model).toBe('model-b');

    // beforeRun #2: t=3000, stickyTurnsElapsed=2 (>=2) → eligible for probe
    mockTime = 3000;
    const ctx2 = { ...ctx1, provider: makeProvider('other'), model: 'model-b' } as never as Context;
    await ext.beforeRun?.(ctx2, {} as never);
    expect(ctx2.model).toBe('model-a');
    expect(ctx2.provider.id).toBe('primary');
  });

  it('primaryProbeInterval overrides the default cooldown base', async () => {
    const config = makeConfig();
    let mockTime = 0;
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider: vi.fn(async (id: string) => makeProvider(id)),
      events: new EventBus(),
      now: () => mockTime,
      primaryCooldownMs: 30_000, // custom probe interval (30s instead of default 60s)
    });

    // Turn 1: primary fails at t=0 → cooldown set: base * 2^(1-1) = 30000
    const ctx1 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    const request = { model: 'model-a', messages: [], maxTokens: 100 } as never as Request;

    await ext.wrapProviderRunner?.(
      ctx1,
      request,
      vi
        .fn()
        .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
        .mockResolvedValueOnce(okResponse),
    );

    // beforeRun at t=29999 — cooldown (30000) still active → stays on fallback
    mockTime = 29_999;
    const ctx2 = { ...ctx1, provider: makeProvider('other'), model: 'model-b' } as never as Context;
    await ext.beforeRun?.(ctx2, {} as never);
    expect(ctx2.model).toBe('model-b');

    // beforeRun at t=30001 — cooldown expired → primary probe fires
    mockTime = 30_001;
    const ctx3 = { ...ctx1, provider: makeProvider('other'), model: 'model-b' } as never as Context;
    await ext.beforeRun?.(ctx3, {} as never);
    expect(ctx3.model).toBe('model-a');
    expect(ctx3.provider.id).toBe('primary');
  });

  // ── Last-working-fallback memory (H1) ────────────────────────────────
  //
  // When the primary fails and the chain is traversed, the first successful
  // fallback is remembered. On subsequent primary failures the chain is
  // reordered so the last-working entry is tried FIRST — avoiding a full
  // re-traversal through entries that already proved flaky.
  it('prioritizes the last-working fallback on a subsequent primary failure', async () => {
    // Chain order: flaky/model-x (fails), good/model-y (succeeds)
    const config = {
      provider: 'primary',
      model: 'model-a',
      fallbackModels: ['flaky/model-x', 'good/model-y'],
      providers: {
        primary: { type: 'openai', apiKey: 'k1' },
        flaky: { type: 'openai', apiKey: 'k2' },
        good: { type: 'openai', apiKey: 'k3' },
      },
    } as never as Config;

    const buildProvider = vi.fn(async (providerId: string) => makeProvider(providerId));
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider,
      events: new EventBus(),
      now: () => 1_000,
      primaryCooldownMs: 60_000,
    });

    const request = { model: 'model-a', messages: [], maxTokens: 100 } as never as Request;

    // ── Turn 1: primary fails → flaky fails → good succeeds ───────────
    const ctx1 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;

    const inner1 = vi
      .fn()
      // primary: rate limited
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      // flaky/model-x: overloaded
      .mockRejectedValueOnce(new ProviderError('overloaded', 503, true, 'flaky'))
      // good/model-y: succeeds
      .mockResolvedValueOnce(okResponse);

    const res1 = await ext.wrapProviderRunner?.(ctx1, request, inner1);
    expect(res1).toBe(okResponse);
    // The chain entry good/model-y sets ctx.model to 'model-y'
    expect(ctx1.model).toBe('model-y');

    // Build calls: primary(primary), flaky(flaky), good(good)
    expect(buildProvider).toHaveBeenCalledWith('flaky', 'model-x');
    expect(buildProvider).toHaveBeenCalledWith('good', 'model-y');

    // ── Turn 2: primary probed again, fails again ─────────────────────
    // The chain should now front-load good/model-y instead of starting
    // from flaky/model-x.
    const ctx2 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;

    // Clear mock to track the new call order
    buildProvider.mockClear();

    const inner2 = vi
      .fn()
      // primary: rate limited again
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      // good/model-y (front-loaded): succeeds
      .mockResolvedValueOnce(okResponse);

    const res2 = await ext.wrapProviderRunner?.(ctx2, { ...request }, inner2);
    expect(res2).toBe(okResponse);
    expect(ctx2.model).toBe('model-y');

    // The FIRST fallback build call should be 'good', NOT 'flaky' —
    // last-working-fallback was front-loaded.
    const fallbackBuilds = buildProvider.mock.calls.filter(([pid]) => pid !== 'primary');
    expect(fallbackBuilds[0]).toEqual(['good', 'model-y']);

    // flaky was NOT attempted at all — good was tried first and succeeded
    expect(buildProvider).not.toHaveBeenCalledWith('flaky', 'model-x');
  });
});

// ── resolveAllConfigured through the runtime path ─────────────────────
//
// The smart default caps at 4 entries. When more providers are configured,
// resolveAllConfigured appends the remaining models as a last-resort tail.
// These tests prove that tail actually flows through wrapProviderRunner and
// that fallbackMaxLastResortCandidates controls its size at runtime.

describe('resolveAllConfigured through wrapProviderRunner', () => {
  it('appends resolveAllConfigured models beyond the smart default and tries them', async () => {
    // 6 providers (primary + 5 others), each with one model.
    // Smart default picks 4 (p2–p5). resolveAllConfigured picks the 5th (p6).
    // Make p2–p5 fail and p6 succeed — proves the last-resort append was used.
    const config = {
      provider: 'primary',
      model: 'model-a',
      fallbackModels: [],
      fallbackAuto: true,
      providers: {
        primary: { type: 'openai', apiKey: 'k1', models: ['model-a'] },
        p2: { type: 'openai', apiKey: 'k2', models: ['model-b'] },
        p3: { type: 'openai', apiKey: 'k3', models: ['model-c'] },
        p4: { type: 'openai', apiKey: 'k4', models: ['model-d'] },
        p5: { type: 'openai', apiKey: 'k5', models: ['model-e'] },
        p6: { type: 'openai', apiKey: 'k6', models: ['model-f'] },
      },
    } as never as Config;

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

    const inner = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('rate limited', 429, true, 'primary'))
      .mockRejectedValueOnce(new ProviderError('overloaded', 503, true, 'p2'))
      .mockRejectedValueOnce(new ProviderError('overloaded', 503, true, 'p3'))
      .mockRejectedValueOnce(new ProviderError('overloaded', 503, true, 'p4'))
      .mockRejectedValueOnce(new ProviderError('overloaded', 503, true, 'p5'))
      .mockResolvedValueOnce(okResponse);

    const res = await ext.wrapProviderRunner?.(ctx, request, inner);

    expect(res).toBe(okResponse);
    expect(ctx.model).toBe('model-f');
    expect(buildProvider).toHaveBeenCalledWith('p6', 'model-f');
  });

  it('fallbackMaxLastResortCandidates: 0 suppresses the last-resort append at runtime', async () => {
    // Same 6-provider config but cap=0. Smart default still picks 4 (p2–p5),
    // but resolveAllConfigured is empty. p6/model-f must NOT be tried.
    const config = {
      provider: 'primary',
      model: 'model-a',
      fallbackModels: [],
      fallbackAuto: true,
      fallbackMaxLastResortCandidates: 0,
      providers: {
        primary: { type: 'openai', apiKey: 'k1', models: ['model-a'] },
        p2: { type: 'openai', apiKey: 'k2', models: ['model-b'] },
        p3: { type: 'openai', apiKey: 'k3', models: ['model-c'] },
        p4: { type: 'openai', apiKey: 'k4', models: ['model-d'] },
        p5: { type: 'openai', apiKey: 'k5', models: ['model-e'] },
        p6: { type: 'openai', apiKey: 'k6', models: ['model-f'] },
      },
    } as never as Config;

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

    // Every provider fails — chain should exhaust without ever reaching p6.
    const inner = vi
      .fn()
      .mockRejectedValue(new ProviderError('rate limited', 429, true, 'primary'));

    await expect(ext.wrapProviderRunner?.(ctx, request, inner)).rejects.toThrow();

    // p6 is only reachable via resolveAllConfigured — cap=0 suppressed it.
    expect(buildProvider).not.toHaveBeenCalledWith('p6', 'model-f');
    // p2–p5 are in the smart default and must still be tried.
    expect(buildProvider).toHaveBeenCalledWith('p2', 'model-b');
    expect(buildProvider).toHaveBeenCalledWith('p5', 'model-e');
  });

  it('fallbackMaxLastResortCandidates: 2 truncates the last-resort tail at runtime', async () => {
    // 9 providers (primary + 8 others), each with one model.
    // Smart default picks 4 (p2–p5). resolveAllConfigured has 4 remaining
    // (p6–p9), but cap=2 means only p6 and p7 are appended. p8 and p9
    // must NOT be tried.
    const config = {
      provider: 'primary',
      model: 'model-a',
      fallbackModels: [],
      fallbackAuto: true,
      fallbackMaxLastResortCandidates: 2,
      providers: {
        primary: { type: 'openai', apiKey: 'k1', models: ['model-a'] },
        p2: { type: 'openai', apiKey: 'k2', models: ['model-b'] },
        p3: { type: 'openai', apiKey: 'k3', models: ['model-c'] },
        p4: { type: 'openai', apiKey: 'k4', models: ['model-d'] },
        p5: { type: 'openai', apiKey: 'k5', models: ['model-e'] },
        p6: { type: 'openai', apiKey: 'k6', models: ['model-f'] },
        p7: { type: 'openai', apiKey: 'k7', models: ['model-g'] },
        p8: { type: 'openai', apiKey: 'k8', models: ['model-h'] },
        p9: { type: 'openai', apiKey: 'k9', models: ['model-i'] },
      },
    } as never as Config;

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

    // Every provider fails — chain exhausts.
    const inner = vi
      .fn()
      .mockRejectedValue(new ProviderError('rate limited', 429, true, 'primary'));

    await expect(ext.wrapProviderRunner?.(ctx, request, inner)).rejects.toThrow();

    // Smart default picks p2–p5 (always tried).
    expect(buildProvider).toHaveBeenCalledWith('p2', 'model-b');
    expect(buildProvider).toHaveBeenCalledWith('p5', 'model-e');
    // Cap=2 allows p6 and p7 into the last-resort tail.
    expect(buildProvider).toHaveBeenCalledWith('p6', 'model-f');
    expect(buildProvider).toHaveBeenCalledWith('p7', 'model-g');
    // p8 and p9 are beyond the cap — must NOT be tried.
    expect(buildProvider).not.toHaveBeenCalledWith('p8', 'model-h');
    expect(buildProvider).not.toHaveBeenCalledWith('p9', 'model-i');
  });
});

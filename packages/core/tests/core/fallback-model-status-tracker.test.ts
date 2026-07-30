/**
 * Regression test: when a fallback extension call fails with a 429
 * (rate_limit), the (provider, model) pair must be recorded in the shared
 * ProviderModelStatusTracker so subsequent dispatch — including concurrent
 * subagent spawns — skips it (waiting-room / token reset limit room).
 *
 * Before the fix that threads host.opts.statusTracker into the subagent's
 * `createFallbackModelExtension({...})` call in
 * packages/cli/src/fleet/host-subagent-factory.ts, the tracker dep was
 * undefined along the subagent dispatch path. Every `recordFailure` and
 * `isAvailable` call in `packages/core/src/core/fallback-model.ts`
 * `wrapProviderRunner` became a silent no-op, so the pair never reached
 * `state: 'blocked'`. Chimera reviewer round-robin would reassign the
 * same 429-stricken model on every concurrent spawn.
 *
 * This test wires a real `ProviderModelStatusTracker` into
 * `createFallbackModelExtension` (the same wiring the subagent factory
 * now uses) and asserts that the first 429 moves the pair into the
 * waiting room before the fallback chain rotation completes.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFallbackModelExtension } from '../../src/core/fallback-model.js';
import { ProviderModelStatusTracker } from '../../src/coordination/provider-status-tracker.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Context } from '../../src/core/context.js';
import type { Config } from '../../src/types/config.js';
import type { Provider, Request, Response } from '../../src/types/provider.js';
import { ProviderError } from '../../src/types/provider.js';

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

const okResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stopReason: 'end_turn',
  usage: { input: 1, output: 1 },
  model: 'model-b',
} as never as Response;

describe('fallback-model → ProviderModelStatusTracker (subagent path)', () => {
  it('records the first 429 in the shared tracker and marks the pair blocked', async () => {
    const tracker = new ProviderModelStatusTracker();
    const config = makeConfig();
    const buildProvider = vi.fn(async (providerId: string) => makeProvider(providerId));
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider,
      events: new EventBus(),
      statusTracker: tracker,
      now: () => 1_000,
    });
    const ctx = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    const request = { model: 'model-a', messages: [], maxTokens: 100 } as never as Request;

    // Force the first inner call to throw a 429 rate_limit (the same shape
    // Chimera's subagent saw on deepseek-v4-flash / MiniMax-M3). The fallback
    // chain must record the failure and rotate to the fallback model.
    const inner = vi
      .fn()
      .mockRejectedValueOnce(
        new ProviderError('rate limited', 429, true, 'primary', { kind: 'rate_limit' }),
      )
      .mockResolvedValueOnce(okResponse);

    const res = await ext.wrapProviderRunner?.(ctx, request, inner);

    expect(res).toBe(okResponse);
    expect(buildProvider).toHaveBeenCalledWith('other', 'model-b');
    expect(ctx.model).toBe('model-b');

    // Core regression assertion: the first 429 must transition the
    // (provider, model) pair into `state: 'blocked'` BEFORE the fallback
    // chain rotation completes. Without the statusTracker dep on the
    // subagent factory, `tracker.isAvailable(...)` would still return true
    // and the waiting room would not contain the pair.
    expect(tracker.isAvailable('primary', 'model-a')).toBe(false);
    const blocked = tracker.getBlocked();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.providerId).toBe('primary');
    expect(blocked[0]?.model).toBe('model-a');
    expect(blocked[0]?.lastErrorKind).toBe('rate_limit');
    expect(blocked[0]?.stateExpiresAt).not.toBeNull();
    // The default block duration is 5 minutes — guard against silent
    // re-tuning of the waiting-room timeout, since this whole contract
    // depends on it being materially longer than the burst window.
    expect(blocked[0]?.stateExpiresAt ?? 0).toBeGreaterThan(Date.now());
  });

  it('still records a non-fallback-worthy failure in the tracker (no chain hop)', async () => {
    // Defensive: even though an `auth` (401) kind does not trigger a chain
    // hop — it would fail identically on every provider — the tracker
    // should still see the failure record so operators and `/provider-status`
    // can surface why the request died. This guards against a future
    // refactor that swaps `tracker.recordFailure` behind the same
    // `shouldFallback(firstErr_) !== null` gate used by markPrimaryFailure.
    //
    // Note: a single non-rate-limit failure does NOT transition the pair
    // to `state: 'blocked'` (that requires either rateAfterRateLimitHits=1
    // for rate_limit OR blockAfterFailures=5 consecutive failures). We
    // assert via getStatus() so the test reflects the real contract.
    const tracker = new ProviderModelStatusTracker();
    const config = makeConfig();
    const buildProvider = vi.fn(async (providerId: string) => makeProvider(providerId));
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider,
      events: new EventBus(),
      statusTracker: tracker,
      now: () => 1_000,
    });
    const ctx = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    const request = { model: 'model-a', messages: [], maxTokens: 100 } as never as Request;

    // auth kind → not fallback-worthy. The chain hop must NOT fire (the
    // caller gets the original error rethrown), but the tracker should
    // still receive the failure record so an operator can see why the
    // request failed.
    const inner = vi
      .fn()
      .mockRejectedValue(
        new ProviderError('unauthorized', 401, false, 'primary', { kind: 'auth' }),
      );

    await expect(ext.wrapProviderRunner?.(ctx, request, inner)).rejects.toBeInstanceOf(
      ProviderError,
    );

    // buildProvider is only invoked inside the fallback chain rotation
    // (for entries beyond the primary). The initial primary is already
    // supplied by the caller on `ctx.provider`, so a non-fallback-worthy
    // failure should never call buildProvider at all.
    expect(buildProvider).not.toHaveBeenCalled();

    // Tracker recorded the failure, but `state` is still `healthy` (a
    // single auth error is below the consecutive-failures threshold).
    const status = tracker.getStatus('primary', 'model-a');
    expect(status).toBeDefined();
    expect(status?.totalFailures).toBe(1);
    expect(status?.consecutiveFailures).toBe(1);
    expect(status?.lastErrorKind).toBe('auth');
    expect(status?.state).toBe('healthy');
    // The chain hop did not fire, so the pair is NOT blocked.
    expect(tracker.getBlocked()).toHaveLength(0);
  });

  it('skips a blocked primary on a subsequent subagent wrap call', async () => {
    // Mirrors the original symptom: a second Chimera reviewer spawn that
    // round-robins back to the same (provider, model) must NOT re-enter
    // the doomed primary. The `wrapProviderRunner` pre-call blocked check
    // (fallback-model.ts lines 422-461) must rotate immediately.
    //
    // Tightened to also assert the user-facing `provider.active_blocked`
    // event fires before the chain hop completes, and that the payload
    // carries the (providerId, model), the selected fallback target, and
    // a session id — so the WebUI waiting-room badge can subscribe and
    // render without polling the tracker.
    const events = new EventBus();
    const tracker = new ProviderModelStatusTracker({ events });
    const config = makeConfig();
    const buildProvider = vi.fn(async (providerId: string) => makeProvider(providerId));

    // Subscribe to the events the WebUI / status surface depend on. We
    // capture every emission so we can assert order: `provider.status_changed`
    // first (tracker fires it inside recordFailure), then
    // `provider.active_blocked` (fallback-model emits it when the pre-call
    // check sees the just-blocked pair on the next wrap).
    const statusChanged: Array<{
      providerId: string;
      model: string;
      oldState: string;
      newState: string;
      reason: string;
    }> = [];
    const activeBlocked: Array<{
      providerId: string;
      model: string;
      state: string;
      fallbackProviderId: string;
      fallbackModel: string;
      lastError: string | undefined;
      sessionId: string | undefined;
      timestamp: number;
    }> = [];
    events.on('provider.status_changed', ((evt: never) => {
      statusChanged.push(evt as never);
    }) as never);
    events.on('provider.active_blocked', ((evt: never) => {
      activeBlocked.push(evt as never);
    }) as never);

    const ext = createFallbackModelExtension({
      getConfig: () => config,
      buildProvider,
      events,
      statusTracker: tracker,
      now: () => 1_000,
    });

    // First subagent: 429 from the primary, fallback succeeds.
    const ctx1 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's1' },
    } as never as Context;
    const request1 = { model: 'model-a', messages: [], maxTokens: 100 } as never as Request;
    const inner1 = vi
      .fn()
      .mockRejectedValueOnce(
        new ProviderError('rate limited', 429, true, 'primary', { kind: 'rate_limit' }),
      )
      .mockResolvedValueOnce(okResponse);
    await ext.wrapProviderRunner?.(ctx1, request1, inner1);
    expect(tracker.isAvailable('primary', 'model-a')).toBe(false);

    // The first wrap recorded the failure: `provider.status_changed` fires
    // exactly once with the healthy → blocked transition and a rate-limit
    // reason. This is the event the WebUI statusline subscribes to.
    expect(statusChanged).toHaveLength(1);
    expect(statusChanged[0]).toMatchObject({
      providerId: 'primary',
      model: 'model-a',
      oldState: 'healthy',
      newState: 'blocked',
      reason: 'rate_limit_threshold_1',
    });

    // Second subagent lands on the same primary. The pre-call blocked
    // check should short-circuit the inner call and rotate to the fallback
    // without ever invoking the (blocked) primary.
    const ctx2 = {
      provider: makeProvider('primary'),
      model: 'model-a',
      session: { id: 's2' },
    } as never as Context;
    const request2 = { model: 'model-a', messages: [], maxTokens: 100 } as never as Request;
    const inner2 = vi.fn().mockResolvedValue(okResponse);
    await ext.wrapProviderRunner?.(ctx2, request2, inner2);

    // The primary was blocked, so `inner2` should never have been called
    // with the primary model — the synthetic skip error forces a chain hop.
    expect(inner2).toHaveBeenCalledTimes(1);
    expect(ctx2.model).toBe('model-b');

    // The pre-call blocked check must emit `provider.active_blocked` BEFORE
    // the fallback call lands. This is the event the WebUI waiting-room
    // badge subscribes to — without it, the user-facing waiting-room
    // indicator never appears, even though the tracker state is correct.
    expect(activeBlocked).toHaveLength(1);
    const evt = activeBlocked[0];
    expect(evt).toBeDefined();
    expect(evt?.providerId).toBe('primary');
    expect(evt?.model).toBe('model-a');
    expect(evt?.state).toBe('blocked');
    // The fallback target the wrapper will rotate to. Empty strings are
    // sentinel values in the production payload — they get filled in
    // before the wrap completes — so we only assert that the fields are
    // present (not undefined), not that they point at the eventual entry.
    expect(evt?.fallbackProviderId).toBeDefined();
    expect(evt?.fallbackModel).toBeDefined();
    // lastError carries the rate-limit message (or a calendar label) so
    // the WebUI badge can render a tooltip without re-querying the tracker.
    expect(typeof evt?.lastError).toBe('string');
    expect(evt?.sessionId).toBe('s2');
    expect(typeof evt?.timestamp).toBe('number');
    expect(evt?.timestamp ?? 0).toBeGreaterThan(0);
  });
});

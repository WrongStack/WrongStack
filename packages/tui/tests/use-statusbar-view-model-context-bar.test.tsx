// @vitest-environment jsdom
//
// Regression coverage for the statusline context bar.
//
// Bug being tested: after switching to a different model, the TUI statusline
// ctx bar can show 100% full when the underlying context is not actually at
// capacity. The bug surfaces when cumulative session tokens (the per-request
// `currentRequestTokens()` snapshot is stale/zero during the transition window
// before the new model issues its first request) exceed the new model's
// smaller `maxContext`.
//
// Source contract that this test enforces: per
// `packages/core/src/types/token-counter.ts`, `currentRequestTokens()` is
// "Disjoint token counts from the most recently-accounted request. Sum input +
// cacheRead + cacheWrite for per-request context pressure tracking (e.g.
// status bar ctx bar) — `tokenCounter.total()` is cumulative across all
// requests and cannot be compared meaningfully against a per-request
// maxContext ceiling."

import { renderHook } from '@testing-library/react';
import type { TokenCounter } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import type { AppProps } from '../src/app-props.js';
import type { State } from '../src/app-state.js';
import { useStatusbarViewModel } from '../src/hooks/use-statusbar-view-model.js';

/**
 * Minimal Agent stub — only the `ctx.provider.capabilities.maxContext` field
 * is touched by useStatusbarViewModel when `activeMaxContext` is undefined.
 * The hook falls back to `agent.ctx.provider.capabilities.maxContext` only
 * when `activeMaxContext` is undefined; supplying an explicit
 * `activeMaxContext` short-circuits the lookup entirely.
 */
function makeAgent(maxContext: number): AppProps['agent'] {
  return {
    ctx: {
      provider: {
        capabilities: { maxContext },
      },
      meta: {},
    },
  } as unknown as AppProps['agent'];
}

/**
 * State stub — only the fields `useStatusbarViewModel` reads are populated.
 * `contextChipVersion` lives on `state` (as shown by the useMemo deps array);
 * a minimal state with `contextPanelOpen: false` skip the
 * `getContextBreakdown` call, matching the "bar only" path.
 */
function makeState(): State {
  return {
    contextPanelOpen: false,
    contextChipVersion: 0,
    fleet: {},
    leader: {
      iterations: 0,
      toolCalls: 0,
      recentTools: [],
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      currentTool: null,
      ctxPct: 0,
      ctxTokens: 0,
    },
    status: 'idle',
  } as unknown as State;
}

/**
 * Build a tokenCounter whose `currentRequestTokens()` returns the
 * post-switch first-request snapshot (zero until the new model emits a
 * request) and whose `total()` returns the cumulative session tokens from
 * the previous model. This is the exact state the bar sees in the window
 * between `/model` and the new model's first provider.response.
 */
function makeTokenCounter(opts: {
  currentRequest: { input: number; cacheRead: number; cacheWrite: number };
  cumulative: { input: number; cacheRead: number; cacheWrite: number };
}): TokenCounter {
  return {
    account: () => undefined,
    setSessionId: () => undefined,
    currentRequestTokens: () => opts.currentRequest,
    setCurrentRequestTokens: () => undefined,
    total: () => ({ ...opts.cumulative, output: 0 }),
    estimateCost: () => ({ input: 0, output: 0, total: 0, currency: 'USD' }),
    cacheStats: () => ({ hitRatio: 0, readTokens: 0, writeTokens: 0, savedUsd: 0 }),
    reset: () => undefined,
  };
}

describe('useStatusbarViewModel — context bar (model-switch regression)', () => {
  it('does not show 100% when cumulative tokens exceed the new model maxContext', () => {
    // Scenario: a 200k model is the current active. The user has been
    // working a long session so cumulative tokens are 60k. They switch to
    // a small 8k-context model. The new model hasn't fired its first
    // request yet, so currentRequestTokens() returns zero.
    //
    // Expected: bar reflects "no recent request yet" — either the previous
    // model's last-request snapshot (which the user knows was 60k and
    // cannot fit in the new 8k window) or, with the per-request contract
    // strictly enforced, the bar should not show 100% from a *cumulative*
    // number that is conceptually unrelated to the new model's window.
    //
    // What the user actually sees today: the bar reads 100% because the
    // fallback `total()` (60k) is clamped to maxContext (8k), and 8k / 8k = 1.
    const tokenCounter = makeTokenCounter({
      currentRequest: { input: 0, cacheRead: 0, cacheWrite: 0 },
      cumulative: { input: 60_000, cacheRead: 0, cacheWrite: 0 },
    });
    const agent = makeAgent(200_000);

    const { result } = renderHook(() =>
      useStatusbarViewModel({
        agent,
        tokenCounter,
        activeMaxContext: 8_000, // post-/model switch: new model has 8k window
        effectiveMaxContext: 8_000,
        liveProvider: 'openai',
        liveModel: 'gpt-4o-mini',
        liveTodos: [],
        state: makeState(),
      }),
    );

    const ctx = result.current.contextWindow;
    // The bar must produce a defined, internally consistent window.
    expect(ctx).toBeDefined();
    expect(ctx!.max).toBe(8_000);

    // The bug: with currentRequest=0 the fallback uses cumulative=60k,
    // which is then clamped to maxContext=8k, yielding a 1.0 (100%) ratio
    // for a context that has not actually been sent to the new model yet.
    //
    // The TypeScript contract on TokenCounter says the status bar must use
    // per-request tokens, not cumulative. Until the new model issues its
    // first request, the bar should not paint 100% from session-accumulated
    // numbers that pre-date the switch.
    const usedRatio = ctx!.used / ctx!.max;
    expect(usedRatio).toBeLessThan(1);
  });

  it('caps currentRequestTokens at maxContext (not cumulative totals)', () => {
    // Scenario: the new model has already fired a request that is 7k
    // tokens — close to but under the 8k window. The cumulative counter
    // is 60k from the previous model. The bar should be a 7k/8k = 87.5%
    // reading, never 8k/8k = 100% from the cumulative fallback.
    const tokenCounter = makeTokenCounter({
      currentRequest: { input: 7_000, cacheRead: 0, cacheWrite: 0 },
      cumulative: { input: 60_000, cacheRead: 0, cacheWrite: 0 },
    });
    const agent = makeAgent(200_000);

    const { result } = renderHook(() =>
      useStatusbarViewModel({
        agent,
        tokenCounter,
        activeMaxContext: 8_000,
        effectiveMaxContext: 8_000,
        liveProvider: 'openai',
        liveModel: 'gpt-4o-mini',
        liveTodos: [],
        state: makeState(),
      }),
    );

    const ctx = result.current.contextWindow;
    expect(ctx).toBeDefined();
    expect(ctx!.used).toBe(7_000);
    expect(ctx!.max).toBe(8_000);
  });

  it('hides the context bar when neither per-request nor agent capabilities are available', () => {
    // When contextPanelOpen is false and per-request tokens are zero AND
    // the agent has no maxContext capability, the bar should be hidden
    // rather than pinned at the fallback cumulative total.
    const tokenCounter = makeTokenCounter({
      currentRequest: { input: 0, cacheRead: 0, cacheWrite: 0 },
      cumulative: { input: 60_000, cacheRead: 0, cacheWrite: 0 },
    });
    const agent = makeAgent(0); // no maxContext capability

    const { result } = renderHook(() =>
      useStatusbarViewModel({
        agent,
        tokenCounter,
        activeMaxContext: undefined,
        effectiveMaxContext: undefined,
        liveProvider: 'openai',
        liveModel: 'unknown-model',
        liveTodos: [],
        state: makeState(),
      }),
    );

    // maxContext = 0 means the hook returns undefined and the bar is hidden.
    // This is the current behavior and should be preserved.
    expect(result.current.contextWindow).toBeUndefined();
  });
});

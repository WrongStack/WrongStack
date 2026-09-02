// @vitest-environment jsdom
//
// Regression coverage for the `ctx.pct` → statusline/`/context` rate limit.
//
// The bridge rate-limits leader and subagent context-fill dispatches to one per
// 250ms. That throttle used to be leading-edge only: an event arriving inside
// the window was dropped and never re-delivered. Because `emitContextPct()`
// fires at the end of every agent-loop iteration and a tool-only iteration can
// finish in tens of milliseconds, the *last* emit of a turn was routinely the
// one discarded — leaving the ctx chip and the `/context` panel pinned to an
// older, lower reading until some later turn happened to emit outside a window.

import { renderHook } from '@testing-library/react';
import type { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../src/app-reducer.js';
import {
  providerContextLimitHistoryEntry,
  useSubagentEvents,
} from '../src/hooks/use-subagent-events.js';

describe('providerContextLimitHistoryEntry', () => {
  it('formats only live provider decreases as warnings', () => {
    expect(
      providerContextLimitHistoryEntry({
        providerId: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        previousMaxContext: 1_050_000,
        maxContext: 272_000,
        source: 'provider',
        decreased: true,
      }),
    ).toEqual({
      kind: 'warn',
      text:
        '⚠ provider context limit changed: 1,050,000 → 272,000 tokens ' +
        '(openai-codex/gpt-5.6-sol). Preflight recovery now uses the lower limit.',
    });
    expect(
      providerContextLimitHistoryEntry({
        providerId: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        previousMaxContext: 272_000,
        maxContext: 1_050_000,
        source: 'provider',
        decreased: false,
      }),
    ).toBeNull();
  });
});

/** Minimal EventBus: records handlers so the test can emit synchronously. */
function makeBus(): EventBus & { fire: (name: string, payload: unknown) => void } {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const bus = {
    on(name: string, cb: (payload: unknown) => void) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(cb);
      return () => set!.delete(cb);
    },
    emit() {
      /* unused by these tests */
    },
    fire(name: string, payload: unknown) {
      for (const cb of handlers.get(name) ?? []) cb(payload);
    },
  };
  return bus as unknown as EventBus & { fire: (name: string, payload: unknown) => void };
}

function ctxPct(tokens: number, load: number) {
  return { sessionId: 'sess-1', load, tokens, maxContext: 200_000 };
}

describe('useSubagentEvents — leader ctx.pct throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mount() {
    const events = makeBus();
    const dispatched: Action[] = [];
    const dispatch = ((a: Action) => dispatched.push(a)) as React.Dispatch<Action>;
    const view = renderHook(() =>
      useSubagentEvents(
        events,
        dispatch,
        () => undefined,
        () => 'sess-1',
      ),
    );
    const leaderCtx = () =>
      dispatched.filter((a): a is Action & { tokens: number } => a.type === 'leaderCtxPct');
    return { events, leaderCtx, view };
  }

  it('delivers the newest reading after a throttled burst', () => {
    const { events, leaderCtx } = mount();

    events.fire('ctx.pct', ctxPct(40_000, 0.2));
    expect(leaderCtx().map((a) => a.tokens)).toEqual([40_000]);

    // Two more iterations finish inside the 250ms window. Both are rate-limited,
    // but the newest value must still arrive on the trailing edge.
    vi.advanceTimersByTime(30);
    events.fire('ctx.pct', ctxPct(52_000, 0.26));
    vi.advanceTimersByTime(30);
    events.fire('ctx.pct', ctxPct(61_500, 0.31));
    expect(leaderCtx().map((a) => a.tokens)).toEqual([40_000]);

    vi.advanceTimersByTime(250);
    expect(leaderCtx().map((a) => a.tokens)).toEqual([40_000, 61_500]);
  });

  it('does not defer readings that arrive outside the window', () => {
    const { events, leaderCtx } = mount();

    events.fire('ctx.pct', ctxPct(40_000, 0.2));
    vi.advanceTimersByTime(300);
    events.fire('ctx.pct', ctxPct(55_000, 0.27));

    expect(leaderCtx().map((a) => a.tokens)).toEqual([40_000, 55_000]);
  });

  it('cancels a pending trailing flush on unmount', () => {
    const { events, leaderCtx, view } = mount();

    events.fire('ctx.pct', ctxPct(40_000, 0.2));
    events.fire('ctx.pct', ctxPct(61_500, 0.31));
    view.unmount();
    vi.advanceTimersByTime(500);

    // The deferred dispatch belonged to the unmounted effect lifetime — firing
    // it would push a previous session's reading into the new reducer.
    expect(leaderCtx().map((a) => a.tokens)).toEqual([40_000]);
  });
});

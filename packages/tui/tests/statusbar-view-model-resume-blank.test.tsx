// @vitest-environment jsdom
//
// The sidebar's session-scoped cards must go blank for the length of a
// `/resume`, the way the transcript already does.
//
// `resumeLoadStart` wipes the screen to the clean slate `/clear` leaves and
// clears `state.leader.ctxTokens` — but that is only the FIRST rung of the
// context-fill ladder. The per-request snapshot on the token counter and the
// local estimate over `agent.ctx.messages` both keep answering from the
// LEAVING session until the host reaches its writer swap and
// `token_accounting` stages, seconds later. Until this gate existed, MODEL
// CORE drew the old conversation's fill and PROMPT CACHE advertised its hit
// ratio underneath the incoming session's loading block.
//
// Source contract enforced here:
// `packages/tui/src/hooks/use-statusbar-view-model.ts` — `resuming`.

import { renderHook } from '@testing-library/react';
import type { TokenCounter } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { AppProps } from '../src/app-props.js';
import type { State } from '../src/app-state.js';
import { useStatusbarViewModel } from '../src/hooks/use-statusbar-view-model.js';
import type { ResumeLoadState } from '../src/resume-load.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, default: actual, stat: vi.fn(), readFile: vi.fn() };
});

/** Only the fields the view model reads. `meta` is empty so no chip polls. */
function makeAgent(): AppProps['agent'] {
  return {
    ctx: { provider: { capabilities: { maxContext: 200_000 } }, meta: {} },
  } as unknown as AppProps['agent'];
}

/** A counter carrying the LEAVING session's numbers — the ones to suppress. */
function busyTokenCounter(): TokenCounter {
  return {
    account: () => undefined,
    setSessionId: () => undefined,
    currentRequestTokens: () => ({ input: 90_000, cacheRead: 30_000, cacheWrite: 0 }),
    setCurrentRequestTokens: () => undefined,
    total: () => ({ input: 400_000, output: 20_000, cacheRead: 900_000, cacheWrite: 1_000 }),
    estimateCost: () => ({ input: 1, output: 1, total: 2, currency: 'USD' }),
    cacheStats: () => ({
      hitRatio: 0.82,
      readTokens: 900_000,
      writeTokens: 1_000,
      savedUsd: 3.5,
    }),
    reset: () => undefined,
  };
}

function makeState(resumeLoad: ResumeLoadState | null): State {
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
      // Deliberately non-zero: the reducer clears this at `resumeLoadStart`,
      // but the gate must not depend on that having happened — a late render
      // between the dispatch and the commit still has to blank the card.
      ctxTokens: 120_000,
    },
    resumeLoad,
    status: 'idle',
  } as unknown as State;
}

function loading(): ResumeLoadState {
  return {
    sessionId: '2026-08-29/sess_incoming',
    label: 'incoming',
    blockEntryId: 2,
    phase: 'reading',
    loadedBytes: 1024,
    totalBytes: 8192,
    log: [],
    replayed: 0,
    total: 0,
    frame: 3,
  };
}

function render(resumeLoad: ResumeLoadState | null) {
  return renderHook(() =>
    useStatusbarViewModel({
      agent: makeAgent(),
      tokenCounter: busyTokenCounter(),
      activeMaxContext: 200_000,
      effectiveMaxContext: 200_000,
      liveProvider: 'anthropic',
      liveModel: 'claude',
      liveTodos: [],
      sidebarVisible: true,
      state: makeState(resumeLoad),
    }),
  );
}

describe('useStatusbarViewModel — blanked while a /resume loads', () => {
  it('reports the leaving session normally when no resume is in flight', () => {
    const { result, unmount } = render(null);

    expect(result.current.contextWindow).toEqual({ used: 120_000, max: 200_000 });
    expect(result.current.cacheStats.readTokens).toBe(900_000);
    expect(result.current.cacheStats.hitRatio).toBeCloseTo(0.82);
    expect(result.current.cacheCoverageTokens).toBe(30_000);

    unmount();
  });

  it('drops the context window entirely while the journal is read', () => {
    const { result, unmount } = render(loading());

    // `undefined`, not a zeroed window: MODEL CORE renders a missing window as
    // "awaiting telemetry", while `{used: 0}` would draw a confident empty
    // meter for a conversation nobody has decided on yet.
    expect(result.current.contextWindow).toBeUndefined();
    expect(result.current.currentContextTokens).toBe(0);

    unmount();
  });

  it('zeroes the prompt-cache card while the journal is read', () => {
    const { result, unmount } = render(loading());

    expect(result.current.cacheStats).toEqual({
      readTokens: 0,
      writeTokens: 0,
      hitRatio: 0,
      savedUsd: 0,
    });
    expect(result.current.cacheCoverageTokens).toBe(0);

    unmount();
  });

  it('skips the context breakdown walk while the journal is read', () => {
    // The walk would measure `agent.ctx.messages`, which still holds the OLD
    // transcript until the host swaps the writer — and the result is discarded
    // anyway. Not paying for it keeps the spinner moving on a large journal.
    const { result, unmount } = render(loading());

    expect(result.current.contextBreakdown).toBeUndefined();

    unmount();
  });

  it('restores the live readings once the resume settles', () => {
    const { result, rerender, unmount } = render(loading());
    expect(result.current.contextWindow).toBeUndefined();

    // The terminating chunk sets `resumeLoad: null`. A resume that FAILED or
    // landed read-only takes the same path — the agent is back in the session
    // it never left, so its real numbers must come back rather than staying
    // falsely empty.
    rerender();
    const settled = render(null);
    expect(settled.result.current.contextWindow).toEqual({ used: 120_000, max: 200_000 });
    expect(settled.result.current.cacheStats.readTokens).toBe(900_000);

    settled.unmount();
    unmount();
  });

  it('treats an absent resumeLoad as "not resuming"', () => {
    // Partial state stubs (and any host predating the field) leave it
    // `undefined`; that must not blank every reading in the sidebar.
    const { result, unmount } = render(undefined as unknown as null);

    expect(result.current.contextWindow).toEqual({ used: 120_000, max: 200_000 });

    unmount();
  });
});

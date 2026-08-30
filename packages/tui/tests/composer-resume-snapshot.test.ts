import { describe, expect, it } from 'vitest';
import type { Action } from '../src/app-action-type.js';
import { reducer } from '../src/app-reducer.js';
import { TUI_RESUME_HISTORY_BUDGET } from '../src/history-retention.js';
import { reduceComposer } from '../src/reducers/composer.js';
import { createTestState } from './helpers/create-test-state.js';

/**
 * Regression tests for the `replaceHistory` context-window snapshot path in
 * `reducers/composer.ts`.
 *
 * `replaceHistory` is only ever dispatched on a session resume (see
 * `hooks/use-app-picker-keys.ts`). The snapshot it carries is the resumed
 * session's authoritative context number and must overwrite any stale
 * `state.leader.ctxTokens` left over from the PREVIOUS session. A previous
 * revision gated the write on `state.leader.ctxTokens === undefined`, which
 * rejected every snapshot after the first resume (or after any ctx.pct event)
 * and left the statusline chip showing the old session's tokens.
 */
describe('reduceComposer replaceHistory context snapshot', () => {
  const replaceHistory = (contextSnapshot?: {
    tokens: number;
    maxContext: number;
  }): Extract<Action, { type: 'replaceHistory' }> => ({
    type: 'replaceHistory',
    entries: [],
    nextId: 1,
    contextSnapshot,
  });

  it('overwrites a stale ctxTokens from a previous session on a second resume', () => {
    const base = createTestState();
    // Simulate a prior resume (or a ctx.pct event) having already populated the
    // leader's context numbers for the session we are ABOUT to leave.
    const state = createTestState({
      leader: { ...base.leader, ctxTokens: 999, ctxMaxTokens: 1000 },
    });

    const next = reduceComposer(state, replaceHistory({ tokens: 500, maxContext: 2000 }));

    expect(next.leader.ctxTokens).toBe(500);
    expect(next.leader.ctxMaxTokens).toBe(2000);
  });

  it('applies the snapshot on a first resume when ctxTokens is still undefined', () => {
    const state = createTestState();
    expect(state.leader.ctxTokens).toBeUndefined();

    const next = reduceComposer(state, replaceHistory({ tokens: 750, maxContext: 4096 }));

    expect(next.leader.ctxTokens).toBe(750);
    expect(next.leader.ctxMaxTokens).toBe(4096);
  });

  it('does not write a zero-token snapshot (guard preserved)', () => {
    const base = createTestState();
    const state = createTestState({
      leader: { ...base.leader, ctxTokens: 999, ctxMaxTokens: 1000 },
    });

    const next = reduceComposer(state, replaceHistory({ tokens: 0, maxContext: 2000 }));

    // A zero-token snapshot is treated as "no measurement" — the prior value is
    // left untouched rather than blanking the chip to 0.
    expect(next.leader.ctxTokens).toBe(999);
    expect(next.leader.ctxMaxTokens).toBe(1000);
  });

  it('keeps the prior ctxMaxTokens when the snapshot ceiling is 0', () => {
    const base = createTestState();
    const state = createTestState({
      leader: { ...base.leader, ctxTokens: 999, ctxMaxTokens: 1000 },
    });

    // Provider without capabilities.maxContext degrades to a 0 ceiling; the
    // reducer must keep the previous session's ceiling rather than drop to 0.
    const next = reduceComposer(state, replaceHistory({ tokens: 500, maxContext: 0 }));

    expect(next.leader.ctxTokens).toBe(500);
    expect(next.leader.ctxMaxTokens).toBe(1000);
  });

  it('leaves the leader untouched when no snapshot is provided', () => {
    const base = createTestState();
    const state = createTestState({
      leader: { ...base.leader, ctxTokens: 999, ctxMaxTokens: 1000 },
    });

    const next = reduceComposer(state, replaceHistory(undefined));

    expect(next.leader.ctxTokens).toBe(999);
    expect(next.leader.ctxMaxTokens).toBe(1000);
  });
});

/**
 * `replaceHistory` is the resume boundary, so it also carries the two pieces of
 * state that make a resume behave like a resume: a widened retention budget and
 * a hold on automatic turns. Both were previously absent, which is why a large
 * session appeared not to load (trimmed to 400 entries one dispatch later) and
 * why a session with an open todo board started a turn by itself.
 */
describe('reduceComposer replaceHistory resume posture', () => {
  const entries = Array.from({ length: 500 }, (_, index) => ({
    id: index + 1,
    kind: 'info' as const,
    text: `entry-${index + 1}`,
  }));

  it('keeps more than the live cap and persists the budget for later entries', () => {
    const resumed = reduceComposer(createTestState(), {
      type: 'replaceHistory',
      entries,
      nextId: entries.length + 1,
    });

    expect(resumed.entries).toHaveLength(entries.length);
    expect(resumed.historyBudget).toBe(TUI_RESUME_HISTORY_BUDGET);

    // The very next dispatch is the "Resumed session …" line. Under the live
    // budget it would re-trim the transcript to 400 immediately.
    const afterNotice = reducer(resumed, {
      type: 'addEntry',
      entry: { kind: 'info', text: 'Resumed session X — 500 entries replayed.' },
    });
    expect(afterNotice.entries).toHaveLength(entries.length + 1);
  });

  it('holds auto-proceed until a manual submit releases it', () => {
    const resumed = reduceComposer(createTestState(), {
      type: 'replaceHistory',
      entries: [],
      nextId: 1,
    });
    expect(resumed.autoProceedHold).toBe(true);

    const released = reducer(resumed, { type: 'autoProceedRelease' });
    expect(released.autoProceedHold).toBe(false);
    // Idempotent: the submit path fires this on every message, and a new state
    // object per keystroke-sized dispatch would schedule pointless renders.
    expect(reducer(released, { type: 'autoProceedRelease' })).toBe(released);
  });
});

import { describe, expect, it } from 'vitest';
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
  const replaceHistory = (contextSnapshot?: { tokens: number; maxContext: number }) =>
    ({
      type: 'replaceHistory',
      entries: [],
      nextId: 1,
      contextSnapshot,
    }) as const;

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

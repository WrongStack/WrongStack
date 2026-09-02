import { describe, expect, it } from 'vitest';
import { resolveContextFill } from '../src/context-fill.js';

const MAX = 1_000_000;

describe('resolveContextFill', () => {
  it('prefers the agent loop ctx.pct number so the chip matches /context', () => {
    // Both the panel and the chip must show 420_000 here.
    const r = resolveContextFill({
      loopReportedTokens: 420_000,
      perRequestTokens: 380_000,
      localEstimate: 401_000,
      maxContext: MAX,
    });
    expect(r).toEqual({ used: 420_000, needsLocalEstimate: false, source: 'loop' });
  });

  it('falls back to the per-request provider snapshot before the first ctx.pct', () => {
    const r = resolveContextFill({ perRequestTokens: 12_345, maxContext: MAX });
    expect(r).toEqual({ used: 12_345, needsLocalEstimate: false, source: 'provider' });
  });

  it('asks for a local estimate when neither loop nor provider reported', () => {
    expect(resolveContextFill({ perRequestTokens: 0, maxContext: MAX }).needsLocalEstimate).toBe(
      true,
    );
    const r = resolveContextFill({ perRequestTokens: 0, localEstimate: 88_000, maxContext: MAX });
    expect(r).toEqual({ used: 88_000, needsLocalEstimate: true, source: 'local' });
  });

  it('reports nothing rather than guessing when every source is empty', () => {
    expect(resolveContextFill({ perRequestTokens: 0, maxContext: MAX })).toEqual({
      used: 0,
      needsLocalEstimate: true,
      source: 'none',
    });
  });

  // --- Regressions for the false "1.0M/1.0M" (100%) bar ---

  it('rejects a per-request snapshot above the ceiling instead of clamping to 100%', () => {
    // Fallback moved the session to a smaller window; the snapshot still
    // belongs to the previous model. Clamping it would read as a full context.
    const r = resolveContextFill({
      perRequestTokens: 900_000,
      localEstimate: 150_000,
      maxContext: 200_000,
    });
    expect(r).toEqual({ used: 150_000, needsLocalEstimate: true, source: 'local' });
  });

  it('uses the local estimate when the provider under-reports prompt tokens', () => {
    // The bug: perRequest collapsed to 0 (provider reported usage.input = 0),
    // the old code substituted the cumulative session total (millions) and
    // clamped it to maxContext. Cumulative is no longer an input at all, so the
    // only thing left to fall back to is the truthful local estimate.
    const r = resolveContextFill({
      loopReportedTokens: 0,
      perRequestTokens: 0,
      localEstimate: 240_000,
      maxContext: MAX,
    });
    expect(r.used).toBe(240_000);
    expect(r.used).not.toBe(MAX);
    expect(r.source).toBe('local');
  });

  it('never exceeds the ceiling from any source', () => {
    expect(
      resolveContextFill({ loopReportedTokens: 2 * MAX, perRequestTokens: 0, maxContext: MAX })
        .used,
    ).toBe(MAX);
    expect(
      resolveContextFill({ perRequestTokens: 0, localEstimate: 2 * MAX, maxContext: MAX }).used,
    ).toBe(MAX);
  });

  it('does not clamp to zero when the ceiling is unknown', () => {
    const r = resolveContextFill({
      loopReportedTokens: 50_000,
      perRequestTokens: 0,
      maxContext: 0,
    });
    expect(r).toEqual({ used: 50_000, needsLocalEstimate: false, source: 'loop' });
  });
});

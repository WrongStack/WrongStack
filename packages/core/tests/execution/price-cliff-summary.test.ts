import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { describePriceCliffForContext } from '../../src/execution/compaction-thresholds.js';
import { priceCliffRouteKey, writePriceCliffMeta } from '../../src/utils/price-cliff.js';

const ONE_M = 1_000_000;
/** 1M window minus the default output (8192) and safety (4096) reserves. */
const AVAILABLE = 987_712;
const BALANCED = { warn: 0.55, soft: 0.7, hard: 0.85 };

function ctxWith(cliff: { cliffTokens: number; multiplier?: number } | null): Context {
  const meta: Record<string, unknown> = {};
  if (cliff) {
    writePriceCliffMeta(
      meta,
      {
        cliffTokens: cliff.cliffTokens,
        ...(cliff.multiplier !== undefined ? { multiplier: cliff.multiplier } : {}),
        field: 'input',
      },
      priceCliffRouteKey('anthropic', 'claude-x'),
    );
  }
  return {
    meta,
    provider: { id: 'anthropic', capabilities: { maxContext: ONE_M } },
    model: 'claude-x',
  } as never as Context;
}

describe('describePriceCliffForContext', () => {
  it('reports the capped trigger, the uncapped one and the landing target', () => {
    const summary = describePriceCliffForContext(
      ctxWith({ cliffTokens: 200_000, multiplier: 2 }),
      150_000,
      ONE_M,
      BALANCED,
      0.65,
    );
    expect(summary).toBeDefined();
    expect(summary?.cliffTokens).toBe(200_000);
    expect(summary?.binding).toBe(true);
    // min(threshold x window, cliff x 0.95): 190K wins over 0.7 x 987,712.
    expect(summary?.triggerTokens).toBe(190_000);
    expect(summary?.uncappedTriggerTokens).toBe(Math.floor(0.7 * AVAILABLE));
    expect(summary?.targetTokens).toBeLessThan(summary!.triggerTokens);
    expect(summary?.availableInputTokens).toBe(AVAILABLE);
    expect(summary?.inputTokens).toBe(150_000);
    expect(summary?.tokensToTrigger).toBe(40_000);
  });

  it('reports a crossed cliff as negative headroom, not as zero', () => {
    const summary = describePriceCliffForContext(
      ctxWith({ cliffTokens: 200_000 }),
      250_000,
      ONE_M,
      BALANCED,
      0.65,
    );
    expect(summary?.tokensToTrigger).toBeLessThan(0);
  });

  it('stays silent when the window-relative ladder already beats the cliff', () => {
    // 900K boundary vs a 0.7 rung: the cliff is not what saves money here.
    expect(
      describePriceCliffForContext(
        ctxWith({ cliffTokens: 900_000 }),
        150_000,
        ONE_M,
        BALANCED,
        0.65,
      ),
    ).toBeUndefined();
  });

  it('stays silent with no published cliff, a stale route, or an unknown window', () => {
    const noCliff = ctxWith(null);
    expect(describePriceCliffForContext(noCliff, 150_000, ONE_M, BALANCED, 0.65)).toBeUndefined();

    const stale = ctxWith({ cliffTokens: 200_000 });
    stale.model = 'other-model';
    expect(describePriceCliffForContext(stale, 150_000, ONE_M, BALANCED, 0.65)).toBeUndefined();

    const withWindow = ctxWith({ cliffTokens: 200_000 });
    const noWindow = {
      ...withWindow,
      provider: { ...withWindow.provider, capabilities: {} },
    } as never as Context;
    expect(describePriceCliffForContext(noWindow, 150_000, 0, BALANCED, 0.65)).toBeUndefined();
  });

  it('uses the session meta window override, like the ladder does', () => {
    const ctx = ctxWith({ cliffTokens: 200_000 });
    ctx.meta['effectiveMaxContext'] = 300_000;
    const summary = describePriceCliffForContext(ctx, 100_000, ONE_M, BALANCED, 0.65);
    // 300K window → available 287,712; 200K cliff is reachable and binding.
    expect(summary?.availableInputTokens).toBe(287_712);
    expect(summary?.triggerTokens).toBe(190_000);
  });

  it('falls back to the default ladder when the policy carries no thresholds', () => {
    const summary = describePriceCliffForContext(
      ctxWith({ cliffTokens: 200_000 }),
      150_000,
      ONE_M,
      null,
      null,
    );
    expect(summary?.binding).toBe(true);
    expect(summary?.triggerTokens).toBe(190_000);
  });
});

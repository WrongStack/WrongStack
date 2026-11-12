import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { describePriceCliffForContext } from '../../src/execution/compaction-thresholds.js';
import { recordToolOutputEvidence } from '../../src/utils/context-evidence.js';
import { priceCliffRouteKey, writePriceCliffMeta } from '../../src/utils/price-cliff.js';

const ONE_M = 1_000_000;
/** 1M window minus the default output (8192) and safety (4096) reserves. */
const AVAILABLE = 987_712;
const BALANCED = { warn: 0.55, soft: 0.7, hard: 0.85 };

/**
 * Drive the repeated-read pressure the compaction ladder reacts to, through the
 * production recorder rather than forged state: `reads` consecutive reads of one
 * file. Two reads reach count 2, three reach count 3 — the point where
 * `adaptThresholdsForSignals` pulls warn 0.55 → 0.47 and soft 0.70 → 0.66.
 */
function applyRepeatedReads(ctx: Context, reads: number): void {
  for (let i = 0; i < reads; i++) {
    recordToolOutputEvidence(ctx as never, {
      toolUseId: `tu_${i}`,
      toolName: 'read',
      input: { path: 'src/a.ts' },
      content: 'export const a = 1;\n',
      ok: true,
    });
  }
}

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

/**
 * The report must be built from the SAME rung pipeline the compaction ladder
 * uses: sanitizeThresholds → adaptThresholdsForSignals → adjustLadderForPriceCliff
 * (auto-compaction-middleware.ts:256-280). Skipping the adapt rung made
 * `/context cliff` and the Context X-Ray advertise a money cap the ladder was
 * not applying, because repeated reads had already pulled the soft rung under
 * the boundary.
 */
describe('describePriceCliffForContext — adaptive rungs under repeated-read pressure', () => {
  /**
   * 660K boundary over the 987,712-token input budget = load 0.668: above the
   * adaptive soft rung (0.66) so the ladder fires window-relative and beats it,
   * below the un-adapted rung (0.70) which used to call it a binding cap.
   */
  const PRESSURED_BOUNDARY = 660_000;

  it('declines to report a cliff the window-relative rung already beats', () => {
    const ctx = ctxWith({ cliffTokens: PRESSURED_BOUNDARY, multiplier: 2 });
    applyRepeatedReads(ctx, 3);

    expect(
      describePriceCliffForContext(ctx, 150_000, ONE_M, BALANCED, 0.65),
      'FAIL: rendered a binding price-cliff cap the compaction ladder is not honoring',
    ).toBeUndefined();
  });

  it('adapts only at the ladder threshold: two reads keep the cap in force', () => {
    const twoReads = ctxWith({ cliffTokens: PRESSURED_BOUNDARY });
    applyRepeatedReads(twoReads, 2);
    expect(describePriceCliffForContext(twoReads, 150_000, ONE_M, BALANCED, 0.65)?.binding).toBe(
      true,
    );

    const threeReads = ctxWith({ cliffTokens: PRESSURED_BOUNDARY });
    applyRepeatedReads(threeReads, 3);
    expect(
      describePriceCliffForContext(threeReads, 150_000, ONE_M, BALANCED, 0.65),
    ).toBeUndefined();
  });

  it('measures the uncapped rung against the adaptive soft the ladder uses', () => {
    // A 200K boundary still binds at soft 0.66, so the report stays live — but
    // "would fire by window alone" is the ADAPTED rung, not the configured 0.70.
    const ctx = ctxWith({ cliffTokens: 200_000 });
    applyRepeatedReads(ctx, 3);
    const summary = describePriceCliffForContext(ctx, 150_000, ONE_M, BALANCED, 0.65);

    expect(summary?.binding).toBe(true);
    expect(summary?.triggerTokens).toBe(190_000);
    expect(summary?.uncappedTriggerTokens).toBe(Math.floor(0.66 * AVAILABLE));
  });

  it('control: unchanged for a session with no repeated reads', () => {
    const ctx = ctxWith({ cliffTokens: PRESSURED_BOUNDARY, multiplier: 2 });
    const summary = describePriceCliffForContext(ctx, 150_000, ONE_M, BALANCED, 0.65);

    expect(summary?.binding).toBe(true);
    expect(summary?.triggerTokens).toBe(Math.floor(PRESSURED_BOUNDARY * 0.95));
    expect(summary?.uncappedTriggerTokens).toBe(Math.floor(0.7 * AVAILABLE));
  });
});

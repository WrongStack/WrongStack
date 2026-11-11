import type { Compactor } from '@wrongstack/contracts/types/compactor';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { AutoCompactionMiddleware } from '../../src/execution/auto-compaction-middleware.js';
import {
  priceCliffRouteForContext,
  priceCliffRouteKey,
  writePriceCliffMeta,
} from '../../src/utils/price-cliff.js';

const ONE_M = 1_000_000;
const CLIFF = 200_000;
/** Balanced rungs: soft fires at 0.7 x ~988K ≈ 691K — far past a 200K tier. */
const BALANCED = { warn: 0.55, soft: 0.7, hard: 0.85 };

function mockContext(tokens: number): Context {
  const ctx = {
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    provider: { id: 'testprov' } as never,
    session: { id: '2026-11-11/sess_01PRICECLIFF0000000000000' } as never,
    signal: new AbortController().signal,
    tokenCounter: {} as never,
    cwd: '/tmp',
    projectRoot: '/tmp',
    model: 'testmodel',
    tools: [],
    meta: {} as Record<string, unknown>,
    clearFileTracking: () => {},
  } as never as Context;
  let revision = 0;
  Object.defineProperty(ctx, 'state', {
    value: {
      get revision() {
        return revision;
      },
      replaceMessages(messages: Context['messages']) {
        ctx.messages = messages;
        revision++;
      },
    },
  });
  ctx.lastRequestTokens = tokens;
  ctx.lastRealInputTokens = tokens;
  ctx.meta['lastRequestTokensAt'] = { msgCount: 0, toolCount: 0 };
  ctx.meta['realAnchorMsgCount'] = 0;
  return ctx;
}

function mockCompactor(tokens: number) {
  const compactor: Compactor & { calls: { aggressive: boolean }[] } = {
    calls: [],
    async compact(_ctx: Context, opts = {}) {
      compactor.calls.push({ aggressive: opts.aggressive ?? false });
      // A real reduction, so the pass is not classified as a no-op.
      return {
        before: tokens,
        after: Math.floor(tokens * 0.6),
        fullRequestTokensBefore: tokens,
        fullRequestTokensAfter: Math.floor(tokens * 0.6),
        reductions: [],
      };
    },
  };
  return compactor;
}

function middlewareFor(compactor: Compactor, tokens: number): AutoCompactionMiddleware {
  return new AutoCompactionMiddleware(compactor, ONE_M, () => tokens, BALANCED, {
    aggressiveOn: 'soft',
  });
}

describe('auto-compaction at a long-context price cliff', () => {
  let tokens: number;

  beforeEach(() => {
    // 210K of a 1M window is ~21% load: below every balanced rung, and just
    // over a 200K price boundary the provider bills at 2x.
    tokens = 210_000;
  });

  it('compacts before crossing the cliff (the regression this exists for)', async () => {
    const ctx = mockContext(tokens);
    const compactor = mockCompactor(tokens);
    writePriceCliffMeta(
      ctx.meta,
      { cliffTokens: CLIFF, multiplier: 2 },
      priceCliffRouteForContext(ctx),
    );

    await middlewareFor(compactor, tokens).handler()(ctx, async (c) => c);

    expect(compactor.calls).toHaveLength(1);
    expect(compactor.calls[0]?.aggressive).toBe(true);
  });

  it('does NOT compact at the same load when no cliff is published', async () => {
    // Control: without the cliff the ladder is window-relative and 21% load is
    // below warn. If this ever fires, the first test proves nothing.
    const ctx = mockContext(tokens);
    const compactor = mockCompactor(tokens);

    await middlewareFor(compactor, tokens).handler()(ctx, async (c) => c);

    expect(compactor.calls).toHaveLength(0);
  });

  it('ignores a cliff published for a different route (a model switch)', async () => {
    const ctx = mockContext(tokens);
    const compactor = mockCompactor(tokens);
    writePriceCliffMeta(
      ctx.meta,
      { cliffTokens: CLIFF },
      priceCliffRouteKey(ctx.provider?.id, 'some-other-model'),
    );

    await middlewareFor(compactor, tokens).handler()(ctx, async (c) => c);

    expect(compactor.calls).toHaveLength(0);
  });

  it('applies a route-less user cap on whatever model is live', async () => {
    const ctx = mockContext(tokens);
    const compactor = mockCompactor(tokens);
    // `/context cliff 200k` style absolute cap: no route key.
    ctx.meta['contextPriceCliffTokens'] = CLIFF;

    await middlewareFor(compactor, tokens).handler()(ctx, async (c) => c);

    expect(compactor.calls).toHaveLength(1);
  });

  it('leaves the ladder alone when the cliff is above the compaction rung', async () => {
    const ctx = mockContext(tokens);
    const compactor = mockCompactor(tokens);
    writePriceCliffMeta(ctx.meta, { cliffTokens: 900_000 }, priceCliffRouteForContext(ctx));

    await middlewareFor(compactor, tokens).handler()(ctx, async (c) => c);

    expect(compactor.calls).toHaveLength(0);
  });

  it('still compacts on real window pressure with no cliff published', async () => {
    // Pre-existing behavior must survive the change: 800K of 1M is hard pressure.
    const heavy = 800_000;
    const ctx = mockContext(heavy);
    const compactor = mockCompactor(heavy);

    await middlewareFor(compactor, heavy).handler()(ctx, async (c) => c);

    expect(compactor.calls).toHaveLength(1);
  });

  it('forwards the applied cliff into the compaction event and the session record', async () => {
    const ctx = mockContext(tokens);
    const compactor = mockCompactor(tokens);
    writePriceCliffMeta(
      ctx.meta,
      { cliffTokens: CLIFF, multiplier: 2 },
      priceCliffRouteForContext(ctx),
    );
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const appended: Array<Record<string, unknown>> = [];
    const mw = new AutoCompactionMiddleware(compactor, ONE_M, () => tokens, BALANCED, {
      aggressiveOn: 'soft',
      events: {
        emit: (type: string, payload: Record<string, unknown>) => {
          emitted.push({ type, payload });
        },
      } as never,
      sessionBridge: {
        append: async (record: Record<string, unknown>) => {
          appended.push(record);
        },
      } as never,
    });

    await mw.handler()(ctx, async (c) => c);

    const expected = { cliffTokens: CLIFF, triggerTokens: 190_000 };
    // The event is what the live WebUI and the chronicle projection read; the
    // session record is what a resumed session reads. Both must carry the same
    // applied cliff, or the two surfaces explain the same compaction differently.
    expect(emitted.find((e) => e.type === 'compaction.fired')?.payload.priceCliff).toEqual(
      expected,
    );
    expect(appended.find((r) => r.type === 'compaction')?.priceCliff).toEqual(expected);
  });

  it('omits the cliff from a window-relative pass instead of inventing one', async () => {
    const heavy = 800_000;
    const ctx = mockContext(heavy);
    const compactor = mockCompactor(heavy);
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const mw = new AutoCompactionMiddleware(compactor, ONE_M, () => heavy, BALANCED, {
      aggressiveOn: 'soft',
      events: {
        emit: (type: string, payload: Record<string, unknown>) => {
          emitted.push({ type, payload });
        },
      } as never,
    });

    await mw.handler()(ctx, async (c) => c);

    expect(compactor.calls).toHaveLength(1);
    expect(emitted.find((e) => e.type === 'compaction.fired')?.payload.priceCliff).toBeUndefined();
  });
});

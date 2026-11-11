/**
 * A model switch publishes the route's long-context PRICE CLIFF onto the
 * session meta, so the compaction ladder can cap the window at the catalog's
 * published step-up boundary instead of a window-relative threshold.
 *
 * Two contracts are pinned here:
 *  - a route whose catalog cost steps up above 200K gets that boundary
 *    published under the LIVE route key (provider/model), which is the key the
 *    compaction middleware reads it back under;
 *  - a route that publishes no step-up tier CLEARS the key, so a switch away
 *    from a cliffed model can never leave a stale cap compacting the new
 *    route too early.
 */

import {
  CONTEXT_PRICE_CLIFF_META,
  priceCliffRouteForContext,
  readPriceCliffTokens,
} from '@wrongstack/core/utils';
import { describe, expect, it } from 'vitest';
import {
  createMaxContextUpdater,
  publishRoutePriceCliff,
} from '../src/server/max-context-updater.js';

const WINDOWS: Record<string, number> = { 'prov-a': 1_000_000, 'prov-b': 1_000_000 };

/** `prov-a` steps its input rate up above 200K; `prov-b` publishes no tier. */
const COSTS: Record<string, Record<string, unknown> | undefined> = {
  'prov-a': {
    input: 3,
    output: 15,
    tiers: [{ tier: { type: 'context', size: 200_000 }, input: 6, output: 30 }],
  },
  'prov-b': { input: 3, output: 15 },
};

function setup() {
  const registry = {
    ageSeconds: async () => 0,
    refresh: async () => ({}),
    getProvider: async () => undefined,
    getModel: async (providerId: string, modelId: string) => ({
      id: modelId,
      providerId,
      capabilities: { maxContext: WINDOWS[providerId] },
      cost: COSTS[providerId],
    }),
    onCatalogChanged: () => () => undefined,
  };
  const context = {
    model: 'model-a',
    // Typed as the reader sees it: the cliff key is derived from the LIVE
    // provider id, so a fixture wider than `{ id? }` would not typecheck here.
    provider: undefined as { id?: string } | undefined,
    meta: {} as Record<string, unknown>,
    session: { id: 'sess' },
  };
  const update = createMaxContextUpdater({
    config: { context: {} } as never,
    getConfig: () => ({ context: {}, providers: {} }) as never,
    context: context as never,
    modelsRegistry: registry as never,
    events: { emit: () => undefined } as never,
    logger: { warn: () => undefined, debug: () => undefined } as never,
    modelCapabilitiesRef: { current: undefined },
    autoCompactor: { setMaxContext: () => undefined, setEnabled: () => undefined } as never,
  });
  const switchTo = (id: string) => {
    const provider = { id, capabilities: { maxContext: WINDOWS[id] } };
    context.provider = provider;
    context.model = `model-${id}`;
    return update(provider as never, id, undefined);
  };
  return { switchTo, context };
}

describe('max-context updater — long-context price cliff', () => {
  it('publishes the catalog cliff under the live route key', async () => {
    const h = setup();
    await h.switchTo('prov-a');

    const published = h.context.meta[CONTEXT_PRICE_CLIFF_META] as
      | { cliffTokens: number; multiplier?: number; routeKey?: string }
      | undefined;
    expect(published?.cliffTokens).toBe(200_000);
    expect(published?.routeKey).toBe(priceCliffRouteForContext(h.context));
    // The reader must see it: the middleware looks the cliff up by the live
    // provider/model route, never by the catalog lookup id.
    expect(readPriceCliffTokens(h.context.meta, priceCliffRouteForContext(h.context))).toBe(
      200_000,
    );
  });

  it('clears the cliff when the new route publishes no step-up tier', async () => {
    const h = setup();
    await h.switchTo('prov-a');
    expect(h.context.meta[CONTEXT_PRICE_CLIFF_META]).toBeDefined();

    await h.switchTo('prov-b');
    expect(h.context.meta[CONTEXT_PRICE_CLIFF_META]).toBeUndefined();
    expect(
      readPriceCliffTokens(h.context.meta, priceCliffRouteForContext(h.context)),
    ).toBeUndefined();
  });
});

/**
 * The same helper at the OTHER WebUI stamp point: service boot. This is the case
 * that made the feature inert on the surface hosting the viewer — a tab that
 * opens on a cliffed model and is never switched reached `max-context-updater`
 * only on a switch, so the ladder found no cliff and compacted purely
 * window-relative, straight into the 2x billed tier.
 */
describe('publishRoutePriceCliff — WebUI boot stamp', () => {
  const bootCtx = () => ({
    provider: { id: 'prov-a' },
    model: 'model-prov-a',
  });
  const tieredCost = COSTS['prov-a'] as never;

  it('publishes the boundary under the live route the ladder reads back', () => {
    const context = bootCtx();
    const meta: Record<string, unknown> = {};

    publishRoutePriceCliff({
      meta,
      catalogCost: tieredCost,
      maxContext: 1_000_000,
      routeCtx: context,
      enabled: true,
      costKnown: true,
    });

    // Not just present: readable under the LIVE provider/model, which is the
    // only key the compaction middleware looks up.
    expect(readPriceCliffTokens(meta, priceCliffRouteForContext(context))).toBe(200_000);
  });

  it('clears the cap when the user turns the protection off', () => {
    const context = bootCtx();
    const meta: Record<string, unknown> = {};
    publishRoutePriceCliff({
      meta,
      catalogCost: tieredCost,
      maxContext: 1_000_000,
      routeCtx: context,
      enabled: true,
      costKnown: true,
    });
    expect(meta[CONTEXT_PRICE_CLIFF_META]).toBeDefined();

    publishRoutePriceCliff({
      meta,
      catalogCost: tieredCost,
      maxContext: 1_000_000,
      routeCtx: context,
      enabled: false,
      costKnown: true,
    });
    expect(meta[CONTEXT_PRICE_CLIFF_META]).toBeUndefined();
  });

  it('publishes nothing when the window is unknown', () => {
    // A 0 window means "no budget to cap"; guessing here would compact a
    // session whose real window is small far too early.
    const context = bootCtx();
    const meta: Record<string, unknown> = {};
    publishRoutePriceCliff({
      meta,
      catalogCost: tieredCost,
      maxContext: 0,
      routeCtx: context,
      enabled: true,
      costKnown: true,
    });
    expect(meta[CONTEXT_PRICE_CLIFF_META]).toBeUndefined();
  });

  it('PRESERVES a published cap when the catalog read fails', () => {
    // The regression this guard exists for: "could not read pricing" and "the
    // catalog publishes no step-up tier" both surface as an undefined cost, but
    // only the second may clear. Clearing on a transient network error silently
    // disables the protection and lets the session compact window-relative
    // straight into the 2x billed tier — the exact cost this feature prevents.
    const context = bootCtx();
    const meta: Record<string, unknown> = {};
    publishRoutePriceCliff({
      meta,
      catalogCost: tieredCost,
      maxContext: 1_000_000,
      routeCtx: context,
      enabled: true,
      costKnown: true,
    });
    expect(readPriceCliffTokens(meta, priceCliffRouteForContext(context))).toBe(200_000);

    publishRoutePriceCliff({
      meta,
      catalogCost: undefined,
      maxContext: 1_000_000,
      routeCtx: context,
      enabled: true,
      costKnown: false,
    });
    expect(readPriceCliffTokens(meta, priceCliffRouteForContext(context))).toBe(200_000);
  });

  it('publishes nothing for a model the catalog lists without a step-up tier', () => {
    const context = { provider: { id: 'prov-b' }, model: 'model-prov-b' };
    const meta: Record<string, unknown> = {};
    publishRoutePriceCliff({
      meta,
      catalogCost: COSTS['prov-b'] as never,
      maxContext: 1_000_000,
      routeCtx: context,
      enabled: true,
      costKnown: true,
    });
    expect(meta[CONTEXT_PRICE_CLIFF_META]).toBeUndefined();
  });
});

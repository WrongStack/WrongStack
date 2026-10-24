import { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it, vi } from 'vitest';
import type { ModelsRegistry, ResolvedModel } from '../../src/index.js';
import { ProviderCacheLedger } from '../../src/infrastructure/provider-cache-ledger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';

const m1: ResolvedModel = {
  providerId: 'anthropic',
  modelId: 'anthropic-test-model',
  capabilities: { tools: true, vision: true, reasoning: false, maxContext: 200_000 },
  cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
} as ResolvedModel;

const deepseekChat: ResolvedModel = {
  providerId: 'deepseek',
  modelId: 'deepseek-chat',
  capabilities: { tools: true, vision: false, reasoning: false, maxContext: 1_000_000 },
  cost: { input: 0.14, output: 0.28, cache_read: 0.028 },
} as ResolvedModel;

describe('DefaultTokenCounter', () => {
  it('preserves per-call cost attribution when model price lookups settle out of order', async () => {
    const events = new EventBus();
    const seen: Array<{ model?: string | undefined; deltaCost?: { total: number } | undefined }> =
      [];
    events.on('token.accounted', (event) => seen.push(event));
    let resolveOne!: (value: ResolvedModel) => void;
    let resolveTwo!: (value: ResolvedModel) => void;
    const registry = {
      getModel: vi.fn(
        (_provider: string, model: string) =>
          new Promise<ResolvedModel>((resolve) => {
            if (model === m1.modelId) resolveOne = resolve;
            else resolveTwo = resolve;
          }),
      ),
    } as unknown as ModelsRegistry;
    const tc = new DefaultTokenCounter({ events, registry });
    tc.account({ input: 1000, output: 100 }, m1.modelId, m1.providerId);
    tc.account({ input: 1000, output: 100 }, deepseekChat.modelId, deepseekChat.providerId);
    resolveTwo(deepseekChat);
    await Promise.resolve();
    resolveOne(m1);
    await Promise.resolve();
    expect(seen[0]?.model).toBe(deepseekChat.modelId);
    expect(seen[0]?.deltaCost?.total).toBeCloseTo(0.000168);
    expect(seen[1]?.model).toBe(m1.modelId);
    expect(seen[1]?.deltaCost?.total).toBeCloseTo(0.0045);
  });
  it('emits per-call costs across model changes instead of the cumulative actor cost', () => {
    const events = new EventBus();
    const seen: Array<{
      model?: string | undefined;
      deltaCost?: { total: number } | undefined;
      cost: { total: number };
    }> = [];
    events.on('token.accounted', (event) => seen.push(event));
    const tc = new DefaultTokenCounter({ events });
    tc.accountWithModel({ input: 1000, output: 100 }, m1);
    tc.accountWithModel({ input: 1000, output: 100 }, deepseekChat);
    expect(seen[0]?.deltaCost?.total).toBeCloseTo(0.0045);
    expect(seen[1]?.deltaCost?.total).toBeCloseTo(0.000168);
    expect(seen[1]?.cost.total).toBeCloseTo(0.004668);
    expect(seen[1]?.model).toBe('deepseek-chat');
  });
  it('omits per-call cost when a required price is unavailable but preserves genuine free pricing', () => {
    const events = new EventBus();
    const seen: Array<{ deltaCost?: { total: number } | undefined }> = [];
    events.on('token.accounted', (event) => seen.push(event));
    const tc = new DefaultTokenCounter({ events });
    tc.account({ input: 10, output: 5 }, 'unknown');
    tc.accountWithModel({ input: 10, output: 5 }, { ...m1, cost: { input: 3 } } as ResolvedModel);
    tc.accountWithModel({ input: 10, output: 5 }, {
      ...m1,
      cost: { input: 0, output: 0 },
    } as ResolvedModel);
    expect(seen[0]?.deltaCost).toBeUndefined();
    expect(seen[1]?.deltaCost).toBeUndefined();
    expect(seen[2]?.deltaCost?.total).toBe(0);
  });
  it('emits a deltaCost that matches the running cost when the write-rate fallback charges but the cache-read rate is missing', () => {
    // Regression guard for the applyPrice asymmetry flagged in the r1
    // proof-driven hunt: the documented write-rate fallback
    // (price.cacheWrite ?? price.input) charges cacheWrite tokens even
    // when price.cacheRead is undefined, so costInput advances inside
    // applyPrice. The subsequent `known(...)` check returns undefined
    // because cacheRead has no rate; the emitter must STILL surface a
    // deltaCost equal to what it charged, so dispatch-singleshot.ts
    // does not misclassify a priced call as `unknownPrice`.
    //
    // m1 is the project fixture (cost: { input: 3, output: 15,
    // cache_read: 0.3, cache_write: 3 }); we drop the cacheRead side
    // here to land the missing-rate path while keeping m1's pricing
    // shape for the rest of the rates.
    const events = new EventBus();
    const seen: Array<{
      cost: { total: number };
      deltaCost?: { input: number; output: number; total: number } | undefined;
    }> = [];
    events.on('token.accounted', (event) => seen.push(event));
    const tc = new DefaultTokenCounter({ events });
    const noCacheRead = { ...m1, cost: { input: 3, output: 15, cache_write: 3 } } as ResolvedModel;
    tc.accountWithModel({ input: 1_000_000, output: 0, cacheWrite: 1_000_000 }, noCacheRead);
    // Sanity: the write-rate fallback charged $3 for the cacheWrite
    // tokens at the input rate ($3/M * 1M). Plus the input itself:
    // 1M input * $3/M = $3. Running cost.total = $6.
    expect(tc.estimateCost().total).toBeCloseTo(6, 6);
    const event = seen[0];
    expect(event).toBeDefined();
    expect(event?.cost.total).toBeCloseTo(6, 6);
    // The contract: cost.total and deltaCost must agree.
    expect(event?.deltaCost?.total).toBeCloseTo(6, 6);
  });
  it('totals tokens without a registry', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: 10, output: 5 }, 'm');
    tc.account({ input: 7, output: 1, cacheRead: 100, cacheWrite: 50 });
    const t = tc.total();
    expect(t.input).toBe(17);
    expect(t.output).toBe(6);
    expect(t.cacheRead).toBe(100);
    expect(t.cacheWrite).toBe(50);
  });

  it('reports zero cost when no pricing source given', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: 1000, output: 500 }, 'm');
    const cost = tc.estimateCost();
    expect(cost.total).toBe(0);
    expect(cost.currency).toBe('USD');
  });

  it('emits token.accounted even when pricing is unavailable', () => {
    const events = new EventBus();
    const seen: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number }> =
      [];
    events.on('token.accounted', (e) => seen.push(e.usage));
    const tc = new DefaultTokenCounter({ events });

    tc.account({ input: 1000, output: 500, cacheRead: 250, cacheWrite: 125 }, 'unknown-model');

    expect(seen).toEqual([{ input: 1000, output: 500, cacheRead: 250, cacheWrite: 125 }]);
  });

  it('includes provider and model on token.accounted when known', () => {
    const events = new EventBus();
    const seen: Array<{ provider?: string; model?: string }> = [];
    events.on('token.accounted', (e) => seen.push({ provider: e.provider, model: e.model }));
    const tc = new DefaultTokenCounter({ events, providerId: 'anthropic' });

    // Cached-price path: price is known, so emission is synchronous with model.
    tc.accountWithModel({ input: 100, output: 50 }, m1);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ provider: 'anthropic', model: 'anthropic-test-model' });
  });

  it('omits provider/model when neither is configured', () => {
    const events = new EventBus();
    const seen: Array<{ provider?: string; model?: string }> = [];
    events.on('token.accounted', (e) => seen.push({ provider: e.provider, model: e.model }));
    const tc = new DefaultTokenCounter({ events });

    tc.account({ input: 10, output: 5 });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({});
  });

  it('emits session id from a live session getter', () => {
    const events = new EventBus();
    const seen: Array<string | undefined> = [];
    let sessionId = 's1';
    events.on('token.accounted', (e) => seen.push(e.sessionId));
    const tc = new DefaultTokenCounter({ events, sessionId: () => sessionId });

    tc.account({ input: 10, output: 1 }, 'm');
    sessionId = 's2';
    tc.reset();

    expect(seen).toEqual(['s1', 's2']);
  });

  it('can update the session id binding after construction', () => {
    const events = new EventBus();
    const seen: Array<string | undefined> = [];
    events.on('token.accounted', (e) => seen.push(e.sessionId));
    const tc = new DefaultTokenCounter({ events });
    tc.setSessionId('s1');

    tc.account({ input: 10, output: 1 }, 'm');

    expect(seen).toEqual(['s1']);
  });

  it('emits token.accounted when registry has no matching model', async () => {
    const events = new EventBus();
    const seen: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number }> =
      [];
    events.on('token.accounted', (e) => seen.push(e.usage));
    const registry = {
      getModel: vi.fn().mockResolvedValue(undefined),
      load: async () => ({}) as never,
      refresh: async () => ({}) as never,
      listProviders: async () => [],
      getProvider: async () => undefined,
      suggestModel: async () => undefined,
      ageSeconds: async () => 0,
    } as never as ModelsRegistry;
    const tc = new DefaultTokenCounter({ events, registry, providerId: 'local' });

    tc.account({ input: 1234, output: 56 }, 'custom-model');
    await new Promise((r) => setTimeout(r, 5));

    expect(seen).toEqual([{ input: 1234, output: 56, cacheRead: 0, cacheWrite: 0 }]);
  });

  it('keeps the account-time session id across async price lookup', async () => {
    const events = new EventBus();
    const seen: Array<string | undefined> = [];
    let sessionId = 's1';
    let resolveModel!: (value: ResolvedModel | undefined) => void;
    events.on('token.accounted', (e) => seen.push(e.sessionId));
    const registry = {
      getModel: vi.fn().mockImplementation(
        () =>
          new Promise<ResolvedModel | undefined>((resolve) => {
            resolveModel = resolve;
          }),
      ),
      load: async () => ({}) as never,
      refresh: async () => ({}) as never,
      listProviders: async () => [],
      getProvider: async () => undefined,
      suggestModel: async () => undefined,
      ageSeconds: async () => 0,
    } as never as ModelsRegistry;
    const tc = new DefaultTokenCounter({
      events,
      registry,
      providerId: 'local',
      sessionId: () => sessionId,
    });

    tc.account({ input: 1234, output: 56 }, 'custom-model');
    sessionId = 's2';
    resolveModel(undefined);
    await new Promise((r) => setTimeout(r, 5));

    expect(seen).toEqual(['s1']);
  });

  it('prices and attributes each request to its account-time provider', async () => {
    const events = new EventBus();
    const ledger = new ProviderCacheLedger(events);
    const pending = new Map<string, (value: ResolvedModel | undefined) => void>();
    const registry = {
      getModel: vi.fn(
        (providerId: string, _modelId: string) =>
          new Promise<ResolvedModel | undefined>((resolve) => {
            pending.set(providerId, resolve);
          }),
      ),
      load: async () => ({}) as never,
      refresh: async () => ({}) as never,
      listProviders: async () => [],
      getProvider: async () => undefined,
      suggestModel: async () => undefined,
      ageSeconds: async () => 0,
    } as never as ModelsRegistry;
    const tc = new DefaultTokenCounter({ events, registry, providerId: 'boot-provider' });

    tc.account({ input: 100, output: 1, cacheRead: 900 }, 'shared-model', 'anthropic');
    tc.account({ input: 200, output: 2, cacheRead: 300 }, 'shared-model', 'openai');
    pending.get('openai')?.({ ...m1, providerId: 'openai', modelId: 'shared-model' });
    await Promise.resolve();
    pending.get('anthropic')?.({ ...m1, providerId: 'anthropic', modelId: 'shared-model' });
    await new Promise((r) => setTimeout(r, 0));

    expect(registry.getModel).toHaveBeenCalledWith('anthropic', 'shared-model');
    expect(registry.getModel).toHaveBeenCalledWith('openai', 'shared-model');
    expect(ledger.perProvider()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'anthropic', input: 100, cacheRead: 900 }),
        expect.objectContaining({ provider: 'openai', input: 200, cacheRead: 300 }),
      ]),
    );
    ledger.dispose();
  });

  it('reset clears tokens and cost and emits a zero snapshot', () => {
    const events = new EventBus();
    const seen: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number }> =
      [];
    events.on('token.accounted', (e) => seen.push(e.usage));
    const tc = new DefaultTokenCounter({ events });
    tc.accountWithModel({ input: 1_000_000, output: 1_000_000, cacheRead: 50 }, m1);
    expect(tc.total().input).toBe(1_000_000);
    expect(tc.estimateCost().total).toBeGreaterThan(0);
    expect(tc.currentRequestTokens()).toEqual({ input: 1_000_000, cacheRead: 50, cacheWrite: 0 });
    tc.reset();
    expect(tc.total().input).toBe(0);
    expect(tc.estimateCost().total).toBe(0);
    expect(tc.currentRequestTokens()).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0 });
    expect(seen.at(-1)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('accountWithModel applies pricing synchronously', () => {
    const tc = new DefaultTokenCounter();
    tc.accountWithModel({ input: 1_000_000, output: 1_000_000 }, m1);
    const cost = tc.estimateCost();
    // 1M tokens at $3/$15 per 1M = $3 input + $15 output = $18 total
    expect(cost.input).toBeCloseTo(3, 4);
    expect(cost.output).toBeCloseTo(15, 4);
    expect(cost.total).toBeCloseTo(18, 4);
  });

  it('cacheRead and cacheWrite contribute to input cost when priced', () => {
    const tc = new DefaultTokenCounter();
    tc.accountWithModel({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, m1);
    const cost = tc.estimateCost();
    // 1M cacheRead @ $0.3 + 1M cacheWrite @ $3.75 = $4.05
    expect(cost.input).toBeCloseTo(4.05, 4);
    expect(cost.output).toBe(0);
  });

  it('prices DeepSeek cache hits at cache_read instead of full input rate', () => {
    const tc = new DefaultTokenCounter();
    tc.accountWithModel({ input: 200_000, output: 20_000, cacheRead: 800_000 }, deepseekChat);
    const cost = tc.estimateCost();
    expect(cost.input).toBeCloseTo(0.0504, 4);
    expect(cost.output).toBeCloseTo(0.0056, 4);
    expect(cost.total).toBeCloseTo(0.056, 4);
  });

  it('cacheStats.savedUsd is the gross read discount (input rate − cache-read rate)', () => {
    const tc = new DefaultTokenCounter();
    tc.accountWithModel({ input: 0, output: 0, cacheRead: 1_000_000 }, m1);
    // 1M cacheRead × (3 − 0.3) per 1M = $2.70 saved vs the full input rate
    expect(tc.cacheStats().savedUsd).toBeCloseTo(2.7, 4);
  });

  it('bills cache tokens at the input rate when the catalog has no cache prices', () => {
    // Adapters keep cache tokens OUT of `input`; pricing them at 0 made a
    // model look cheaper the better its cache worked.
    const tc = new DefaultTokenCounter();
    const noCachePrices = { ...m1, cost: { input: 2, output: 8 } };
    tc.accountWithModel(
      { input: 100_000, output: 0, cacheRead: 800_000, cacheWrite: 100_000 },
      noCachePrices as typeof m1,
    );
    // (100k fresh + 800k read + 100k written) × $2 per 1M = $2
    expect(tc.estimateCost().input).toBeCloseTo(2, 4);
    // Billed at the full rate, the read saved nothing.
    expect(tc.cacheStats().savedUsd).toBe(0);
  });

  it('savedUsd stays 0 when pricing is unknown', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: 0, output: 0, cacheRead: 1_000_000 });
    expect(tc.cacheStats().savedUsd).toBe(0);
  });

  it('reports cache hit ratios separately for Anthropic and MiniMax routes', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: 100, output: 10, cacheRead: 300, cacheWrite: 100 }, 'opus', 'anthropic');
    tc.account({ input: 200, output: 20, cacheRead: 800 }, 'minimax-m3', 'minimax');

    expect(tc.cacheStats().providers).toEqual([
      {
        provider: 'minimax',
        input: 200,
        cacheRead: 800,
        cacheWrite: 0,
        hitRatio: 0.8,
      },
      {
        provider: 'anthropic',
        input: 100,
        cacheRead: 300,
        cacheWrite: 100,
        hitRatio: 0.6,
      },
    ]);
  });

  it('reports the last request separately from the session-cumulative ratio', () => {
    const tc = new DefaultTokenCounter();
    expect(tc.cacheStats().last).toBeUndefined();
    // Cold first request, then two warm ones: cumulative lags, last does not.
    tc.account({ input: 10_000, output: 10, cacheWrite: 10_000 });
    tc.account({ input: 100, output: 10, cacheRead: 9_900 });
    tc.account({ input: 200, output: 10, cacheRead: 9_800 });
    const stats = tc.cacheStats();
    expect(stats.hitRatio).toBeCloseTo(19_700 / 40_000, 5);
    expect(stats.last).toEqual({ input: 200, cacheRead: 9_800, cacheWrite: 0, hitRatio: 0.98 });

    // `/compact` overrides the context-bar estimate; it is not a request.
    tc.setCurrentRequestTokens(4_000);
    expect(tc.cacheStats().last?.hitRatio).toBe(0.98);

    tc.reset();
    expect(tc.cacheStats().last).toBeUndefined();
  });

  it('clears provider cache telemetry on reset', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: 10, output: 1, cacheRead: 90 }, 'opus', 'anthropic');
    tc.reset();
    expect(tc.cacheStats().providers).toEqual([]);
  });

  it('prices Anthropic 1h cache writes at 2x input when no explicit 1h rate exists', () => {
    const tc = new DefaultTokenCounter();
    tc.accountWithModel({ input: 0, output: 0, cacheWrite1h: 1_000_000 }, m1);
    expect(tc.estimateCost().input).toBeCloseTo(6, 4);
  });

  it('does not double-charge mixed TTL cache writes through aggregate cacheWrite', () => {
    const tc = new DefaultTokenCounter();
    tc.accountWithModel(
      {
        input: 0,
        output: 0,
        cacheWrite: 2_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000,
      },
      m1,
    );
    expect(tc.estimateCost().input).toBeCloseTo(9.75, 4);
  });

  it('derives the aggregate cacheWrite from TTL fields when Usage.cacheWrite is absent', () => {
    // Regression guard for the MiniMax-on-Anthropic case. The Anthropic
    // preset captures cache_creation.ephemeral_5m_input_tokens /
    // ephemeral_1h_input_tokens onto state.usage.cacheWrite5m / cacheWrite1h
    // and falls back to (5m + 1h) as the aggregate when the upstream did
    // not emit cache_creation_input_tokens. Some hybrid adapters forward
    // only the TTL fields with no aggregate; the counter must still surface
    // a writeTokens figure that matches the TTL split so the panel, the
    // status bar, and the per-request context-pressure snapshot all stay
    // consistent. Also asserts the TTL split propagates to cacheStats()
    // and to the per-provider aggregate so per-provider hitRatio + write
    // totals agree with the session-level cacheStats.
    const tc = new DefaultTokenCounter();
    tc.account({ input: 100, output: 0, cacheWrite5m: 800, cacheWrite1h: 400 }, 'm', 'anthropic');
    const s = tc.cacheStats();
    // Aggregate derived from TTL fields.
    expect(s.writeTokens).toBe(1200);
    expect(s.readTokens).toBe(0);
    // TTL split is surfaced because the upstream exposed it.
    expect(s.cacheWrite5m).toBe(800);
    expect(s.cacheWrite1h).toBe(400);
    // Per-provider row agrees with the session-level aggregate.
    expect(s.providers).toEqual([
      {
        provider: 'anthropic',
        input: 100,
        cacheRead: 0,
        cacheWrite: 1200,
        cacheWrite5m: 800,
        cacheWrite1h: 400,
        hitRatio: 0, // no cacheRead in this request → 0/(100+1200)
      },
    ]);
    // Per-request snapshot also uses the derived aggregate (not 0).
    expect(tc.currentRequestTokens().cacheWrite).toBe(1200);
    // Sanity: a second request without TTL fields keeps the TTL counters
    // at their accumulated values (the upstream-driven path) and does not
    // double-count the aggregate on a TTL-only Usage — the invariant
    // Chimera flagged at token-counter.ts:69.
    tc.account({ input: 50, output: 0, cacheWrite: 500 }, 'm', 'anthropic');
    const s2 = tc.cacheStats();
    expect(s2.writeTokens).toBe(1700); // 1200 (TTL-derived) + 500 (explicit)
    expect(s2.cacheWrite5m).toBe(800); // preserved, not zeroed
    expect(s2.cacheWrite1h).toBe(400);
  });

  it('uses cached price on subsequent account() calls', async () => {
    const getModel = vi.fn().mockResolvedValue(m1);
    const registry = {
      getModel,
      load: async () => ({}) as never,
      refresh: async () => ({}) as never,
      listProviders: async () => [],
      getProvider: async () => undefined,
      suggestModel: async () => undefined,
      ageSeconds: async () => 0,
    } as never as ModelsRegistry;
    const tc = new DefaultTokenCounter({ registry, providerId: 'anthropic' });
    tc.account({ input: 1_000_000, output: 0 }, 'anthropic-test-model');
    // wait for async price lookup
    await new Promise((r) => setTimeout(r, 5));
    tc.account({ input: 1_000_000, output: 0 }, 'anthropic-test-model');
    // First call's cost was applied after async resolve; second uses cache.
    expect(getModel).toHaveBeenCalledTimes(1);
    expect(tc.total().input).toBe(2_000_000);
    expect(tc.estimateCost().input).toBeGreaterThan(0);
  });

  it('cacheStats reports zero ratio when no activity', () => {
    const tc = new DefaultTokenCounter();
    const s = tc.cacheStats();
    expect(s.readTokens).toBe(0);
    expect(s.writeTokens).toBe(0);
    expect(s.hitRatio).toBe(0);
  });

  it('cacheStats hit ratio is cacheRead / total prompt context', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: 100, output: 0, cacheRead: 100, cacheWrite: 25 });
    const s = tc.cacheStats();
    expect(s.readTokens).toBe(100);
    expect(s.writeTokens).toBe(25);
    expect(s.hitRatio).toBeCloseTo(100 / 225, 6);
  });

  it('cacheStats hit ratio is 1.0 when all reads are cached', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: 0, output: 0, cacheRead: 200 });
    expect(tc.cacheStats().hitRatio).toBe(1);
  });

  it('cacheStats accumulates across multiple account() calls', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: 50, output: 0, cacheRead: 50, cacheWrite: 10 });
    tc.account({ input: 50, output: 0, cacheRead: 150, cacheWrite: 5 });
    const s = tc.cacheStats();
    expect(s.readTokens).toBe(200);
    expect(s.writeTokens).toBe(15);
    // 200 / (200 cache-read + 100 fresh + 15 cache-write)
    expect(s.hitRatio).toBeCloseTo(200 / 315, 6);
  });

  it('clamps cache hit ratio when malformed counters cannot form a valid percentage', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: -100, output: 0, cacheRead: 15_000 });
    expect(tc.cacheStats().hitRatio).toBe(1);
  });

  it('swallows registry errors silently', async () => {
    const registry = {
      getModel: async () => {
        throw new Error('boom');
      },
      load: async () => ({}) as never,
      refresh: async () => ({}) as never,
      listProviders: async () => [],
      getProvider: async () => undefined,
      suggestModel: async () => undefined,
      ageSeconds: async () => 0,
    } as never as ModelsRegistry;
    const tc = new DefaultTokenCounter({ registry, providerId: 'p' });
    tc.account({ input: 1, output: 1 }, 'unknown-model');
    await new Promise((r) => setTimeout(r, 5));
    expect(tc.total().input).toBe(1);
  });

  it('setCurrentRequestTokens overrides the per-request snapshot', () => {
    const tc = new DefaultTokenCounter();
    // account() sets lastInput = 10
    tc.account({ input: 10, output: 5 }, 'm');
    expect(tc.currentRequestTokens().input).toBe(10);
    // setCurrentRequestTokens overrides it
    tc.setCurrentRequestTokens(42, 7, 3);
    expect(tc.currentRequestTokens().input).toBe(42);
    expect(tc.currentRequestTokens().cacheRead).toBe(7);
    expect(tc.currentRequestTokens().cacheWrite).toBe(3);
    // total() is unchanged — only the snapshot was overridden
    expect(tc.total().input).toBe(10);
  });

  // Provider usage arrives from `agent-response.ts` straight off the provider
  // response, so it is untrusted: `typeof x === 'number'` admits NaN/Infinity.
  // A single non-finite field poisons every accumulator permanently
  // (`NaN + finite === NaN`), and `currentRequestTokens()` then feeds
  // `eternal-autonomy.ts` a `total / maxCtx >= threshold` comparison that is
  // false for ANY ceiling, silently disabling the context-pressure compaction
  // gate. The token-throttle and token-budget wrappers normalize the same
  // boundary; this core accumulator must too.
  it('does not let non-finite provider usage poison the session totals', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: 1000, output: 200 });
    tc.account({ input: Number.NaN, output: 10 });
    expect(Number.isFinite(tc.total().input)).toBe(true);
    expect(Number.isFinite(tc.total().output)).toBe(true);
  });

  it('recovers usable totals after an Infinity usage response', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: Number.POSITIVE_INFINITY, output: 0 });
    tc.account({ input: 1000, output: 200 });
    expect(Number.isFinite(tc.total().input)).toBe(true);
    expect(Number.isFinite(tc.total().output)).toBe(true);
  });

  it('keeps the per-request context-pressure sum comparable to a ceiling', () => {
    // Mirrors the comparison eternal-autonomy.ts makes against maxContext.
    const tc = new DefaultTokenCounter();
    tc.account({ input: 1000, output: 200 });
    tc.account({ input: Number.NaN, output: 0 });
    const used = tc.currentRequestTokens();
    const total = used.input + used.cacheRead + used.cacheWrite;
    expect(Number.isNaN(total)).toBe(false);
    expect(Number.isFinite(total / 200_000)).toBe(true);
  });

  it('normalizes non-finite cache fields on the synchronous path too', () => {
    const tc = new DefaultTokenCounter();
    tc.accountWithModel(
      { input: 10, output: 5, cacheRead: Number.NaN, cacheWrite: Number.POSITIVE_INFINITY },
      m1,
    );
    expect(Number.isFinite(tc.total().cacheRead)).toBe(true);
    expect(Number.isFinite(tc.total().cacheWrite)).toBe(true);
    expect(Number.isFinite(tc.estimateCost().total)).toBe(true);
  });

  it('preserves finite usage exactly (guards against a zero-everything "fix")', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: 1000, output: 200, cacheRead: 300, cacheWrite: 20 });
    tc.account({ input: 500, output: 100 });
    expect(tc.total()).toMatchObject({ input: 1500, output: 300, cacheRead: 300, cacheWrite: 20 });
  });
});

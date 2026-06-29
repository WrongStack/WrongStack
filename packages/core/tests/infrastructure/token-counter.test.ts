import { describe, expect, it, vi } from 'vitest';
import { DefaultTokenCounter } from '../../src/index.js';
import { EventBus } from '../../src/kernel/events.js';
import type { ModelsRegistry, ResolvedModel } from '../../src/index.js';

const m1: ResolvedModel = {
  providerId: 'anthropic',
  modelId: 'claude-sonnet-4-6',
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
    const seen: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number }> = [];
    events.on('token.accounted', (e) => seen.push(e.usage));
    const tc = new DefaultTokenCounter({ events });

    tc.account({ input: 1000, output: 500, cacheRead: 250, cacheWrite: 125 }, 'unknown-model');

    expect(seen).toEqual([{ input: 1000, output: 500, cacheRead: 250, cacheWrite: 125 }]);
  });

  it('emits token.accounted when registry has no matching model', async () => {
    const events = new EventBus();
    const seen: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number }> = [];
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

  it('reset clears tokens and cost and emits a zero snapshot', () => {
    const events = new EventBus();
    const seen: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number }> = [];
    events.on('token.accounted', (e) => seen.push(e.usage));
    const tc = new DefaultTokenCounter({ events });
    tc.accountWithModel({ input: 1_000_000, output: 1_000_000, cacheRead: 50 }, m1);
    expect(tc.total().input).toBe(1_000_000);
    expect(tc.estimateCost().total).toBeGreaterThan(0);
    expect(tc.currentRequestTokens()).toEqual({ input: 1_000_000, cacheRead: 50 });
    tc.reset();
    expect(tc.total().input).toBe(0);
    expect(tc.estimateCost().total).toBe(0);
    expect(tc.currentRequestTokens()).toEqual({ input: 0, cacheRead: 0 });
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

  it('prices Anthropic 1h cache writes at 2x input when no explicit 1h rate exists', () => {
    const tc = new DefaultTokenCounter();
    tc.accountWithModel({ input: 0, output: 0, cacheWrite1h: 1_000_000 }, m1);
    expect(tc.estimateCost().input).toBeCloseTo(6, 4);
  });

  it('does not double-charge mixed TTL cache writes through aggregate cacheWrite', () => {
    const tc = new DefaultTokenCounter();
    tc.accountWithModel(
      { input: 0, output: 0, cacheWrite: 2_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 },
      m1,
    );
    expect(tc.estimateCost().input).toBeCloseTo(9.75, 4);
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
    tc.account({ input: 1_000_000, output: 0 }, 'claude-sonnet-4-6');
    // wait for async price lookup
    await new Promise((r) => setTimeout(r, 5));
    tc.account({ input: 1_000_000, output: 0 }, 'claude-sonnet-4-6');
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

  it('cacheStats hit ratio is cacheRead / (cacheRead + input)', () => {
    const tc = new DefaultTokenCounter();
    tc.account({ input: 100, output: 0, cacheRead: 100, cacheWrite: 25 });
    const s = tc.cacheStats();
    expect(s.readTokens).toBe(100);
    expect(s.writeTokens).toBe(25);
    expect(s.hitRatio).toBeCloseTo(0.5, 6);
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
    // 200 / (200 + 100) = 0.6666...
    expect(s.hitRatio).toBeCloseTo(2 / 3, 6);
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
    tc.setCurrentRequestTokens(42, 7);
    expect(tc.currentRequestTokens().input).toBe(42);
    expect(tc.currentRequestTokens().cacheRead).toBe(7);
    // total() is unchanged — only the snapshot was overridden
    expect(tc.total().input).toBe(10);
  });
});

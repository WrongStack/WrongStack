import { beforeEach, describe, expect, it, vi } from 'vitest';

const llmCachePlugin = (await import('../src/llm-cache')).default;
const { fingerprintRequest, isDeterministic } = await import('../src/llm-cache');

interface Tool {
  name: string;
  execute: (i: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

type WrapFn = (
  ctx: unknown,
  req: unknown,
  inner: (c: unknown, r: unknown) => Promise<unknown>,
) => Promise<unknown>;

interface MockApi {
  tools: { register: (t: Tool) => void };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
    histogram: ReturnType<typeof vi.fn>;
    gauge: ReturnType<typeof vi.fn>;
  };
  extensions: { register: ReturnType<typeof vi.fn> };
  _tools: Record<string, Tool>;
  _wrap?: WrapFn;
}

function setup(cfg: Record<string, unknown> = {}): MockApi {
  const tools: Record<string, Tool> = {};
  const api: MockApi = {
    tools: {
      register: (t: Tool) => {
        tools[t.name] = t;
      },
    },
    config: { extensions: { 'llm-cache': cfg } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    extensions: {
      register: vi.fn((ext: { wrapProviderRunner?: WrapFn }) => {
        api._wrap = ext.wrapProviderRunner;
        return vi.fn();
      }),
    },
    _tools: tools,
  };
  llmCachePlugin.setup(api as never);
  api._tools = tools;
  return api;
}

const response = (text: string, stopReason = 'end_turn') => ({
  content: [{ type: 'text', text }],
  stopReason,
  usage: { input: 100, output: 20 },
  model: 'test-model',
});

const req = (over: Record<string, unknown> = {}) => ({
  model: 'test-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  temperature: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fingerprintRequest / isDeterministic', () => {
  it('same inputs → same fingerprint, different → different', () => {
    expect(fingerprintRequest(req())).toBe(fingerprintRequest(req()));
    expect(fingerprintRequest(req())).not.toBe(fingerprintRequest(req({ model: 'other' })));
    expect(fingerprintRequest(req())).not.toBe(
      fingerprintRequest(req({ messages: [{ role: 'user', content: 'different' }] })),
    );
  });

  it('deterministic detection', () => {
    expect(isDeterministic({ temperature: 0 })).toBe(true);
    expect(isDeterministic({})).toBe(true);
    expect(isDeterministic({ temperature: 0.7 })).toBe(false);
  });
});

describe('llm-cache plugin', () => {
  it('is inert (no extension) when disabled by default', () => {
    const api = setup(); // enabled defaults to false
    expect(api.extensions.register).not.toHaveBeenCalled();
    expect(api._tools.llm_cache_status).toBeDefined();
  });

  it('registers a wrapProviderRunner extension when enabled', () => {
    const api = setup({ enabled: true });
    expect(api.extensions.register).toHaveBeenCalledTimes(1);
    expect(typeof api._wrap).toBe('function');
  });

  it('caches a deterministic request and short-circuits the second call', async () => {
    const api = setup({ enabled: true });
    const inner = vi.fn().mockResolvedValue(response('answer'));
    const r1 = await api._wrap!(null, req(), inner);
    const r2 = await api._wrap!(null, req(), inner);
    expect(inner).toHaveBeenCalledTimes(1); // second served from cache
    expect(r1).toEqual(r2);
    const status = await api._tools.llm_cache_status!.execute({});
    expect((status.counters as { hits: number }).hits).toBe(1);
    expect((status.counters as { misses: number }).misses).toBe(1);
  });

  it('does not cache sampled requests when onlyDeterministic (default)', async () => {
    const api = setup({ enabled: true });
    const inner = vi.fn().mockResolvedValue(response('sampled'));
    await api._wrap!(null, req({ temperature: 0.9 }), inner);
    await api._wrap!(null, req({ temperature: 0.9 }), inner);
    expect(inner).toHaveBeenCalledTimes(2); // both hit the provider
    const status = await api._tools.llm_cache_status!.execute({});
    expect((status.counters as { skips: number }).skips).toBe(2);
  });

  it('caches sampled requests when onlyDeterministic is false', async () => {
    const api = setup({ enabled: true, onlyDeterministic: false });
    const inner = vi.fn().mockResolvedValue(response('x'));
    await api._wrap!(null, req({ temperature: 0.9 }), inner);
    await api._wrap!(null, req({ temperature: 0.9 }), inner);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('never caches a non-end_turn response', async () => {
    const api = setup({ enabled: true });
    const inner = vi.fn().mockResolvedValue(response('truncated', 'max_tokens'));
    await api._wrap!(null, req(), inner);
    await api._wrap!(null, req(), inner);
    expect(inner).toHaveBeenCalledTimes(2); // not cached
  });

  it('zeroUsageOnHit reports 0 tokens on a hit', async () => {
    const api = setup({ enabled: true, zeroUsageOnHit: true });
    const inner = vi.fn().mockResolvedValue(response('a'));
    await api._wrap!(null, req(), inner);
    const hit = (await api._wrap!(null, req(), inner)) as {
      usage: { input: number; output: number };
    };
    expect(hit.usage.input).toBe(0);
    expect(hit.usage.output).toBe(0);
  });

  it('keeps cached usage on a hit by default', async () => {
    const api = setup({ enabled: true });
    const inner = vi.fn().mockResolvedValue(response('a'));
    await api._wrap!(null, req(), inner);
    const hit = (await api._wrap!(null, req(), inner)) as { usage: { input: number } };
    expect(hit.usage.input).toBe(100);
  });

  it('evicts oldest entries past maxEntries', async () => {
    const api = setup({ enabled: true, maxEntries: 2 });
    const inner = vi.fn().mockImplementation(async () => response('r'));
    await api._wrap!(null, req({ model: 'm1' }), inner);
    await api._wrap!(null, req({ model: 'm2' }), inner);
    await api._wrap!(null, req({ model: 'm3' }), inner); // evicts m1
    // m1 is gone → re-request misses again (inner called a 4th time).
    await api._wrap!(null, req({ model: 'm1' }), inner);
    expect(inner).toHaveBeenCalledTimes(4);
    const status = await api._tools.llm_cache_status!.execute({});
    expect(status.size).toBe(2);
    expect((status.counters as { evictions: number }).evictions).toBeGreaterThanOrEqual(1);
  });

  it('llm_cache_clear drops entries', async () => {
    const api = setup({ enabled: true });
    const inner = vi.fn().mockResolvedValue(response('a'));
    await api._wrap!(null, req(), inner);
    const cleared = await api._tools.llm_cache_clear!.execute({});
    expect(cleared.cleared).toBe(1);
    // After clear, same request misses again.
    await api._wrap!(null, req(), inner);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('teardown clears state and logs', async () => {
    const api = setup({ enabled: true });
    const inner = vi.fn().mockResolvedValue(response('a'));
    await api._wrap!(null, req(), inner);
    llmCachePlugin.teardown!(api as never);
    const health = (await llmCachePlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters.hits).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith('llm-cache: teardown complete', expect.any(Object));
  });

  it('respects TTL expiry', async () => {
    vi.useFakeTimers();
    try {
      const api = setup({ enabled: true, ttlMs: 1000 });
      const inner = vi.fn().mockResolvedValue(response('a'));
      await api._wrap!(null, req(), inner);
      vi.advanceTimersByTime(1500);
      await api._wrap!(null, req(), inner); // expired → miss
      expect(inner).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const tokenThrottlePlugin = (await import('../src/token-throttle')).default;
const { pruneWindow, windowSpend, computeThrottleDelay } = await import('../src/token-throttle');

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
    config: { extensions: { 'token-throttle': cfg } },
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
  tokenThrottlePlugin.setup(api as never);
  api._tools = tools;
  return api;
}

const bigReq = (chars: number) => ({
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(chars) }] }],
});
const resp = (tokens: number) => ({
  content: [],
  stopReason: 'end_turn',
  usage: { input: tokens, output: 0 },
  model: 'm',
});

beforeEach(() => vi.clearAllMocks());

describe('window math', () => {
  it('prunes entries older than 60s', () => {
    const now = 100_000;
    const pruned = pruneWindow(
      [
        { at: now - 61_000, tokens: 10 },
        { at: now - 1_000, tokens: 5 },
      ],
      now,
    );
    expect(pruned).toHaveLength(1);
    expect(windowSpend(pruned)).toBe(5);
  });

  it('computeThrottleDelay returns 0 when under budget', () => {
    expect(computeThrottleDelay([{ at: 0, tokens: 100 }], 1000, 10_000, 500)).toBe(0);
  });

  it('computeThrottleDelay waits for the oldest entry to age out', () => {
    const now = 100_000;
    // window has 9000, limit 10000, projected 3000 → need to free 2000.
    // oldest entry (2500 tok at now-50s) leaving frees enough → delay = (now-50s + 60s) - now = 10s.
    const entries = [
      { at: now - 50_000, tokens: 2500 },
      { at: now - 20_000, tokens: 6500 },
    ];
    const delay = computeThrottleDelay(entries, now, 10_000, 3000);
    expect(delay).toBe(10_000);
  });
});

describe('token-throttle plugin', () => {
  it('is inert when disabled', () => {
    expect(setup().extensions.register).not.toHaveBeenCalled();
  });

  it('passes calls through and records usage when under budget', async () => {
    const api = setup({ enabled: true, tokensPerMinute: 1_000_000 });
    const inner = vi.fn().mockResolvedValue(resp(100));
    await api._wrap!(null, bigReq(40), inner);
    expect(inner).toHaveBeenCalledTimes(1);
    const status = await api._tools.token_throttle_status!.execute({});
    expect((status.counters as { throttled: number }).throttled).toBe(0);
    expect(status.windowSpend).toBe(100); // recorded actual usage
  });

  it('throttles (delays) when the window budget would be exceeded', async () => {
    vi.useFakeTimers();
    try {
      const api = setup({
        enabled: true,
        tokensPerMinute: 100,
        maxDelayMs: 30_000,
        charsPerToken: 1,
      });
      const inner = vi.fn().mockResolvedValue(resp(50));
      // First call: window empty, projected = 40 chars/1 = 40 tokens ≤ 100 → no delay.
      await api._wrap!(null, bigReq(40), inner);
      // Second call: window now has 50 (actual usage), projected 80 → 130 > 100 → delay.
      const p = api._wrap!(null, bigReq(80), inner);
      await vi.advanceTimersByTimeAsync(30_000);
      await p;
      const status = await api._tools.token_throttle_status!.execute({});
      expect((status.counters as { throttled: number }).throttled).toBeGreaterThanOrEqual(1);
      expect((status.counters as { totalDelayMs: number }).totalDelayMs).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the delay at maxDelayMs', async () => {
    vi.useFakeTimers();
    try {
      const api = setup({ enabled: true, tokensPerMinute: 1, maxDelayMs: 500, charsPerToken: 1 });
      const inner = vi.fn().mockResolvedValue(resp(1000));
      await api._wrap!(null, bigReq(10), inner); // seeds a big window entry
      const p = api._wrap!(null, bigReq(10), inner);
      await vi.advanceTimersByTimeAsync(500);
      await p;
      const status = await api._tools.token_throttle_status!.execute({});
      // Each throttle is capped at 500ms.
      expect((status.counters as { totalDelayMs: number }).totalDelayMs).toBeLessThanOrEqual(
        500 * 2,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('teardown clears state and logs', async () => {
    const api = setup({ enabled: true });
    tokenThrottlePlugin.teardown!(api as never);
    const health = (await tokenThrottlePlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters.throttled).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'token-throttle: teardown complete',
      expect.any(Object),
    );
  });
});

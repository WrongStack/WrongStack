import { beforeEach, describe, expect, it, vi } from 'vitest';

const modelRouterPlugin = (await import('../src/model-router')).default;
const { requestCharSize, pickRule } = await import('../src/model-router');

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
    config: { extensions: { 'model-router': cfg } },
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
  modelRouterPlugin.setup(api as never);
  api._tools = tools;
  return api;
}

const req = (over: Record<string, unknown> = {}) => ({
  model: 'big-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('requestCharSize / pickRule', () => {
  it('sums text across system + messages', () => {
    const size = requestCharSize({
      system: [{ type: 'text', text: 'abc' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'defg' }] }],
    });
    expect(size).toBe(7);
  });

  it('picks the first fully-matching rule', () => {
    const rules = [
      { maxChars: 10, hasTools: false, model: 'cheap' },
      { minChars: 100, model: 'big' },
    ];
    expect(pickRule(rules, 5, false)?.model).toBe('cheap');
    expect(pickRule(rules, 5, true)).toBeNull(); // hasTools mismatch, no other rule
    expect(pickRule(rules, 200, true)?.model).toBe('big');
    expect(pickRule(rules, 50, false)).toBeNull();
  });
});

describe('model-router plugin', () => {
  it('is inert when disabled or ruleless', () => {
    expect(setup().extensions.register).not.toHaveBeenCalled();
    expect(setup({ enabled: true }).extensions.register).not.toHaveBeenCalled(); // no rules
  });

  it('registers an extension when enabled with rules', () => {
    const api = setup({ enabled: true, rules: [{ maxChars: 10, model: 'cheap' }] });
    expect(api.extensions.register).toHaveBeenCalledTimes(1);
    expect(typeof api._wrap).toBe('function');
  });

  it('dry-run counts the route but does NOT change the model', async () => {
    const api = setup({
      enabled: true,
      dryRun: true,
      rules: [{ maxChars: 10000, model: 'cheap' }],
    });
    const inner = vi.fn().mockResolvedValue({
      content: [],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'big-model',
    });
    await api._wrap!(null, req(), inner);
    expect(inner.mock.calls[0]![1]).toMatchObject({ model: 'big-model' }); // unchanged
    const status = await api._tools.model_router_status!.execute({});
    expect((status.counters as { routed: number }).routed).toBe(1);
    expect(status.routes).toMatchObject({ 'big-model→cheap': 1 });
  });

  it('live mode rewrites request.model on a clone', async () => {
    const api = setup({
      enabled: true,
      dryRun: false,
      rules: [{ maxChars: 10000, model: 'cheap' }],
    });
    const original = req();
    const inner = vi
      .fn()
      .mockResolvedValue({ content: [], stopReason: 'end_turn', usage: {}, model: 'cheap' });
    await api._wrap!(null, original, inner);
    expect(inner.mock.calls[0]![1]).toMatchObject({ model: 'cheap' });
    expect(original.model).toBe('big-model'); // caller object not mutated
  });

  it('passes through when no rule matches', async () => {
    const api = setup({
      enabled: true,
      dryRun: false,
      rules: [{ minChars: 100000, model: 'cheap' }],
    });
    const inner = vi
      .fn()
      .mockResolvedValue({ content: [], stopReason: 'end_turn', usage: {}, model: 'big-model' });
    await api._wrap!(null, req(), inner);
    expect(inner.mock.calls[0]![1]).toMatchObject({ model: 'big-model' });
    const status = await api._tools.model_router_status!.execute({});
    expect((status.counters as { passthrough: number }).passthrough).toBe(1);
  });

  it('passes through when the rule targets the current model', async () => {
    const api = setup({
      enabled: true,
      dryRun: false,
      rules: [{ maxChars: 10000, model: 'big-model' }],
    });
    const inner = vi
      .fn()
      .mockResolvedValue({ content: [], stopReason: 'end_turn', usage: {}, model: 'big-model' });
    await api._wrap!(null, req(), inner);
    const status = await api._tools.model_router_status!.execute({});
    expect((status.counters as { passthrough: number }).passthrough).toBe(1);
    expect((status.counters as { routed: number }).routed).toBe(0);
  });

  it('routes on hasTools condition', async () => {
    const api = setup({
      enabled: true,
      dryRun: false,
      rules: [{ hasTools: true, model: 'tooly' }],
    });
    const inner = vi
      .fn()
      .mockResolvedValue({ content: [], stopReason: 'end_turn', usage: {}, model: 'tooly' });
    await api._wrap!(null, req({ tools: [{ name: 'read' }] }), inner);
    expect(inner.mock.calls[0]![1]).toMatchObject({ model: 'tooly' });
  });

  it('teardown clears state and logs', async () => {
    const api = setup({ enabled: true, rules: [{ maxChars: 10, model: 'cheap' }] });
    modelRouterPlugin.teardown!(api as never);
    const health = (await modelRouterPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters.routed).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'model-router: teardown complete',
      expect.any(Object),
    );
  });
});

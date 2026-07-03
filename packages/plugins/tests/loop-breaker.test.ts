import { beforeEach, describe, expect, it, vi } from 'vitest';

const loopBreakerPlugin = (await import('../src/loop-breaker')).default;

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
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
  registerHook: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => HookResult {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => HookResult;
}

function getStatusTool(api: MockApi): {
  execute: (input: unknown) => Promise<Record<string, unknown>>;
} {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === 'loop_breaker_status',
  );
  if (!call) throw new Error('loop_breaker_status not registered');
  return call[0] as { execute: (input: unknown) => Promise<Record<string, unknown>> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loop-breaker plugin', () => {
  it('registers loop_breaker_status and a PreToolUse * hook', () => {
    const api = makeApi();
    loopBreakerPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PreToolUse');
    expect(matcher).toBe('*');
  });

  it('does not react to distinct calls', () => {
    const api = makeApi();
    loopBreakerPlugin.setup(api as never);
    const hook = getHook(api);
    for (let i = 0; i < 10; i++) {
      expect(hook({ toolName: 'read', toolInput: { path: `/f${i}` } })).toBeUndefined();
    }
  });

  it('warns after warnAfter identical calls, blocks after blockAfter', () => {
    const api = makeApi();
    loopBreakerPlugin.setup(api as never);
    const hook = getHook(api);
    const call = { toolName: 'bash', toolInput: { command: 'npm test' } };
    expect(hook(call)).toBeUndefined(); // 1
    expect(hook(call)).toBeUndefined(); // 2
    const warn = hook(call); // 3 → warn
    expect(warn?.decision).toBe('allow');
    expect(warn?.additionalContext).toContain('repeated 3x');
    hook(call); // 4 → still warn
    const block = hook(call); // 5 → block
    expect(block?.decision).toBe('block');
    expect(block?.reason).toContain('runaway loop');
  });

  it('treats key order as identical input', () => {
    const api = makeApi();
    loopBreakerPlugin.setup(api as never);
    const hook = getHook(api);
    hook({ toolName: 'x', toolInput: { a: 1, b: 2 } });
    hook({ toolName: 'x', toolInput: { b: 2, a: 1 } });
    const third = hook({ toolName: 'x', toolInput: { a: 1, b: 2 } });
    expect(third?.additionalContext).toContain('repeated 3x');
  });

  it('resets the streak on a different call', () => {
    const api = makeApi();
    loopBreakerPlugin.setup(api as never);
    const hook = getHook(api);
    const call = { toolName: 'bash', toolInput: { command: 'x' } };
    hook(call);
    hook(call);
    hook({ toolName: 'read', toolInput: { path: '/other' } });
    expect(hook(call)).toBeUndefined(); // streak restarted at 1... 2
  });

  it('warn mode never blocks', () => {
    const api = makeApi({ extensions: { 'loop-breaker': { mode: 'warn' } } });
    loopBreakerPlugin.setup(api as never);
    const hook = getHook(api);
    const call = { toolName: 'bash', toolInput: { command: 'x' } };
    let last: HookResult;
    for (let i = 0; i < 10; i++) last = hook(call);
    expect(last?.decision).toBe('allow');
  });

  it('detects A-B-A-B oscillation', () => {
    const api = makeApi({ extensions: { 'loop-breaker': { oscillationWindow: 4 } } });
    loopBreakerPlugin.setup(api as never);
    const hook = getHook(api);
    const a = { toolName: 'write', toolInput: { path: '/a', content: '1' } };
    const b = { toolName: 'write', toolInput: { path: '/a', content: '2' } };
    hook(a);
    hook(b);
    hook(a);
    const result = hook(b);
    expect(result?.additionalContext).toContain('A-B-A-B');
  });

  it('respects ignoreTools', () => {
    const api = makeApi({ extensions: { 'loop-breaker': { ignoreTools: ['poll'] } } });
    loopBreakerPlugin.setup(api as never);
    const hook = getHook(api);
    const call = { toolName: 'poll', toolInput: {} };
    for (let i = 0; i < 20; i++) {
      expect(hook(call)).toBeUndefined();
    }
  });

  it('enabled:false disables the hook entirely', () => {
    const api = makeApi({ extensions: { 'loop-breaker': { enabled: false } } });
    loopBreakerPlugin.setup(api as never);
    const hook = getHook(api);
    const call = { toolName: 'bash', toolInput: { command: 'x' } };
    for (let i = 0; i < 20; i++) {
      expect(hook(call)).toBeUndefined();
    }
  });

  it('status tool reports counters', async () => {
    const api = makeApi();
    loopBreakerPlugin.setup(api as never);
    const hook = getHook(api);
    const call = { toolName: 'bash', toolInput: { command: 'x' } };
    for (let i = 0; i < 5; i++) hook(call);
    const status = await getStatusTool(api).execute({});
    const counters = status['counters'] as Record<string, number>;
    expect(counters['blocks']).toBe(1);
    expect(counters['warnings']).toBeGreaterThanOrEqual(1);
    expect(status['currentStreak']).toBe(5);
  });

  it('teardown zeros counters and is safe before setup', async () => {
    const api = makeApi();
    expect(() => loopBreakerPlugin.teardown!(api as never)).not.toThrow();
    loopBreakerPlugin.setup(api as never);
    const hook = getHook(api);
    const call = { toolName: 'bash', toolInput: { command: 'x' } };
    for (let i = 0; i < 5; i++) hook(call);
    loopBreakerPlugin.teardown!(api as never);
    const health = (await loopBreakerPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['blocks']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'loop-breaker: teardown complete',
      expect.any(Object),
    );
  });
});

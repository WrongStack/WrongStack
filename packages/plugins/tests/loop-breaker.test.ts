import { beforeEach, describe, expect, it, vi } from 'vitest';

// The no-diff detector (postHook → gitDiffFingerprint) shells out to
// `git diff` with a 1s timeout and fails open on timeout/error. Under a
// full parallel suite run the git spawn can exceed that budget, the
// fingerprint comes back null, the no-diff streak never advances, and the
// test flakes at the `warn?.additionalContext` assertion. Mocking the
// spawn keeps this file on the streak logic it exists to cover; git's
// own performance is not under test.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      // Empty diff — the target file is clean and stays clean.
      callback(null, '');
      return { unref: vi.fn() } as never;
    },
  ),
}));

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

function getHook(api: MockApi, event = 'PreToolUse'): (input: unknown) => HookResult {
  const call = api.registerHook.mock.calls.find(([hookEvent]: unknown[]) => hookEvent === event);
  if (!call) throw new Error(`${event} hook not registered`);
  return (call as unknown[])[2] as (input: unknown) => HookResult;
}

function getAsyncHook(api: MockApi, event: string): (input: unknown) => Promise<HookResult> {
  const call = api.registerHook.mock.calls.find(([hookEvent]: unknown[]) => hookEvent === event);
  if (!call) throw new Error(`${event} hook not registered`);
  return (call as unknown[])[2] as (input: unknown) => Promise<HookResult>;
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
  it('registers loop_breaker_status and PreToolUse/PostToolUse * hooks', () => {
    const api = makeApi();
    loopBreakerPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    expect(api.registerHook.mock.calls.map((call: unknown[]) => call.slice(0, 2))).toEqual(
      expect.arrayContaining([
        ['PreToolUse', '*'],
        ['PostToolUse', '*'],
      ]),
    );
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
    const api = makeApi({ extensions: { 'loop-breaker': { mode: 'block' } } });
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

  it('blocks after the configured step budget', () => {
    const api = makeApi({ extensions: { 'loop-breaker': { maxSteps: 3, blockAfter: 99 } } });
    loopBreakerPlugin.setup(api as never);
    const hook = getHook(api);
    expect(hook({ toolName: 'read', toolInput: { path: '/a' } })).toBeUndefined();
    expect(hook({ toolName: 'read', toolInput: { path: '/b' } })).toBeUndefined();
    expect(hook({ toolName: 'read', toolInput: { path: '/c' } })).toBeUndefined();
    const block = hook({ toolName: 'read', toolInput: { path: '/d' } });
    expect(block?.decision).toBe('block');
    expect(block?.reason).toContain('step budget exceeded');
  });

  it('warns on repeated errors and blocks the next step at the threshold', async () => {
    const api = makeApi({
      extensions: {
        'loop-breaker': { repeatedErrorWarnAfter: 2, repeatedErrorBlockAfter: 3, blockAfter: 99 },
      },
    });
    loopBreakerPlugin.setup(api as never);
    const preHook = getHook(api);
    const postHook = getAsyncHook(api, 'PostToolUse');
    const failed = {
      toolName: 'exec',
      toolResult: { isError: true, content: 'Error: boom at file.ts:123:4\nstack line' },
    };
    expect(await postHook(failed)).toBeUndefined();
    const warn = await postHook(failed);
    expect(warn?.additionalContext).toContain('same error repeated 2x');
    await postHook(failed);
    const block = preHook({ toolName: 'read', toolInput: { path: '/next' } });
    expect(block?.decision).toBe('block');
    expect(block?.reason).toContain('same tool error repeated 3 times');
  });

  it('warns when mutating steps stop changing the git diff and blocks the next step', async () => {
    const api = makeApi({
      extensions: { 'loop-breaker': { noDiffWarnAfter: 1, noDiffBlockAfter: 2, blockAfter: 99 } },
    });
    loopBreakerPlugin.setup(api as never);
    const preHook = getHook(api);
    const postHook = getAsyncHook(api, 'PostToolUse');
    const okEdit = {
      toolName: 'edit',
      toolInput: { path: 'packages/plugins/tests/loop-breaker.test.ts' },
      cwd: process.cwd(),
      toolResult: { isError: false, content: 'ok' },
    };
    expect(await postHook(okEdit)).toBeUndefined();
    const warn = await postHook(okEdit);
    expect(warn?.additionalContext).toContain('no diff has changed for 1 mutating step');
    await postHook(okEdit);
    const block = preHook({ toolName: 'read', toolInput: { path: '/next' } });
    expect(block?.decision).toBe('block');
    expect(block?.reason).toContain('no diff was produced');
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
    const api = makeApi({ extensions: { 'loop-breaker': { mode: 'block' } } });
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

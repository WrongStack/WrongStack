import { beforeEach, describe, expect, it, vi } from 'vitest';

const errorLensPlugin = (await import('../src/error-lens')).default;
const { extractErrorLine, extractFrames } = await import('../src/error-lens');

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
  llm?: { complete: ReturnType<typeof vi.fn>; defaults: ReturnType<typeof vi.fn> } | undefined;
}

function makeApi(
  overrides: { extensions?: Record<string, unknown>; llm?: MockApi['llm'] } = {},
): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    llm: overrides.llm,
  };
}

type HookResult = { additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => Promise<HookResult> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  const fn = (call as unknown[])[2] as (input: unknown) => HookResult | Promise<HookResult>;
  return async (input: unknown) => fn(input);
}

const NODE_TRACE = `
> vitest run

TypeError: Cannot read properties of undefined (reading 'foo')
    at computeThing (src/lib/compute.ts:42:15)
    at run (src/main.ts:10:3)
    at node:internal/modules/run_main:1:1
    at Object.<anonymous> (node_modules/vitest/dist/cli.js:5:1)
`.repeat(2);

const PY_TRACE = `
Traceback (most recent call last):
  File "app/server.py", line 88, in handle
    result = parse(data)
  File "app/parser.py", line 12, in parse
    raise ValueError("bad input")
ValueError: bad input
`.repeat(3);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractErrorLine / extractFrames', () => {
  it('extracts a JS error line and prioritizes project frames', () => {
    expect(extractErrorLine(NODE_TRACE)).toContain('TypeError');
    const frames = extractFrames(NODE_TRACE, 5);
    expect(frames[0]).toBe('src/lib/compute.ts:42');
    expect(frames).toContain('src/main.ts:10');
    const vendorIdx = frames.findIndex((f) => f.includes('node_modules'));
    if (vendorIdx !== -1) expect(vendorIdx).toBeGreaterThan(1);
  });

  it('extracts Python error line and frames', () => {
    expect(extractErrorLine(PY_TRACE)).toContain('ValueError');
    const frames = extractFrames(PY_TRACE, 5);
    expect(frames).toContain('app/server.py:88');
    expect(frames).toContain('app/parser.py:12');
  });

  it('returns null/[] for clean output', () => {
    expect(extractErrorLine('all tests passed\n42 files ok')).toBeNull();
    expect(extractFrames('hello world', 5)).toHaveLength(0);
  });
});

describe('error-lens plugin', () => {
  it('registers error_lens_history and a PostToolUse bash|exec hook', () => {
    const api = makeApi();
    errorLensPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('bash|exec');
  });

  it('injects a digest on a failing command', async () => {
    const api = makeApi();
    errorLensPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'bash',
      toolInput: { command: 'pnpm test' },
      toolResult: { content: NODE_TRACE, isError: true },
    });
    expect(result?.additionalContext).toContain('error-lens digest');
    expect(result?.additionalContext).toContain('TypeError');
    expect(result?.additionalContext).toContain('src/lib/compute.ts:42');
  });

  it('flags a repeated identical failure', async () => {
    const api = makeApi();
    errorLensPlugin.setup(api as never);
    const hook = getHook(api);
    const input = {
      toolName: 'bash',
      toolInput: { command: 'pnpm test' },
      toolResult: { content: NODE_TRACE, isError: true },
    };
    await hook(input);
    const second = await hook(input);
    expect(second?.additionalContext).toContain('SAME failure');
  });

  it('ignores successful results even when they contain traces', async () => {
    const api = makeApi();
    errorLensPlugin.setup(api as never);
    const hook = getHook(api);
    expect(
      await hook({
        toolName: 'bash',
        toolInput: { command: 'cat error.log' },
        toolResult: { content: NODE_TRACE, isError: false },
      }),
    ).toBeUndefined();
  });

  it('ignores short outputs below minOutputChars', async () => {
    const api = makeApi();
    errorLensPlugin.setup(api as never);
    const hook = getHook(api);
    expect(
      await hook({
        toolName: 'bash',
        toolInput: { command: 'x' },
        toolResult: { content: 'Error: nope', isError: true },
      }),
    ).toBeUndefined();
  });

  it('enabled:false disables digests', async () => {
    const api = makeApi({ extensions: { 'error-lens': { enabled: false } } });
    errorLensPlugin.setup(api as never);
    const hook = getHook(api);
    expect(
      await hook({
        toolName: 'bash',
        toolInput: { command: 'pnpm test' },
        toolResult: { content: NODE_TRACE, isError: true },
      }),
    ).toBeUndefined();
  });

  it('error_lens_history returns recorded failures', async () => {
    const api = makeApi();
    errorLensPlugin.setup(api as never);
    const hook = getHook(api);
    await hook({
      toolName: 'bash',
      toolInput: { command: 'pnpm test' },
      toolResult: { content: NODE_TRACE, isError: true },
    });
    const call = api.tools.register.mock.calls[0]![0] as {
      execute: (input: unknown) => Promise<Record<string, unknown>>;
    };
    const history = await call.execute({});
    const failures = history['failures'] as Array<{ errorLine: string | null; repeats: number }>;
    expect(failures).toHaveLength(1);
    expect(failures[0]!.errorLine).toContain('TypeError');
  });

  it('teardown zeros counters and logs', async () => {
    const api = makeApi();
    errorLensPlugin.setup(api as never);
    errorLensPlugin.teardown!(api as never);
    const health = (await errorLensPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['digestsInjected']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith('error-lens: teardown complete', expect.any(Object));
  });
});

describe('error-lens AI hints (api.llm)', () => {
  const failing = {
    toolName: 'bash',
    toolInput: { command: 'pnpm test' },
    toolResult: { content: NODE_TRACE, isError: true },
  };

  it('appends an LLM hint to NEW failure digests when aiHints is on', async () => {
    const llm = {
      complete: vi.fn().mockResolvedValue({
        text: 'Add a null check before accessing .foo in compute.ts.',
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        usage: { input: 50, output: 20 },
        stopReason: 'end_turn',
      }),
      defaults: vi.fn(() => ({ provider: 'anthropic', model: 'claude-haiku-4-5' })),
    };
    const api = makeApi({ extensions: { 'error-lens': { aiHints: true } }, llm });
    errorLensPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook(failing);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(result?.additionalContext).toContain('hint (claude-haiku-4-5)');
    expect(result?.additionalContext).toContain('null check');

    // Repeat failure → no second LLM call.
    await hook(failing);
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('digest still lands when the LLM call fails', async () => {
    const llm = {
      complete: vi.fn().mockRejectedValue(new Error('provider down')),
      defaults: vi.fn(() => ({ provider: 'anthropic', model: 'x' })),
    };
    const api = makeApi({ extensions: { 'error-lens': { aiHints: true } }, llm });
    errorLensPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook(failing);
    expect(result?.additionalContext).toContain('error-lens digest');
    expect(result?.additionalContext).not.toContain('hint (');
  });

  it('no LLM calls when aiHints is off or api.llm is absent', async () => {
    const llm = {
      complete: vi.fn(),
      defaults: vi.fn(),
    };
    const apiOff = makeApi({ extensions: { 'error-lens': { aiHints: false } }, llm });
    errorLensPlugin.setup(apiOff as never);
    await getHook(apiOff)(failing);
    expect(llm.complete).not.toHaveBeenCalled();

    const apiNoLlm = makeApi({ extensions: { 'error-lens': { aiHints: true } } });
    errorLensPlugin.setup(apiNoLlm as never);
    const result = await getHook(apiNoLlm)(failing);
    expect(result?.additionalContext).toContain('error-lens digest');
  });
});

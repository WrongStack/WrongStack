import { beforeEach, describe, expect, it, vi } from 'vitest';
import lintGatePlugin from '../src/lint-gate';

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
  onEvent: ReturnType<typeof vi.fn>;
  emitCustom: ReturnType<typeof vi.fn>;
  session: { append: ReturnType<typeof vi.fn> };
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    emitCustom: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

function getHook(
  api: MockApi,
): (
  input: unknown,
) => Promise<{ decision?: string; reason?: string; additionalContext?: string } | void> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as ReturnType<typeof getHook>;
}

function getStatusTool(api: MockApi): { execute: (input: unknown) => Promise<unknown> } {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === 'lint_gate_status',
  );
  if (!call) throw new Error('lint_gate_status not registered');
  return call[0] as { execute: (input: unknown) => Promise<unknown> };
}

beforeEach(() => vi.clearAllMocks());

describe('lint-gate plugin', () => {
  it('registers lint_gate_status tool and a PreToolUse hook', () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    expect(api.registerHook).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PreToolUse');
    expect(matcher).toBe('write|edit');
  });
});

describe('hook behavior', () => {
  it('passes through when toolName is not write/edit', async () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'echo hi' } });
    expect(result).toBeUndefined();
  });

  it('passes through when path is missing', async () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'write', toolInput: { content: 'hello' } });
    expect(result).toBeUndefined();
  });

  it('passes through when content is missing on write', async () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'write', toolInput: { path: '/tmp/x.ts' } });
    expect(result).toBeUndefined();
  });
});

describe('lint_gate_status tool', () => {
  it('reports config + counters', async () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    const result = await getStatusTool(api).execute({});
    expect(result.mode).toBe('warn'); // default
    expect(result.severity).toBe('error'); // default
    expect(result.counters.invocations).toBe(0);
  });
});

describe('issue #363 Windows shim + failurePolicy + temp cleanup', () => {
  it('registers PreToolUse with failurePolicy closed', () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    const opts = api.registerHook.mock.calls[0]![3] as { failurePolicy?: string };
    expect(opts.failurePolicy).toBe('closed');
  });

  it('resolveLocalLinter uses node + the JS entry, not npx', async () => {
    const { resolveLocalLinter } = await import('../src/lint-gate/index.js');
    const resolved = resolveLocalLinter('biome', process.cwd());
    if (!resolved) {
      // Workspace without a local biome install — the contract is still
      // "when it resolves, it is node <entry>".
      expect(resolved).toBeNull();
      return;
    }
    expect(resolved.cmd).toBe(process.execPath);
    expect(resolved.args[0]).not.toMatch(/npx/i);
    expect(resolved.args[0]).toMatch(/biome/i);
  });
});

describe('teardown + H1 pattern', () => {
  it('logs completion line and does not throw', () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    expect(() => lintGatePlugin.teardown!(api as never)).not.toThrow();
    expect(api.log.info).toHaveBeenCalledWith('lint-gate: teardown complete', expect.any(Object));
  });

  it('zeros counters on teardown', async () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    lintGatePlugin.teardown!(api as never);
    const health = await lintGatePlugin.health!();
    expect(health.counters.invocations).toBe(0);
    expect(health.counters.hits).toBe(0);
  });

  it('teardown is safe before setup (defensive)', () => {
    const api = makeApi();
    expect(() => lintGatePlugin.teardown!(api as never)).not.toThrow();
  });
});

describe('config parsing', () => {
  it('reads custom mode and severity from config', async () => {
    const api = makeApi({
      extensions: { 'lint-gate': { mode: 'block', severity: 'warning' } },
    });
    lintGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.mode).toBe('block');
    expect(status.severity).toBe('warning');
  });

  it('falls back to defaults for unknown values', async () => {
    const api = makeApi({
      extensions: { 'lint-gate': { mode: 'invalid', linter: 'invalid' } },
    });
    lintGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.mode).toBe('warn'); // default
  });

  it('parses fix mode from config', async () => {
    const api = makeApi({
      extensions: { 'lint-gate': { mode: 'fix' } },
    });
    lintGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.mode).toBe('fix');
  });

  it('reports fixes counter in status', async () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.counters.fixes).toBe(0);
  });

  it('parses fixRules from config', async () => {
    const api = makeApi({
      extensions: {
        'lint-gate': { mode: 'fix', fixRules: ['lint/style/useImportType', 'format'] },
      },
    });
    lintGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.mode).toBe('fix');
    expect(status.fixRules).toEqual(['lint/style/useImportType', 'format']);
  });

  it('defaults fixRules to empty array', async () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.fixRules).toEqual([]);
  });
});

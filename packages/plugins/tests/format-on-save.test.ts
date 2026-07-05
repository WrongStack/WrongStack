import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock execSync + execFileSync before importing the plugin. The plugin
// switched from execSync string templates to execFileSync argv to defeat
// shell-injection; tests must cover both surfaces.
const mockExecSync = vi.fn((cmd: string): string => {
  if (cmd.includes('--version')) return '2.5.1\n';
  return '';
});

const mockExecFileSync = vi.fn((_cmd: string, _args: string[]): string => {
  // biome --write returns empty on success; second invocation (check
  // mode) also returns empty when the file is already clean. Tests can
  // override mockExecFileSync.mockImplementation when they need
  // specific behavior (size change, parse error, etc.).
  return '';
});

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
}));

// Mock fs to simulate file existence + size changes.
const mockStatSync = vi.fn((): { size: number } => ({ size: 100 }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  statSync: mockStatSync,
}));

const formatOnSavePlugin = (await import('../src/format-on-save')).default;

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

function getHook(api: MockApi): (input: unknown) => { additionalContext?: string } | void {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as ReturnType<typeof getHook>;
}

function getStatusTool(api: MockApi): { execute: (input: unknown) => Promise<unknown> } {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === 'format_on_save_status',
  );
  if (!call) throw new Error('format_on_save_status not registered');
  return call[0] as { execute: (input: unknown) => Promise<unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset to default: file exists, size stays 100 (clean)
  mockStatSync.mockReturnValue({ size: 100 });
});

describe('format-on-save plugin', () => {
  it('registers format_on_save_status tool and a PostToolUse hook', () => {
    const api = makeApi();
    formatOnSavePlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    expect(api.registerHook).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });
});

describe('hook behavior', () => {
  it('stays silent when file is already formatted (no change)', () => {
    const api = makeApi();
    formatOnSavePlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: { path: 'src/test.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('injects context when file size changed (formatted)', () => {
    // Simulate: before=100, after=120 (file grew = reformatted)
    let callCount = 0;
    mockStatSync.mockImplementation(() => {
      callCount++;
      return { size: callCount === 1 ? 100 : 120 };
    });

    const api = makeApi();
    formatOnSavePlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'edit',
      toolInput: { path: 'src/test.ts', old_string: 'a', new_string: 'b' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.additionalContext).toContain('format-on-save');
    expect(result?.additionalContext).toContain('src/test.ts');
  });

  it('stays silent when tool errored', () => {
    const api = makeApi();
    formatOnSavePlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: { path: 'src/test.ts', content: 'x' },
      toolResult: { content: 'error', isError: true },
    });
    expect(result).toBeUndefined();
  });

  it('stays silent when enabled=false', () => {
    const api = makeApi({ extensions: { 'format-on-save': { enabled: false } } });
    formatOnSavePlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: { path: 'src/test.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('stays silent when path is missing', () => {
    const api = makeApi();
    formatOnSavePlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: { content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('does not invoke biome when the file path is outside the project root', () => {
    const api = makeApi();
    formatOnSavePlugin.setup(api as never);
    const hook = getHook(api);
    const outside =
      process.platform === 'win32' ? 'C:\\Windows\\System32\\evil.ts' : '/etc/evil.ts';
    const result = hook({
      toolName: 'write',
      toolInput: { path: outside, content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
    // biome binary probe still runs at setup time, but the per-file
    // format --write must not.
    expect(
      mockExecFileSync.mock.calls.some(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('--write'),
      ),
    ).toBe(false);
  });

  it('does not invoke biome when the path traverses out of the project root', () => {
    const api = makeApi();
    formatOnSavePlugin.setup(api as never);
    const hook = getHook(api);
    const escape = '../../escape.ts';
    const result = hook({
      toolName: 'write',
      toolInput: { path: escape, content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
    expect(
      mockExecFileSync.mock.calls.some(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('--write'),
      ),
    ).toBe(false);
  });
});

describe('status tool', () => {
  it('reports config + counters', async () => {
    const api = makeApi();
    formatOnSavePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.enabled).toBe(true);
    expect(status.biomeAvailable).toBe(true);
    expect(status.counters.invocations).toBe(0);
  });

  it('reports enabled=false from config', async () => {
    const api = makeApi({ extensions: { 'format-on-save': { enabled: false } } });
    formatOnSavePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.enabled).toBe(false);
  });
});

describe('teardown + H1 pattern', () => {
  it('logs completion line and does not throw', () => {
    const api = makeApi();
    formatOnSavePlugin.setup(api as never);
    expect(() => formatOnSavePlugin.teardown!(api as never)).not.toThrow();
    expect(api.log.info).toHaveBeenCalledWith(
      'format-on-save: teardown complete',
      expect.any(Object),
    );
  });

  it('zeros counters on teardown', async () => {
    const api = makeApi();
    formatOnSavePlugin.setup(api as never);
    const hook = getHook(api);
    hook({
      toolName: 'write',
      toolInput: { path: 'src/test.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    formatOnSavePlugin.teardown!(api as never);
    const health = await formatOnSavePlugin.health!();
    expect(health.counters.invocations).toBe(0);
    expect(health.counters.formatted).toBe(0);
  });

  it('teardown is safe before setup (defensive)', () => {
    const api = makeApi();
    expect(() => formatOnSavePlugin.teardown!(api as never)).not.toThrow();
  });
});

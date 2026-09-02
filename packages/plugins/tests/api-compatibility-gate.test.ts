import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const { execFile } = await import('node:child_process');
const { existsSync, readFileSync } = await import('node:fs');
const { readFile } = await import('node:fs/promises');
const plugin = (await import('../src/api-compatibility-gate')).default;

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
  };
  registerHook: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: {
      extensions: {
        'api-compatibility-gate': { enabled: true },
        ...(overrides.extensions ?? {}),
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => Promise<HookResult> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => Promise<HookResult>;
}

function mockGitVersion(stdout: string | null): void {
  vi.mocked(execFile).mockImplementationOnce(((
    _command: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    callback(stdout === null ? new Error('not a git repo') : null, stdout ?? '', '');
    return {};
  }) as never);
}

function getTool(api: MockApi, name: string): (input: unknown) => Promise<unknown> {
  const call = api.tools.register.mock.calls.find((c) => (c[0] as { name: string }).name === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return (call[0] as { execute: (input: unknown) => Promise<unknown> }).execute;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execFile).mockReset();
  vi.mocked(readFile).mockReset();
  vi.mocked(readFileSync).mockReset();
  vi.mocked(existsSync).mockReset().mockReturnValue(false);
});

afterEach(async () => {
  const api = makeApi();
  await plugin.teardown?.(api as never);
});

describe('api-compatibility-gate plugin', () => {
  it('registers api_compat_status and a PostToolUse write|edit hook', () => {
    const api = makeApi();
    plugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [tool] = api.tools.register.mock.calls[0]!;
    expect((tool as { name: string }).name).toBe('api_compat_status');
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });

  it('skips non-entry-point files', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/internal-helper.ts' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('detects removed exports and warns by default', async () => {
    mockGitVersion('export const foo = 1;\nexport function bar() {}\n');
    vi.mocked(readFile).mockResolvedValue('export const foo = 1;\n');

    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/index.ts' },
      toolResult: { content: '', isError: false },
    });

    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['show', 'HEAD:src/index.ts'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(result?.additionalContext).toContain('bar');
    expect(result?.additionalContext).toContain('removed exported identifiers');
    expect(result?.decision).toBeUndefined();
  });

  it('detects added exports and reports them alongside removals', async () => {
    mockGitVersion('export const foo = 1;\nexport function bar() {}\n');
    vi.mocked(readFile).mockResolvedValue('export const foo = 1;\nexport const baz = 2;\n');

    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'index.ts' },
      toolResult: { content: '', isError: false },
    });

    expect(result?.additionalContext).toContain('bar');
    expect(result?.additionalContext).toContain('baz');
    expect(result?.additionalContext).toContain('Added exports');
  });

  it('returns no context when exports are only added', async () => {
    mockGitVersion('export const foo = 1;\n');
    vi.mocked(readFile).mockResolvedValue('export const foo = 1;\nexport const baz = 2;\n');

    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/index.ts' },
      toolResult: { content: '', isError: false },
    });

    expect(result).toBeUndefined();
  });

  it('block severity returns a block decision on removed exports', async () => {
    mockGitVersion('export const foo = 1;\nexport function bar() {}\n');
    vi.mocked(readFile).mockResolvedValue('export const foo = 1;\n');

    const api = makeApi({
      extensions: { 'api-compatibility-gate': { severity: 'block' } },
    });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/index.ts' },
      toolResult: { content: '', isError: false },
    });

    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('bar');
  });

  it('enabled:false disables the hook', async () => {
    mockGitVersion('export const foo = 1;\n');
    vi.mocked(readFile).mockResolvedValue('');

    const api = makeApi({
      extensions: { 'api-compatibility-gate': { enabled: false } },
    });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/index.ts' },
      toolResult: { content: '', isError: false },
    });

    expect(result).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('skips when git history is unavailable', async () => {
    mockGitVersion(null);

    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/index.ts' },
      toolResult: { content: '', isError: false },
    });

    expect(result).toBeUndefined();
  });

  it('skips when trackGitHistory is disabled', async () => {
    const api = makeApi({
      extensions: { 'api-compatibility-gate': { trackGitHistory: false } },
    });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/index.ts' },
      toolResult: { content: '', isError: false },
    });

    expect(result).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('skips when the tool result itself errored', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/index.ts' },
      toolResult: { content: 'failed', isError: true },
    });

    expect(result).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('recognizes package entry points via package.json', async () => {
    vi.mocked(existsSync).mockImplementation((p: string) => {
      return normalizePath(String(p)) === 'fake-root/package.json';
    });
    vi.mocked(readFileSync).mockImplementation((p: string) => {
      if (normalizePath(String(p)) === 'fake-root/package.json') {
        return JSON.stringify({ main: 'src/index.ts' });
      }
      return 'export const foo = 1;\n';
    });
    vi.mocked(readFile).mockResolvedValue('export const foo = 1;\n');
    mockGitVersion('export const foo = 1;\nexport function bar() {}\n');

    vi.spyOn(process, 'cwd').mockReturnValue('fake-root');

    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/index.ts' },
      toolResult: { content: '', isError: false },
    });

    expect(result?.additionalContext).toContain('bar');
  });

  it('api_compat_status reports counters and last result', async () => {
    mockGitVersion('export const foo = 1;\nexport function bar() {}\n');
    vi.mocked(readFile).mockResolvedValue('export const foo = 1;\n');

    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const tool = getTool(api, 'api_compat_status');

    await hook({
      toolName: 'edit',
      toolInput: { path: 'src/index.ts' },
      toolResult: { content: '', isError: false },
    });

    const status = (await tool({})) as {
      ok: boolean;
      counters: Record<string, number>;
      lastResult: { removed: string[]; added: string[] };
    };
    expect(status.ok).toBe(true);
    expect(status.counters.checked).toBe(1);
    expect(status.counters.breaking).toBe(1);
    expect(status.lastResult.removed).toContain('bar');
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    plugin.teardown!(api as never);
    const health = (await plugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['checked']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'api-compatibility-gate: teardown complete',
      expect.any(Object),
    );
  });
});

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock execSync + execFileSync before importing the plugin. The plugin
// switched from execSync string templates to execFileSync argv to defeat
// shell-injection; tests must cover both surfaces.
const mockExecSync = vi.fn((cmd: string): string => {
  if (cmd.includes('ls-files')) return 'src/test.ts\n';
  if (cmd.includes('git diff --no-index')) {
    throw {
      stdout: 'diff --git a/dev/null b/src/test.ts\nnew file mode 100644\n+const x = 1;\n',
      killed: false,
    };
  }
  if (cmd.includes('git diff')) {
    return 'diff --git a/src/test.ts b/src/test.ts\n-old code\n+new code\n';
  }
  return '';
});

const mockExecFileSync = vi.fn((_cmd: string, args: string[]): string => {
  const joined = args.join(' ');
  if (joined.includes('ls-files')) return 'src/test.ts\n';
  if (joined.includes('--no-index')) {
    throw {
      stdout: 'diff --git a/dev/null b/src/test.ts\nnew file mode 100644\n+const x = 1;\n',
      killed: false,
    };
  }
  return 'diff --git a/src/test.ts b/src/test.ts\n-old code\n+new code\n';
});

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
}));

const diffSummaryPlugin = (await import('../src/diff-summary')).default;

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
    ([t]: unknown[]) => (t as { name: string }).name === 'diff_summary_status',
  );
  if (!call) throw new Error('diff_summary_status not registered');
  return call[0] as { execute: (input: unknown) => Promise<unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('diff-summary plugin', () => {
  it('registers diff_summary_status tool and a PostToolUse hook', () => {
    const api = makeApi();
    diffSummaryPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    expect(api.registerHook).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });
});

describe('hook behavior', () => {
  it('injects diff context after a successful write', () => {
    const api = makeApi();
    diffSummaryPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: { path: 'src/test.ts', content: 'new code' },
      toolResult: { content: 'wrote 5 lines', isError: false },
    });
    expect(result?.additionalContext).toContain('diff-summary');
    expect(result?.additionalContext).toContain('src/test.ts');
  });

  it('injects diff context after a successful edit', () => {
    const api = makeApi();
    diffSummaryPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'edit',
      toolInput: { path: 'src/test.ts', old_string: 'old', new_string: 'new' },
      toolResult: { content: 'edited', isError: false },
    });
    expect(result?.additionalContext).toContain('diff-summary');
  });

  it('stays silent when the tool errored', () => {
    const api = makeApi();
    diffSummaryPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: { path: 'src/test.ts', content: 'x' },
      toolResult: { content: 'error', isError: true },
    });
    expect(result).toBeUndefined();
  });

  it('stays silent when mode=off', () => {
    const api = makeApi({ extensions: { 'diff-summary': { mode: 'off' } } });
    diffSummaryPlugin.setup(api as never);
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
    diffSummaryPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: { content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });
});

describe('stat mode', () => {
  it('injects only stat summary in stat mode', () => {
    const api = makeApi({ extensions: { 'diff-summary': { mode: 'stat' } } });
    diffSummaryPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'edit',
      toolInput: { path: 'src/test.ts', old_string: 'a', new_string: 'b' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.additionalContext).toContain('+');
    expect(result?.additionalContext).toContain('-');
    // Stat mode should NOT include the diff body
    expect(result?.additionalContext).not.toContain('diff --git');
  });
});

describe('config parsing', () => {
  it('reads custom maxLines from config', async () => {
    const api = makeApi({ extensions: { 'diff-summary': { maxLines: 10 } } });
    diffSummaryPlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.maxLines).toBe(10);
  });

  it('defaults maxLines to 50', async () => {
    const api = makeApi();
    diffSummaryPlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.maxLines).toBe(50);
  });

  it('defaults includeContext to 3', async () => {
    const api = makeApi();
    diffSummaryPlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.includeContext).toBe(3);
  });

  it('parses includeContext from config', async () => {
    const api = makeApi({ extensions: { 'diff-summary': { includeContext: 0 } } });
    diffSummaryPlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.includeContext).toBe(0);
  });
});

describe('includeContext in git diff command', () => {
  it('passes -U0 when includeContext=0', () => {
    const api = makeApi({ extensions: { 'diff-summary': { includeContext: 0 } } });
    diffSummaryPlugin.setup(api as never);
    const hook = getHook(api);
    hook({
      toolName: 'write',
      toolInput: { path: 'src/test.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    // Plugin uses execFileSync argv-form; verify the -U0 flag passed through.
    const diffCall = mockExecFileSync.mock.calls.find(
      (c: unknown[]) =>
        Array.isArray(c[1]) &&
        (c[1] as string[]).includes('diff') &&
        (c[1] as string[]).some((a) => a.startsWith('-U')),
    );
    expect(diffCall).toBeDefined();
    expect((diffCall![1] as string[]).some((a) => a === '-U0')).toBe(true);
  });

  it('passes -U5 when includeContext=5', () => {
    const api = makeApi({ extensions: { 'diff-summary': { includeContext: 5 } } });
    diffSummaryPlugin.setup(api as never);
    const hook = getHook(api);
    hook({
      toolName: 'write',
      toolInput: { path: 'src/test.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    const diffCall = mockExecFileSync.mock.calls.find(
      (c: unknown[]) =>
        Array.isArray(c[1]) &&
        (c[1] as string[]).includes('diff') &&
        (c[1] as string[]).some((a) => a.startsWith('-U')),
    );
    expect(diffCall).toBeDefined();
    expect((diffCall![1] as string[]).some((a) => a === '-U5')).toBe(true);
  });

  it('passes -U3 by default', () => {
    const api = makeApi();
    diffSummaryPlugin.setup(api as never);
    const hook = getHook(api);
    hook({
      toolName: 'write',
      toolInput: { path: 'src/test.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    const diffCall = mockExecFileSync.mock.calls.find(
      (c: unknown[]) =>
        Array.isArray(c[1]) &&
        (c[1] as string[]).includes('diff') &&
        (c[1] as string[]).some((a) => a.startsWith('-U')),
    );
    expect(diffCall).toBeDefined();
    expect((diffCall![1] as string[]).some((a) => a === '-U3')).toBe(true);
  });
});

describe('sandbox', () => {
  it('does not invoke git when the file path is outside the project root', () => {
    const api = makeApi();
    diffSummaryPlugin.setup(api as never);
    const hook = getHook(api);
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\evil.ts' : '/etc/passwd';
    const result = hook({
      toolName: 'write',
      toolInput: { path: outside, content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    // Hook should silently return void (no additionalContext) instead of
    // leaking host file content through git diff.
    expect(result).toBeUndefined();
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('does not invoke git when the path traverses out of the project root', () => {
    const api = makeApi();
    diffSummaryPlugin.setup(api as never);
    const hook = getHook(api);
    const escapedPath = '../../escape.ts';
    hook({
      toolName: 'write',
      toolInput: { path: escapedPath, content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

describe('teardown + H1 pattern', () => {
  it('logs completion line and does not throw', () => {
    const api = makeApi();
    diffSummaryPlugin.setup(api as never);
    expect(() => diffSummaryPlugin.teardown!(api as never)).not.toThrow();
    expect(api.log.info).toHaveBeenCalledWith(
      'diff-summary: teardown complete',
      expect.any(Object),
    );
  });

  it('zeros counters on teardown', async () => {
    const api = makeApi();
    diffSummaryPlugin.setup(api as never);
    const hook = getHook(api);
    hook({
      toolName: 'write',
      toolInput: { path: 'src/test.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    diffSummaryPlugin.teardown!(api as never);
    const health = await diffSummaryPlugin.health!();
    expect(health.counters.invocations).toBe(0);
    expect(health.counters.injected).toBe(0);
  });

  it('teardown is safe before setup (defensive)', () => {
    const api = makeApi();
    expect(() => diffSummaryPlugin.teardown!(api as never)).not.toThrow();
  });
});

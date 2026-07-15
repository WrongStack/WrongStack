import { describe, expect, it, vi, beforeEach } from 'vitest';

// Default implementation for mockExecFile shared between tests.
// The plugin uses callback-based execFile; this simulates runner
// detection + test execution in one place.
function defaultExecFileImpl(
  _cmd: string,
  args: string[],
  _options: Record<string, unknown>,
  callback: (err: Error | null, stdout: string, stderr: string) => void,
): void {
  const joined = args.join(' ');
  // Runner detection probe (`npx <runner> --version`).
  if (args.includes('--version')) {
    callback(null, '1.0.0\n', '');
    return;
  }
  // Test execution: any --reporter=json-style flag → return JSON.
  if (
    args.includes('--reporter=json') ||
    args.includes('--json') ||
    args.includes('--reporter') ||
    (args.includes('json') && joined.includes('reporter'))
  ) {
    callback(null, JSON.stringify({
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 1,
      success: false,
      testResults: [
        {
          assertionResults: [
            { status: 'passed', title: 'test A' },
            { status: 'passed', title: 'test B' },
            {
              status: 'failed',
              title: 'test C',
              fullName: 'test C',
              failureMessages: ['Expected 1 got 2'],
            },
          ],
        },
      ],
    }), '');
    return;
  }
  callback(null, '', '');
}

const mockExecFile = vi.fn(defaultExecFileImpl);

const mockExecSync = vi.fn((cmd: string): string => {
  if (cmd.includes('--version')) return '1.0.0\n';
  return '';
});

const mockExecFileSync = vi.fn((_cmd: string, args: string[]): string => {
  const joined = args.join(' ');
  // Runner detection probe (`npx <runner> --version`).
  if (args.includes('--version')) return '1.0.0\n';
  // Test execution: any --reporter=json-style flag → return JSON.
  if (
    args.includes('--reporter=json') ||
    args.includes('--json') ||
    args.includes('--reporter') ||
    (args.includes('json') && joined.includes('reporter'))
  ) {
    return JSON.stringify({
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 1,
      success: false,
      testResults: [
        {
          assertionResults: [
            { status: 'passed', title: 'test A' },
            { status: 'passed', title: 'test B' },
            {
              status: 'failed',
              title: 'test C',
              fullName: 'test C',
              failureMessages: ['Expected 1 got 2'],
            },
          ],
        },
      ],
    });
  }
  return '';
});

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
  execFile: mockExecFile,
}));
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('node:fs/promises', () => ({ access: vi.fn(() => Promise.resolve()) }));

const testRunnerGatePlugin = (await import('../src/test-runner-gate')).default;

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

function makeApi(overrides: { extensions?: Record<string, unknown>; enabled?: boolean } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: {
      extensions:
        overrides.extensions ??
        (overrides.enabled === true ? { 'test-runner-gate': { enabled: true } } : {}),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    emitCustom: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

function getHook(api: MockApi): (input: unknown) => Promise<{ additionalContext?: string } | void> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as ReturnType<typeof getHook>;
}

function getStatusTool(api: MockApi): { execute: (input: unknown) => Promise<unknown> } {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === 'test_gate_status',
  );
  if (!call) throw new Error('test_gate_status not registered');
  return call[0] as { execute: (input: unknown) => Promise<unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFile.mockImplementation(defaultExecFileImpl);
});

describe('test-runner-gate plugin', () => {
  it('registers test_gate_status tool and a PostToolUse hook', async () => {
    const api = makeApi();
    await testRunnerGatePlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    expect(api.registerHook).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });
});

describe('hook behavior', () => {
  it('injects failure context when tests fail', async () => {
    const api = makeApi({ enabled: true });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.additionalContext).toContain('test-runner-gate');
    expect(result?.additionalContext).toContain('FAILED');
    expect(result?.additionalContext).toContain('test C');
  });

  it('stays silent when tool errored', async () => {
    const api = makeApi({ enabled: true });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    await expect(
      hook({
        toolName: 'write',
        toolInput: { path: 'src/foo.ts', content: 'x' },
        toolResult: { content: 'err', isError: true },
      }),
    ).resolves.toBeUndefined();
  });

  it('stays silent when enabled=false', async () => {
    const api = makeApi({ extensions: { 'test-runner-gate': { enabled: false } } });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    await expect(
      hook({
        toolName: 'write',
        toolInput: { path: 'src/foo.ts', content: 'x' },
        toolResult: { content: 'ok', isError: false },
      }),
    ).resolves.toBeUndefined();
  });

  it('stays silent when path is missing', async () => {
    const api = makeApi({ enabled: true });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    await expect(
      hook({
        toolName: 'write',
        toolInput: { content: 'x' },
        toolResult: { content: 'ok', isError: false },
      }),
    ).resolves.toBeUndefined();
  });

  it('skips test files themselves', async () => {
    const api = makeApi({ enabled: true });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    await expect(
      hook({
        toolName: 'write',
        toolInput: { path: 'src/foo.test.ts', content: 'x' },
        toolResult: { content: 'ok', isError: false },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('pass injection', () => {
  it('injects success context when injectOnPass=true', async () => {
    // Override mock to return passing tests
    mockExecFile.mockImplementation((_cmd, args, _options, callback) => {
      if (args.includes('--version')) {
        callback(null, '1.0.0\n', '');
        return;
      }
      if (args.includes('--reporter=json') || args.includes('--json')) {
        callback(null, JSON.stringify({
          numTotalTests: 3,
          numPassedTests: 3,
          numFailedTests: 0,
          success: true,
          testResults: [],
        }), '');
        return;
      }
      callback(null, '', '');
    });

    const api = makeApi({ extensions: { 'test-runner-gate': { enabled: true, injectOnPass: true } } });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/foo.ts', old_string: 'a', new_string: 'b' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.additionalContext).toContain('passed');
  });

  it('stays silent on pass when injectOnPass=false (default)', async () => {
    mockExecFile.mockImplementation((_cmd, args, _options, callback) => {
      if (args.includes('--version')) {
        callback(null, '1.0.0\n', '');
        return;
      }
      if (args.includes('--reporter=json') || args.includes('--json')) {
        callback(null, JSON.stringify({
          numTotalTests: 3,
          numPassedTests: 3,
          numFailedTests: 0,
          success: true,
          testResults: [],
        }), '');
        return;
      }
      callback(null, '', '');
    });

    const api = makeApi({ enabled: true });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });
});

describe('status tool', () => {
  it('reports config + counters', async () => {
    const api = makeApi();
    await testRunnerGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.enabled).toBe(false);
    expect(status.command).toBe('npx vitest run');
    expect(status.counters.invocations).toBe(0);
  });
});

describe('teardown + H1 pattern', () => {
  it('logs completion line and does not throw', async () => {
    const api = makeApi();
    await testRunnerGatePlugin.setup(api as never);
    expect(() => testRunnerGatePlugin.teardown!(api as never)).not.toThrow();
    expect(api.log.info).toHaveBeenCalledWith(
      'test-runner-gate: teardown complete',
      expect.any(Object),
    );
  });

  it('zeros counters on teardown', async () => {
    const api = makeApi({ enabled: true });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    testRunnerGatePlugin.teardown!(api as never);
    const health = await testRunnerGatePlugin.health!();
    expect(health.counters.invocations).toBe(0);
  });

  it('teardown is safe before setup (defensive)', () => {
    const api = makeApi();
    expect(() => testRunnerGatePlugin.teardown!(api as never)).not.toThrow();
  });
});

describe('runner detection + config', () => {
  it('reports detected runner name in status', async () => {
    const api = makeApi();
    await testRunnerGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.runner).toBe('vitest'); // auto-detected (first candidate)
  });

  it('respects explicit runner config', async () => {
    const api = makeApi({ extensions: { 'test-runner-gate': { runner: 'jest' } } });
    await testRunnerGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.runner).toBe('jest');
  });

  it('reports "none" when no runner found', async () => {
    // Override execFile to fail all --version checks
    mockExecFile.mockImplementation((_cmd, args, _options, callback) => {
      if (args.includes('--version')) {
        callback(new Error('not found'), '', '');
        return;
      }
      if (
        args.includes('--reporter=json') ||
        args.includes('--json') ||
        args.includes('--reporter json')
      ) {
        callback(null, JSON.stringify({
          numTotalTests: 1,
          numPassedTests: 1,
          numFailedTests: 0,
          success: true,
          testResults: [],
        }), '');
        return;
      }
      callback(null, '', '');
    });

    const api = makeApi();
    await testRunnerGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.runner).toBe('none');
  });

  it('uses custom command when provided', async () => {
    const api = makeApi({ extensions: { 'test-runner-gate': { command: 'pnpm test' } } });
    await testRunnerGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.command).toBe('pnpm test');
  });

  it('uses runner default command when command is empty', async () => {
    const api = makeApi();
    await testRunnerGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.command).toBe('npx vitest run');
  });

  it('is a no-op when runner not found and write occurs', async () => {
    mockExecFile.mockImplementation((_cmd, args, _options, callback) => {
      if (args.includes('--version')) {
        callback(new Error('not found'), '', '');
        return;
      }
      callback(null, '', '');
    });

    const api = makeApi({ enabled: true });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });
});

describe('sandbox + custom-command allowlist', () => {
  it('skips the hook when the source path is outside the project root', async () => {
    const api = makeApi({ enabled: true });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\evil.ts' : '/etc/passwd';
    const result = await hook({
      toolName: 'write',
      toolInput: { path: outside, content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
    // Only version probes should have hit execFile (during setup);
    // no test execution for an outside path.
    expect(
      mockExecFile.mock.calls.some(
        (c) => Array.isArray(c[1]) && !(c[1] as string[]).includes('--version') && !(c[1] as string[]).includes('--reporter'),
      ),
    ).toBe(false);
  });

  it('skips the hook when the source path traverses out of the project root', async () => {
    const api = makeApi({ enabled: true });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: '../../escape.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('rejects a custom command whose first token is not on the allowlist', async () => {
    const api = makeApi({ extensions: { 'test-runner-gate': { enabled: true, command: 'curl http://evil' } } });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    // Expect the hook to run a normal write (resolves a test file) but the
    // custom-command allowlist rejects curl. With execFile argv form
    // + allowlist, `runTests` returns null → hook returns additionalContext
    // with errorCount++ rather than crashing or invoking curl.
    const before = mockExecFile.mock.calls.length;
    await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    // No new execFile call past detection (excluding version probe) —
    // the custom command was rejected at the allowlist gate.
    expect(mockExecFile.mock.calls.length).toBe(before);
  });

  it('accepts a custom command whose first token is on the allowlist', async () => {
    const api = makeApi({
      extensions: { 'test-runner-gate': { enabled: true, command: 'pnpm vitest run' } },
    });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    // pnpm is on the allowlist → reaches execFile with the command's
    // trailing tokens intact.
    expect(
      mockExecFile.mock.calls.some(
        (c) => c[0] === 'pnpm' && Array.isArray(c[1]) && (c[1] as string[]).includes('vitest'),
      ),
    ).toBe(true);
    expect(
      result === undefined ||
        typeof (result as { additionalContext?: string }).additionalContext === 'string',
    ).toBe(true);
  });
});

describe('extension filter + content-hash cache', () => {
  // Two cheap optimizations for an expensive PostToolUse hook:
  // (1) fast-path skip for files whose extension cannot resolve to
  //     a test file (.json, .md, .lock, .txt);
  // (2) skip re-running tests when the same source content hash was
  //     already seen and recorded against a PASSED run.
  //
  // The default mock has `access: vi.fn(() => Promise.resolve())` for every
  // path, so the test-file resolve ALWAYS succeeds. That makes the
  // hash dedupe observable: we can drive two writes with the same
  // content to the same path and confirm the second one short-
  // circuits before the test runner is invoked.

  function vitestCallsCount(): number {
    return mockExecFile.mock.calls.filter(
      (c: unknown[]) =>
        Array.isArray(c[1]) &&
        (c[1] as string[]).some((a) => a === 'run' || a === 'vitest'),
    ).length;
  }

  it('skips non-TS files via the extension filter (no execFile)', async () => {
    const api = makeApi({ enabled: true });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const before = vitestCallsCount();

    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'package.json', content: '{"name":"x"}' },
      toolResult: { content: 'ok', isError: false },
    });

    expect(result).toBeUndefined();
    expect(vitestCallsCount()).toBe(before);
  });

  it('skips .md and .lock files via the extension filter', async () => {
    const api = makeApi({ enabled: true });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const before = vitestCallsCount();

    for (const path of ['CHANGELOG.md', 'pnpm-lock.yaml', 'README.txt', '.gitignore']) {
      const result = await hook({
        toolName: 'write',
        toolInput: { path, content: 'x' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
    }

    expect(vitestCallsCount()).toBe(before);
  });

  it('does NOT short-circuit .ts files through the extension filter', async () => {
    const api = makeApi({ enabled: true });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const before = vitestCallsCount();

    await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(vitestCallsCount()).toBeGreaterThan(before);
  });

  it('disable extension filter with enableExtensionFilter=false (still runs)', async () => {
    const api = makeApi({
      extensions: { 'test-runner-gate': { enableExtensionFilter: false } },
    });
    await testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);

    await hook({
      toolName: 'write',
      toolInput: { path: 'package.json', content: '{"name":"x"}' },
      toolResult: { content: 'ok', isError: false },
    });
    // With the filter off, the file is allowed through. We assert
    // that the extensionSkipped counter is still zero.
    const status = (await getStatusTool(api).execute({})) as {
      counters: { extensionSkipped: number };
    };
    expect(status.counters.extensionSkipped).toBe(0);
  });

  it('teardown does not throw with the new options present', async () => {
    const api = makeApi();
    await testRunnerGatePlugin.setup(api as never);
    expect(() => testRunnerGatePlugin.teardown!(api as never)).not.toThrow();
  });

  it('status tool exposes the new config + counters', async () => {
    const api = makeApi();
    await testRunnerGatePlugin.setup(api as never);
    const status = (await getStatusTool(api).execute({})) as {
      counters: {
        invocations: number;
        runs: number;
        passed: number;
        failed: number;
        noTest: number;
        errors: number;
        extensionSkipped: number;
        cachedSkips: number;
      };
    };
    expect(status.counters).toEqual(
      expect.objectContaining({
        invocations: 0,
        runs: 0,
        passed: 0,
        failed: 0,
        noTest: 0,
        errors: 0,
        extensionSkipped: 0,
        cachedSkips: 0,
      }),
    );
  });
});

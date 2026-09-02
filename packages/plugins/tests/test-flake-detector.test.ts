import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileSync = vi.fn((_cmd: string, _args: string[], _options?: unknown): string => {
  // Default behavior: alternating flaky result across runs is driven per-test.
  return '';
});
const mockExecFile = vi.fn(
  (
    cmd: string,
    args: string[],
    options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    try {
      callback(null, mockExecFileSync(cmd, args, options), '');
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      callback(failure, failure.stdout ?? '', failure.stderr ?? '');
    }
    return {};
  },
);

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

const flakePlugin = (await import('../src/test-flake-detector')).default;

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
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
  };
}

function getTool(api: MockApi, name: string): { execute: (input: unknown) => Promise<unknown> } {
  const call = api.tools.register.mock.calls.find((c) => (c[0] as { name: string }).name === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return call[0] as { execute: (input: unknown) => Promise<unknown> };
}

function getTools(
  api: MockApi,
): Array<{ name: string; permission: string; category: string; mutating: boolean }> {
  return api.tools.register.mock.calls.map((c) => {
    const t = c[0] as { name: string; permission: string; category: string; mutating: boolean };
    return { name: t.name, permission: t.permission, category: t.category, mutating: t.mutating };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSync.mockReset();
  mockExecFile.mockClear();
});

afterEach(async () => {
  const api = makeApi();
  await flakePlugin.teardown?.(api as never);
});

describe('test-flake-detector plugin', () => {
  it('registers flake_detect and flake_status tools', () => {
    const api = makeApi();
    flakePlugin.setup(api as never);
    const tools = getTools(api);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain('flake_detect');
    expect(tools.map((t) => t.name)).toContain('flake_status');
  });

  it('flake_detect is confirm permission and non-mutating', () => {
    const api = makeApi();
    flakePlugin.setup(api as never);
    const tools = getTools(api);
    const detect = tools.find((t) => t.name === 'flake_detect');
    expect(detect?.permission).toBe('confirm');
    expect(detect?.mutating).toBe(false);
    expect(detect?.category).toBe('Diagnostics');
  });

  it('detects a flaky test across runs', async () => {
    let run = 0;
    mockExecFileSync.mockImplementation(() => {
      run += 1;
      // Even runs pass the flaky test, odd runs fail it.
      return run % 2 === 0 ? '  ✓ flaky test\n' : '  ✕ flaky test\n';
    });

    const api = makeApi();
    flakePlugin.setup(api as never);
    const detect = getTool(api, 'flake_detect');
    const result = (await detect.execute({ testPattern: 'src/foo.test.ts', runs: 5 })) as {
      ok: boolean;
      runsRequested: number;
      runsCompleted: number;
      flakyTests: Array<{ test: string; passCount: number; failCount: number }>;
      alwaysPassing: Array<{ test: string }>;
      alwaysFailing: Array<{ test: string }>;
    };

    expect(result.ok).toBe(true);
    expect(result.runsRequested).toBe(5);
    expect(result.runsCompleted).toBe(5);
    expect(result.flakyTests).toHaveLength(1);
    expect(result.flakyTests[0].test).toBe('flaky test');
    expect(result.flakyTests[0].passCount).toBe(2);
    expect(result.flakyTests[0].failCount).toBe(3);
    expect(result.alwaysPassing).toHaveLength(0);
    expect(result.alwaysFailing).toHaveLength(0);
  });

  it('classifies always-passing and always-failing tests', async () => {
    mockExecFileSync.mockReturnValue(
      '  ✓ always passes\n  ✕ always fails\n  ✓ always passes too\n',
    );

    const api = makeApi();
    flakePlugin.setup(api as never);
    const detect = getTool(api, 'flake_detect');
    const result = (await detect.execute({ testPattern: 'src/bar.test.ts', runs: 3 })) as {
      ok: boolean;
      flakyTests: Array<{ test: string }>;
      alwaysPassing: Array<{ test: string }>;
      alwaysFailing: Array<{ test: string }>;
    };

    expect(result.ok).toBe(true);
    expect(result.flakyTests).toHaveLength(0);
    expect(result.alwaysPassing.map((t) => t.test).sort()).toEqual([
      'always passes',
      'always passes too',
    ]);
    expect(result.alwaysFailing.map((t) => t.test)).toEqual(['always fails']);
  });

  it('uses custom command when provided', async () => {
    mockExecFileSync.mockReturnValue('  ✓ custom cmd test\n');

    const api = makeApi();
    flakePlugin.setup(api as never);
    const detect = getTool(api, 'flake_detect');
    const result = (await detect.execute({
      testPattern: 'pattern',
      runs: 2,
      command: 'pnpm vitest run --reporter=verbose',
    })) as { ok: boolean; command: string };

    expect(result.ok).toBe(true);
    expect(result.command).toBe('pnpm vitest run --reporter=verbose pattern');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringMatching(/[\\/]vitest[\\/]vitest\.mjs$/),
        'run',
        '--reporter=verbose',
        'pattern',
      ],
      expect.objectContaining({ shell: false }),
    );
  });

  it('falls back to configured default command', async () => {
    mockExecFileSync.mockReturnValue('  ✓ default test\n');

    const api = makeApi({
      extensions: { 'test-flake-detector': { defaultCommand: 'npx vitest run' } },
    });
    flakePlugin.setup(api as never);
    const detect = getTool(api, 'flake_detect');
    const result = (await detect.execute({ testPattern: 'src/baz.test.ts' })) as {
      ok: boolean;
      command: string;
    };

    expect(result.ok).toBe(true);
    expect(result.command).toBe('npx vitest run src/baz.test.ts');
  });

  it('clamps runs to configured maxRuns', async () => {
    mockExecFileSync.mockReturnValue('  ✓ clamped\n');

    const api = makeApi({ extensions: { 'test-flake-detector': { maxRuns: 3 } } });
    flakePlugin.setup(api as never);
    const detect = getTool(api, 'flake_detect');
    const result = (await detect.execute({ testPattern: 'x', runs: 100 })) as {
      ok: boolean;
      runsRequested: number;
    };

    expect(result.ok).toBe(true);
    expect(result.runsRequested).toBe(3);
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  });

  it('treats non-zero exits as failed runs and still parses stdout', async () => {
    mockExecFileSync.mockImplementation(() => {
      const err = Object.assign(new Error('exit 1'), {
        stdout: '  ✕ error run test\n',
        stderr: '',
      });
      throw err;
    });

    const api = makeApi();
    flakePlugin.setup(api as never);
    const detect = getTool(api, 'flake_detect');
    const result = (await detect.execute({ testPattern: 'y', runs: 2 })) as {
      ok: boolean;
      alwaysFailing: Array<{ test: string }>;
      runErrors?: string[];
    };

    expect(result.ok).toBe(true);
    expect(result.alwaysFailing.map((t) => t.test)).toEqual(['error run test']);
    expect(result.runErrors).toBeDefined();
    expect(result.runErrors!.length).toBe(2);
  });

  it('rejects test paths embedded in the command string', async () => {
    const api = makeApi();
    flakePlugin.setup(api as never);
    const detect = getTool(api, 'flake_detect');
    const result = (await detect.execute({
      command: 'npx vitest run src/foo.test.ts',
    })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unsupported test command');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it.each([
    { command: 'node -e process.exit()', testPattern: 'src/foo.test.ts' },
    { command: 'npx vitest run; calc.exe', testPattern: 'src/foo.test.ts' },
    { command: 'npx malicious-package', testPattern: 'src/foo.test.ts' },
    { command: 'npx jest', testPattern: 'src/foo.test.ts' },
    { command: 'npx vitest --config=../../evil.ts', testPattern: 'src/foo.test.ts' },
    { command: 'npx vitest run', testPattern: '--config=evil.ts' },
    { command: 'npx vitest run', testPattern: '../outside.test.ts' },
  ])('rejects unsafe command boundary %#', async ({ command, testPattern }) => {
    const api = makeApi();
    flakePlugin.setup(api as never);
    const detect = getTool(api, 'flake_detect');
    const result = (await detect.execute({ command, testPattern })) as {
      ok: boolean;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unsupported test command|unsafe testPattern/);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('enabled:false disables flake_detect', async () => {
    const api = makeApi({ extensions: { 'test-flake-detector': { enabled: false } } });
    flakePlugin.setup(api as never);
    const detect = getTool(api, 'flake_detect');
    const result = (await detect.execute({})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('flake_status reports config and counters', async () => {
    mockExecFileSync.mockReturnValue('  ✓ status test\n');

    const api = makeApi({ extensions: { 'test-flake-detector': { maxRuns: 7 } } });
    flakePlugin.setup(api as never);
    const detect = getTool(api, 'flake_detect');
    const status = getTool(api, 'flake_status');

    await detect.execute({ testPattern: 'z', runs: 2 });
    const report = (await status.execute({})) as {
      ok: boolean;
      enabled: boolean;
      maxRuns: number;
      counters: { invocations: number; runs: number; errors: number };
      lastResult: { runsCompleted: number } | null;
    };

    expect(report.ok).toBe(true);
    expect(report.enabled).toBe(true);
    expect(report.maxRuns).toBe(7);
    expect(report.counters.invocations).toBe(1);
    expect(report.counters.runs).toBe(2);
    expect(report.counters.errors).toBe(0);
    expect(report.lastResult).not.toBeNull();
    expect(report.lastResult!.runsCompleted).toBe(2);
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    flakePlugin.setup(api as never);
    flakePlugin.teardown!(api as never);
    const health = (await flakePlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters.invocations).toBe(0);
    expect(health.counters.runs).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'test-flake-detector: teardown complete',
      expect.any(Object),
    );
  });

  it('health reports last result summary', async () => {
    let run = 0;
    mockExecFileSync.mockImplementation(() => {
      run += 1;
      return run % 2 === 0 ? '  ✓ health test\n' : '  ✕ health test\n';
    });

    const api = makeApi();
    flakePlugin.setup(api as never);
    const detect = getTool(api, 'flake_detect');
    await detect.execute({ testPattern: 'h', runs: 2 });

    const health = (await flakePlugin.health!()) as { message: string };
    expect(health.message).toContain('1 flaky test');
  });
});

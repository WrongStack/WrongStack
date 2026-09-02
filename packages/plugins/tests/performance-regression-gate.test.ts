import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
};

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}));

const perfPlugin = (await import('../src/performance-regression-gate')).default;

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

function getTool(api: MockApi, name: string): (input: unknown) => Promise<unknown> {
  const call = api.tools.register.mock.calls.find((c) => (c[0] as { name: string }).name === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return (call[0] as { execute: (input: unknown) => Promise<unknown> }).execute;
}

function makeBenchResults(benchmarks: Array<{ name: string; mean: number; hz?: number }>): object {
  return {
    files: [
      {
        filepath: 'packages/core/tests/perf/example.bench.ts',
        groups: [
          {
            fullName: 'example.bench.ts > suite',
            benchmarks: benchmarks.map((b, i) => ({
              id: `id-${i}`,
              name: b.name,
              mean: b.mean,
              hz: b.hz ?? 1000 / b.mean,
            })),
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existsSync.mockReset();
  mocks.readFileSync.mockReset();
});

afterEach(async () => {
  const api = makeApi();
  await perfPlugin.teardown?.(api as never);
});

describe('performance-regression-gate plugin', () => {
  it('registers perf_regression_status tool', async () => {
    const api = makeApi();
    perfPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const tool = api.tools.register.mock.calls[0]![0] as { name: string };
    expect(tool.name).toBe('perf_regression_status');
  });

  it('reports no regressions when new mean is within threshold', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify(
        makeBenchResults([
          { name: 'task (old)', mean: 10 },
          { name: 'task (new)', mean: 10.5 },
        ]),
      ),
    );
    const api = makeApi();
    perfPlugin.setup(api as never);
    const status = getTool(api, 'perf_regression_status');
    const result = (await status({})) as {
      ok: boolean;
      regression: boolean;
      comparisons: number;
      regressions: unknown[];
    };
    expect(result.ok).toBe(true);
    expect(result.regression).toBe(false);
    expect(result.comparisons).toBe(1);
    expect(result.regressions).toHaveLength(0);
  });

  it('reports a regression when new mean exceeds threshold', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify(
        makeBenchResults([
          { name: 'task (old)', mean: 10 },
          { name: 'task (new)', mean: 12 },
        ]),
      ),
    );
    const api = makeApi();
    perfPlugin.setup(api as never);
    const status = getTool(api, 'perf_regression_status');
    const result = (await status({})) as {
      ok: boolean;
      regression: boolean;
      regressions: Array<{ benchmark: string; increasePercent: number }>;
    };
    expect(result.ok).toBe(true);
    expect(result.regression).toBe(true);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]!.benchmark).toContain('task (new)');
    expect(result.regressions[0]!.increasePercent).toBe(20);
  });

  it('respects config thresholdPercent', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify(
        makeBenchResults([
          { name: 'task (old)', mean: 10 },
          { name: 'task (new)', mean: 12 },
        ]),
      ),
    );
    const api = makeApi({
      extensions: { 'performance-regression-gate': { thresholdPercent: 25 } },
    });
    perfPlugin.setup(api as never);
    const status = getTool(api, 'perf_regression_status');
    const result = (await status({})) as {
      ok: boolean;
      regression: boolean;
      regressions: unknown[];
    };
    expect(result.regression).toBe(false);
    expect(result.regressions).toHaveLength(0);
  });

  it('supports per-call thresholdPercent override', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify(
        makeBenchResults([
          { name: 'task (old)', mean: 10 },
          { name: 'task (new)', mean: 12 },
        ]),
      ),
    );
    const api = makeApi();
    perfPlugin.setup(api as never);
    const status = getTool(api, 'perf_regression_status');
    const result = (await status({ thresholdPercent: 25 })) as {
      ok: boolean;
      regression: boolean;
      regressions: unknown[];
    };
    expect(result.regression).toBe(false);
  });

  it('compares across baselinePath when supplied', async () => {
    mocks.existsSync.mockImplementation((p: string) => {
      return p.includes('bench-results.json') || p.includes('baseline.json');
    });
    mocks.readFileSync.mockImplementation((p: string) => {
      if (p.includes('baseline.json')) {
        return JSON.stringify(makeBenchResults([{ name: 'task', mean: 10 }]));
      }
      return JSON.stringify(makeBenchResults([{ name: 'task', mean: 13 }]));
    });
    const api = makeApi();
    perfPlugin.setup(api as never);
    const status = getTool(api, 'perf_regression_status');
    const result = (await status({
      resultsPath: 'bench-results.json',
      baselinePath: 'baseline.json',
    })) as {
      ok: boolean;
      regression: boolean;
      comparisons: number;
      regressions: Array<{ benchmark: string; increasePercent: number }>;
    };
    expect(result.ok).toBe(true);
    expect(result.comparisons).toBe(1);
    expect(result.regression).toBe(true);
    expect(result.regressions[0]!.increasePercent).toBe(30);
  });

  it('reports missing results file gracefully', async () => {
    mocks.existsSync.mockReturnValue(false);
    const api = makeApi();
    perfPlugin.setup(api as never);
    const status = getTool(api, 'perf_regression_status');
    const result = (await status({})) as {
      ok: boolean;
      hasResults: boolean;
      comparisons: number;
      regressions: unknown[];
    };
    expect(result.ok).toBe(true);
    expect(result.hasResults).toBe(false);
    expect(result.comparisons).toBe(0);
    expect(result.regressions).toHaveLength(0);
  });

  it('returns disabled error when enabled:false', async () => {
    const api = makeApi({ extensions: { 'performance-regression-gate': { enabled: false } } });
    perfPlugin.setup(api as never);
    const status = getTool(api, 'perf_regression_status');
    const result = (await status({})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    perfPlugin.setup(api as never);
    perfPlugin.teardown!(api as never);
    const health = (await perfPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['comparisons']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'performance-regression-gate: teardown complete',
      expect.any(Object),
    );
  });
});

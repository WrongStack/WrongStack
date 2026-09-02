/**
 * Supplementary tests for test-coverage-gate — targeting uncovered branches.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const coverageGatePlugin = (await import('../src/test-coverage-gate')).default;

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: { counter: ReturnType<typeof vi.fn> };
  registerHook: ReturnType<typeof vi.fn>;
}

function makeApi(extensions: Record<string, unknown> = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

beforeEach(() => vi.clearAllMocks());

const projectRoot = resolve(process.cwd());

describe('test-coverage-gate extra coverage', () => {
  it('health() returns correct message without lastResult', async () => {
    const api = makeApi();
    coverageGatePlugin.setup(api as never);
    const h = (await coverageGatePlugin.health!()) as {
      ok: boolean;
      message: string;
      counters: Record<string, number>;
      lastResult: unknown;
    };
    expect(h.ok).toBe(true);
    expect(h.message).toContain('0 invocation(s)');
    expect(h.lastResult).toBeNull();
  });

  it('health() returns message with lastResult after a hook run', async () => {
    const covPath = join(projectRoot, '.coverage-cov-test-1.json');
    writeFileSync(
      covPath,
      JSON.stringify({
        total: {
          lines: { pct: 85 },
          statements: { pct: 80 },
          functions: { pct: 90 },
          branches: { pct: 75 },
        },
      }),
    );

    const api = makeApi({
      'test-coverage-gate': { coveragePath: covPath, threshold: 0, mode: 'warn' },
    });
    coverageGatePlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => unknown;
    await hook({
      toolName: 'write',
      toolInput: { path: join(projectRoot, 'src/coverage-test-dummy.ts') },
      toolResult: { content: '', isError: false },
    });

    const h = (await coverageGatePlugin.health!()) as { message: string };
    expect(h.message).toContain('PASSED');
  });

  it('hook returns undefined when toolResult has error', async () => {
    const api = makeApi();
    coverageGatePlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => unknown;
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts' },
      toolResult: { content: '', isError: true },
    });
    expect(result).toBeUndefined();
  });

  it('hook returns undefined when path is missing', async () => {
    const api = makeApi();
    coverageGatePlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => unknown;
    const result = await hook({
      toolName: 'write',
      toolInput: { content: 'hello' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('hook returns undefined when file extension is not in runOnChange', async () => {
    const api = makeApi({ 'test-coverage-gate': { runOnChange: ['.ts', '.tsx'] } });
    coverageGatePlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => unknown;
    const result = await hook({
      toolName: 'write',
      toolInput: { path: join(projectRoot, 'src/foo.js') },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('hook increments errorCount when coverage file not found', async () => {
    const api = makeApi({
      'test-coverage-gate': { coveragePath: join(projectRoot, '.nonexistent-coverage.json') },
    });
    coverageGatePlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => unknown;
    await hook({
      toolName: 'write',
      toolInput: { path: join(projectRoot, 'src/foo.ts') },
      toolResult: { content: '', isError: false },
    });
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'coverage_gate_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    expect((status as Record<string, unknown>).counters).toMatchObject({ errors: 1 });
  });

  it('hook increments errorCount when coverage summary has no total', async () => {
    const covPath = join(projectRoot, '.coverage-no-total.json');
    writeFileSync(covPath, JSON.stringify({}));

    const api = makeApi({ 'test-coverage-gate': { coveragePath: covPath } });
    coverageGatePlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => unknown;
    await hook({
      toolName: 'write',
      toolInput: { path: join(projectRoot, 'src/foo.ts') },
      toolResult: { content: '', isError: false },
    });
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'coverage_gate_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    expect((status as Record<string, unknown>).counters).toMatchObject({ errors: 1 });
  });

  it('hook returns pass when coverage is above threshold', async () => {
    const covPath = join(projectRoot, '.coverage-pass-test.json');
    writeFileSync(
      covPath,
      JSON.stringify({
        total: {
          lines: { pct: 90 },
          statements: { pct: 85 },
          functions: { pct: 88 },
          branches: { pct: 82 },
        },
      }),
    );

    const api = makeApi({ 'test-coverage-gate': { coveragePath: covPath, threshold: 0 } });
    coverageGatePlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => unknown;
    await hook({
      toolName: 'write',
      toolInput: { path: join(projectRoot, 'src/foo.ts') },
      toolResult: { content: '', isError: false },
    });
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'coverage_gate_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    expect((status as Record<string, unknown>).counters).toMatchObject({ passed: 1, runs: 1 });
  });

  it('block mode returns decision block when coverage below threshold', async () => {
    const covPath = join(projectRoot, '.coverage-block-test.json');
    writeFileSync(
      covPath,
      JSON.stringify({
        total: {
          lines: { pct: 30 },
          statements: { pct: 25 },
          functions: { pct: 35 },
          branches: { pct: 20 },
        },
      }),
    );

    const api = makeApi({
      'test-coverage-gate': { coveragePath: covPath, threshold: 80, mode: 'block' },
    });
    coverageGatePlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => unknown;
    const result = (await hook({
      toolName: 'write',
      toolInput: { path: join(projectRoot, 'src/foo.ts') },
      toolResult: { content: '', isError: false },
    })) as { decision?: string; reason?: string } | void;

    expect(result).toBeDefined();
    expect((result as { decision: string }).decision).toBe('block');
  });

  it('readConfig handles null/undefined config', async () => {
    const api = makeApi({ 'test-coverage-gate': null });
    coverageGatePlugin.setup(api as never);
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'coverage_gate_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    expect((status as Record<string, unknown>).threshold).toBe(80);
  });

  it('readConfig validates threshold bounds', async () => {
    const api = makeApi({ 'test-coverage-gate': { threshold: 150 } });
    coverageGatePlugin.setup(api as never);
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'coverage_gate_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    expect((status as Record<string, unknown>).threshold).toBe(80);
  });

  it('readConfig validates deltaThreshold', async () => {
    const api = makeApi({ 'test-coverage-gate': { deltaThreshold: -1 } });
    coverageGatePlugin.setup(api as never);
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'coverage_gate_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    expect((status as Record<string, unknown>).deltaThreshold).toBe(1);
  });

  it('readConfig handles non-object config gracefully', async () => {
    const api = makeApi({ 'test-coverage-gate': 42 });
    coverageGatePlugin.setup(api as never);
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'coverage_gate_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    expect((status as Record<string, unknown>).threshold).toBe(80);
  });
});

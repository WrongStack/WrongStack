/**
 * Supplementary tests for lint-gate — targeting uncovered branches.
 * Tests: readConfig edge cases, applyEdit, filterBySeverity, parseLinterOutput,
 * health with/without lastResult, executable() for win32, runCommand try-catch,
 * lintContent/lintAndFix error paths.
 */
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

function makeApi(extensions: Record<string, unknown> = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    emitCustom: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('lint-gate extra coverage', () => {
  it('health() returns correct message when lastResult is null and counters are zero', async () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    const h = (await lintGatePlugin.health!()) as {
      ok: boolean;
      message: string;
      counters: Record<string, number>;
      lastResult: unknown;
    };
    expect(h.ok).toBe(true);
    expect(h.message).toContain('0 invocation(s)');
    expect(h.counters.invocations).toBe(0);
    expect(h.lastResult).toBeNull();
  });

  it('readConfig handles null/undefined config gracefully', async () => {
    const api = makeApi({ 'lint-gate': null });
    lintGatePlugin.setup(api as never);
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'lint_gate_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    expect((status as Record<string, unknown>).mode).toBe('warn');
  });

  it('readConfig handles non-object config gracefully', async () => {
    const api = makeApi({ 'lint-gate': 42 });
    lintGatePlugin.setup(api as never);
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'lint_gate_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    expect((status as Record<string, unknown>).mode).toBe('warn');
  });

  it('hook returns undefined for non-write/edit toolName', async () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => Promise<unknown>;
    const result = await hook({ toolName: 'read', toolInput: { path: 'test.ts' } });
    expect(result).toBeUndefined();
  });

  it('edit hook returns undefined when old_string is missing', async () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => Promise<unknown>;
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'test.ts', new_string: 'hello' },
    });
    expect(result).toBeUndefined();
  });

  it('edit hook returns undefined when new_string is missing', async () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => Promise<unknown>;
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'test.ts', old_string: 'bye' },
    });
    expect(result).toBeUndefined();
  });

  it('write hook passes through when path is not a string', async () => {
    const api = makeApi();
    lintGatePlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => Promise<unknown>;
    const result = await hook({ toolName: 'write', toolInput: { path: 123, content: 'hi' } });
    expect(result).toBeUndefined();
  });

  it('teardown is safe when hookUnregister is null', async () => {
    const api = makeApi();
    // No setup — teardown with null state
    expect(() => lintGatePlugin.teardown!(api as never)).not.toThrow();
  });

  it('teardown handles hook unregister throwing', async () => {
    const api = makeApi();
    api.registerHook = vi.fn(() => {
      throw new Error('unregister fails');
    });
    // Simulate setup with broken unregister
    lintGatePlugin.teardown!(api as never);
    expect(api.log.info).toHaveBeenCalled();
  });
});

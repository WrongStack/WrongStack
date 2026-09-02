/**
 * Supplementary tests for api-compatibility-gate — targeting uncovered branches.
 * Tests: readConfig, isEntryPoint, withinProject, extractExports, etc.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiCompatPlugin = (await import('../src/api-compatibility-gate')).default;

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

describe('api-compatibility-gate extra coverage', () => {
  it('health() returns default message with zero counters', async () => {
    const api = makeApi();
    apiCompatPlugin.setup(api as never);
    const h = (await apiCompatPlugin.health!()) as {
      ok: boolean;
      message: string;
      counters: Record<string, number>;
    };
    expect(h.ok).toBe(true);
    expect(h.message).toContain('0 invocation(s)');
  });

  it('readConfig uses defaults for null config and enabled is false by default', async () => {
    // Default config has enabled:false
    const api = makeApi({ 'api-compatibility-gate': null });
    apiCompatPlugin.setup(api as never);
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'api_compat_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    const s = status as Record<string, unknown>;
    expect(s.severity).toBe('warn');
    expect(s.enabled).toBe(false); // default is false
  });

  it('readConfig reads block severity', async () => {
    const api = makeApi({ 'api-compatibility-gate': { severity: 'block', enabled: true } });
    apiCompatPlugin.setup(api as never);
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'api_compat_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    expect((status as Record<string, unknown>).severity).toBe('block');
  });

  it('readConfig parses custom entryPointPatterns', async () => {
    const api = makeApi({
      'api-compatibility-gate': { entryPointPatterns: ['**/index.ts'], enabled: true },
    });
    apiCompatPlugin.setup(api as never);
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'api_compat_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    expect((status as Record<string, unknown>).entryPointPatterns).toEqual(['**/index.ts']);
  });

  it('hook returns undefined when disabled', async () => {
    const api = makeApi({ 'api-compatibility-gate': { enabled: false } });
    apiCompatPlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => unknown;
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/index.ts' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('hook returns undefined when toolResult has error', async () => {
    const api = makeApi({ 'api-compatibility-gate': { enabled: true } });
    apiCompatPlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => unknown;
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/index.ts' },
      toolResult: { content: '', isError: true },
    });
    expect(result).toBeUndefined();
  });

  it('hook returns undefined when path is missing', async () => {
    const api = makeApi({ 'api-compatibility-gate': { enabled: true } });
    apiCompatPlugin.setup(api as never);
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

  it('hook increments skippedCount when trackGitHistory is false', async () => {
    const api = makeApi({
      'api-compatibility-gate': {
        enabled: true,
        trackGitHistory: false,
        entryPointPatterns: ['**/*.ts'],
      },
    });
    apiCompatPlugin.setup(api as never);
    const hook = (api.registerHook.mock.calls[0] as unknown[])[2] as (
      input: Record<string, unknown>,
    ) => unknown;
    await hook({
      toolName: 'write',
      toolInput: { path: 'src/index.ts' },
      toolResult: { content: '', isError: false },
    });
    const status = await (
      api.tools.register.mock.calls.find(
        (c: unknown[]) => (c[0] as { name: string }).name === 'api_compat_status',
      )![0] as { execute: () => Promise<unknown> }
    ).execute({});
    expect((status as Record<string, unknown>).counters).toMatchObject({ skipped: 1 });
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    apiCompatPlugin.setup(api as never);
    apiCompatPlugin.teardown!(api as never);
    const h = (await apiCompatPlugin.health!()) as { counters: Record<string, number> };
    expect(h.counters.invocations).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'api-compatibility-gate: teardown complete',
      expect.any(Object),
    );
  });

  it('teardown is safe before setup', async () => {
    const api = makeApi();
    expect(() => apiCompatPlugin.teardown!(api as never)).not.toThrow();
  });
});

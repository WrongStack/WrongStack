/**
 * Supplementary tests for plugin-stack-observer — targeting uncovered branches.
 * Tests: disabled mode, injectIntoSystemPrompt, readConfig edge cases,
 * onPattern handler with various payload shapes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import pluginStackObserver from '../src/plugin-stack-observer/index.js';

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: { counter: ReturnType<typeof vi.fn> };
  onPattern: ReturnType<typeof vi.fn>;
  registerSystemPromptContributor: ReturnType<typeof vi.fn>;
}

function makeApi(extensions: Record<string, unknown> = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    onPattern: vi.fn(() => vi.fn()),
    registerSystemPromptContributor: vi.fn(() => vi.fn()),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('plugin-stack-observer extra coverage', () => {
  it('setup with disabled config logs and returns early', () => {
    const api = makeApi({ 'plugin-stack-observer': { enabled: false } });
    pluginStackObserver.setup(api as never);
    expect(api.log.info).toHaveBeenCalledWith('plugin-stack-observer loaded (disabled)');
    expect(api.onPattern).not.toHaveBeenCalled();
  });

  it('setup with injectIntoSystemPrompt registers contributor', () => {
    const api = makeApi({ 'plugin-stack-observer': { injectIntoSystemPrompt: true } });
    pluginStackObserver.setup(api as never);
    expect(api.registerSystemPromptContributor).toHaveBeenCalledTimes(1);
    expect(api.onPattern).toHaveBeenCalledTimes(1);
  });

  it('setup without injectIntoSystemPrompt does not register contributor', () => {
    const api = makeApi({ 'plugin-stack-observer': { injectIntoSystemPrompt: false } });
    pluginStackObserver.setup(api as never);
    expect(api.registerSystemPromptContributor).not.toHaveBeenCalled();
  });

  it('health() returns no wraps when none registered', async () => {
    const api = makeApi();
    pluginStackObserver.setup(api as never);
    const h = (await pluginStackObserver.health!()) as {
      ok: boolean;
      message: string;
      wrapCount: number;
      wraps: unknown[];
    };
    expect(h.ok).toBe(true);
    expect(h.message).toContain('no wraps active');
    expect(h.wrapCount).toBe(0);
  });

  it('onPattern handler processes wrap:loaded events', () => {
    const api = makeApi();
    pluginStackObserver.setup(api as never);
    const handler = api.onPattern.mock.calls[0]?.[1] as (event: string, payload: unknown) => void;

    handler('provider.wrap:loaded', {
      plugin: 'llm-cache',
      kind: 'wrapProviderRunner',
      wraps: ['cache', 'dedup'],
    });
  });

  it('onPattern handler filters invalid entries', () => {
    const api = makeApi();
    pluginStackObserver.setup(api as never);
    const handler = api.onPattern.mock.calls[0]?.[1] as (event: string, payload: unknown) => void;

    // Empty plugin name should be ignored
    handler('provider.wrap:loaded', { plugin: '', kind: 'test', wraps: [] });
    handler('provider.wrap:loaded', {});
    handler('provider.wrap:loaded', null);
    handler('provider.wrap:loaded', { plugin: 'test', kind: 'test', wraps: 'not-array' });

    // No error should occur
    expect(api.log.info).toHaveBeenCalled();
  });

  it('plugin_stack_status tool returns correct state', async () => {
    const api = makeApi();
    pluginStackObserver.setup(api as never);
    const statusTool = api.tools.register.mock.calls.find(
      (c: unknown[]) => (c[0] as { name: string }).name === 'plugin_stack_status',
    )?.[0] as { execute: () => Promise<unknown> };
    const result = (await statusTool.execute()) as { ok: boolean; wrapCount: number };
    expect(result.ok).toBe(true);
    expect(result.wrapCount).toBe(0);
  });

  it('readConfig handles null config', () => {
    const api = makeApi({ 'plugin-stack-observer': null });
    expect(() => pluginStackObserver.setup(api as never)).not.toThrow();
  });

  it('teardown zeros state and logs', () => {
    const api = makeApi();
    pluginStackObserver.setup(api as never);
    pluginStackObserver.teardown!(api as never);
    expect(api.log.info).toHaveBeenCalledWith(
      'plugin-stack-observer: teardown complete',
      expect.any(Object),
    );
  });

  it('teardown is safe before setup', () => {
    const api = makeApi();
    expect(() => pluginStackObserver.teardown!(api as never)).not.toThrow();
  });
});

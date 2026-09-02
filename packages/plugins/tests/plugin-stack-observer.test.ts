import { describe, expect, it, vi } from 'vitest';
import pluginStackObserver from '../src/plugin-stack-observer';

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}) {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    onPattern: vi.fn(() => vi.fn()),
    registerSystemPromptContributor: vi.fn(),
  };
}

function getStatusTool(api: ReturnType<typeof makeApi>) {
  const call = api.tools.register.mock.calls.find(
    ([tool]: unknown[]) => (tool as { name: string }).name === 'plugin_stack_status',
  );
  if (!call) throw new Error('plugin_stack_status not registered');
  return call[0] as { execute: () => Promise<unknown> };
}

describe('plugin-stack-observer', () => {
  it('registers status tool and provider wrap listener when enabled', () => {
    const api = makeApi();

    pluginStackObserver.setup(api as never);

    expect(api.tools.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plugin_stack_status' }),
    );
    expect(api.onPattern).toHaveBeenCalledWith('provider.wrap:loaded', expect.any(Function));
  });

  it('records provider wrap announcements in status output', async () => {
    const api = makeApi();
    pluginStackObserver.setup(api as never);
    const listener = api.onPattern.mock.calls[0]?.[1] as (
      eventName: string,
      payload: unknown,
    ) => void;

    listener('provider.wrap:loaded', {
      plugin: 'llm-cache',
      kind: 'provider-runner',
      wraps: ['request'],
    });

    const status = (await getStatusTool(api).execute()) as {
      wrapCount: number;
      wraps: Array<{ plugin: string }>;
    };
    expect(status.wrapCount).toBe(1);
    expect(status.wraps[0]?.plugin).toBe('llm-cache');
  });

  it('teardown unregisters the provider wrap listener and clears state', async () => {
    const unregister = vi.fn();
    const api = makeApi();
    api.onPattern.mockReturnValueOnce(unregister);
    pluginStackObserver.setup(api as never);
    const listener = api.onPattern.mock.calls[0]?.[1] as (
      eventName: string,
      payload: unknown,
    ) => void;
    listener('provider.wrap:loaded', {
      plugin: 'model-router',
      kind: 'provider-runner',
      wraps: ['request'],
    });

    pluginStackObserver.teardown?.(api as never);

    expect(unregister).toHaveBeenCalledTimes(1);
    const health = await pluginStackObserver.health?.();
    expect(health?.wrapCount).toBe(0);
  });

  it('setup unregisters a previous listener before reinitializing', () => {
    const unregister = vi.fn();
    const api = makeApi();
    api.onPattern.mockReturnValue(unregister);

    pluginStackObserver.setup(api as never);
    pluginStackObserver.setup(api as never);

    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('disabled setup clears any previous listener and does not subscribe again', () => {
    const unregister = vi.fn();
    const api = makeApi();
    api.onPattern.mockReturnValue(unregister);
    pluginStackObserver.setup(api as never);

    const disabledApi = makeApi({ extensions: { 'plugin-stack-observer': { enabled: false } } });
    pluginStackObserver.setup(disabledApi as never);

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(disabledApi.onPattern).not.toHaveBeenCalled();
  });
});

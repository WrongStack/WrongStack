import type { Plugin, PluginAPI } from '@wrongstack/contracts/types/plugin';
import { describe, expect, it, vi } from 'vitest';
import { loadPlugins } from '../../src/plugin/loader.js';

const log = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

function plugin(overrides: Partial<Plugin> & { name: string }): Plugin {
  return {
    apiVersion: '^0.1',
    setup: () => undefined,
    ...overrides,
  };
}

function apiWithCleanup(cleanup: () => void): PluginAPI {
  return { drainCleanup: cleanup } as never;
}

describe('PluginHostHandle', () => {
  it('enforces a real setup deadline and rolls partial setup back', async () => {
    const cleanup = vi.fn();
    const teardown = vi.fn(async () => undefined);
    let setupSignal: AbortSignal | undefined;
    const hung = plugin({
      name: 'hung-setup',
      setup: (_api, context) => {
        setupSignal = context?.signal;
        return new Promise<void>(() => undefined);
      },
      teardown,
    });

    const startedAt = Date.now();
    const host = await loadPlugins([hung], {
      apiFactory: () => apiWithCleanup(cleanup),
      log,
      setupTimeoutMs: 20,
      teardownTimeoutMs: 20,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(host.loaded).toEqual([]);
    expect(host.failed).toHaveLength(1);
    expect(host.failed[0]?.err).toMatchObject({ name: 'PluginLifecycleTimeoutError' });
    expect(setupSignal?.aborted).toBe(true);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('disposes in reverse order and drains cleanup exactly once', async () => {
    const order: string[] = [];
    const cleanupA = vi.fn(() => order.push('cleanup-a'));
    const cleanupB = vi.fn(() => order.push('cleanup-b'));
    const host = await loadPlugins(
      [
        plugin({ name: 'a', teardown: () => void order.push('teardown-a') }),
        plugin({
          name: 'b',
          dependsOn: ['a'],
          teardown: () => void order.push('teardown-b'),
        }),
      ],
      {
        apiFactory: (candidate) =>
          candidate.name === 'a' ? apiWithCleanup(cleanupA) : apiWithCleanup(cleanupB),
        log,
      },
    );

    const firstDispose = host.dispose();
    const concurrentDispose = host.dispose();
    expect(concurrentDispose).toBe(firstDispose);
    await firstDispose;
    await host.dispose();

    expect(host.disposed).toBe(true);
    expect(order).toEqual(['teardown-b', 'cleanup-b', 'teardown-a', 'cleanup-a']);
    expect(cleanupA).toHaveBeenCalledTimes(1);
    expect(cleanupB).toHaveBeenCalledTimes(1);
  });

  it('bounds hung teardown and continues disposing sibling plugins', async () => {
    const calls: string[] = [];
    const host = await loadPlugins(
      [
        plugin({ name: 'base', teardown: () => void calls.push('base') }),
        plugin({
          name: 'hung',
          dependsOn: ['base'],
          teardown: () => new Promise<void>(() => undefined),
        }),
      ],
      {
        apiFactory: () => apiWithCleanup(vi.fn()),
        log,
        teardownTimeoutMs: 20,
      },
    );

    const startedAt = Date.now();
    await host.dispose();

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(calls).toEqual(['base']);
  });

  it('keeps registrations isolated when two hosts load the same plugin object', async () => {
    const tornDownApis: PluginAPI[] = [];
    const sharedPlugin = plugin({
      name: 'shared',
      teardown: (api) => void tornDownApis.push(api),
    });
    const firstApi = apiWithCleanup(vi.fn());
    const secondApi = apiWithCleanup(vi.fn());

    const firstHost = await loadPlugins([sharedPlugin], { apiFactory: () => firstApi, log });
    const secondHost = await loadPlugins([sharedPlugin], { apiFactory: () => secondApi, log });

    await firstHost.dispose();
    expect(tornDownApis).toEqual([firstApi]);
    expect(secondHost.disposed).toBe(false);

    await secondHost.dispose();
    expect(tornDownApis).toEqual([firstApi, secondApi]);
  });
});

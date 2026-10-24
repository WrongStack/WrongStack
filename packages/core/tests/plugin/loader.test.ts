import type { Plugin, PluginAPI } from '@wrongstack/contracts/types/plugin';
import { describe, expect, it, vi } from 'vitest';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { KERNEL_API_VERSION, loadPlugins } from '../../src/plugin/loader.js';

const fakeApi = {} as PluginAPI;
const log = new DefaultLogger({ level: 'error' });

function p(overrides: Partial<Plugin> = {}): Plugin {
  return {
    name: overrides.name ?? 'p',
    apiVersion: overrides.apiVersion ?? '^0.1',
    setup: overrides.setup ?? (() => undefined),
    ...overrides,
  };
}

describe('loadPlugins', () => {
  it('loads compatible plugins in order', async () => {
    const order: string[] = [];
    const plugins = [
      p({ name: 'a', setup: () => void order.push('a') }),
      p({ name: 'b', setup: () => void order.push('b'), dependsOn: ['a'] }),
    ];
    const { loaded } = await loadPlugins(plugins, {
      apiFactory: () => fakeApi,
      log,
    });
    expect(loaded.map((x) => x.name)).toEqual(['a', 'b']);
    expect(order).toEqual(['a', 'b']);
  });

  it('skips incompatible apiVersion', async () => {
    const { loaded, failed } = await loadPlugins([p({ name: 'old', apiVersion: '^0.5' })], {
      apiFactory: () => fakeApi,
      log,
      kernelApiVersion: KERNEL_API_VERSION,
    });
    expect(loaded).toEqual([]);
    expect(failed).toHaveLength(1);
  });

  it('throws on dependency cycle', async () => {
    const a = p({ name: 'a', dependsOn: ['b'] });
    const b = p({ name: 'b', dependsOn: ['a'] });
    await expect(loadPlugins([a, b], { apiFactory: () => fakeApi, log })).rejects.toThrow(/cycle/);
  });

  it('isolates plugin setup failures', async () => {
    const good = p({ name: 'good', setup: vi.fn() });
    const bad = p({
      name: 'bad',
      setup: () => {
        throw new Error('boom');
      },
    });
    const { loaded, failed } = await loadPlugins([bad, good], {
      apiFactory: () => fakeApi,
      log,
    });
    expect(loaded.map((p) => p.name)).toEqual(['good']);
    expect(failed.map((f) => f.plugin.name)).toEqual(['bad']);
  });

  it('detects conflict', async () => {
    const a = p({ name: 'a', conflictsWith: ['b'] });
    const b = p({ name: 'b' });
    await expect(loadPlugins([a, b], { apiFactory: () => fakeApi, log })).rejects.toThrow(
      /conflict/,
    );
  });
});

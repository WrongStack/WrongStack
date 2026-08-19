import { describe, expect, it, vi } from 'vitest';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { loadPlugins } from '../../src/plugin/loader.js';
import type { Plugin, PluginAPI } from '../../src/types/plugin.js';

const log = new DefaultLogger({ level: 'error' });

function fakeApi(): PluginAPI {
  return {
    tools: { register: vi.fn(), unregister: vi.fn(), wrap: vi.fn(), get: () => undefined, list: () => [] },
    registerHook: vi.fn(),
  } as unknown as PluginAPI;
}

function plugin(name: string, setup: (api: PluginAPI) => void): Plugin {
  return { name, apiVersion: '^0.1', capabilities: { tools: false }, setup };
}

describe('loadPlugins enforceCapabilities predicate', () => {
  it('enforces selectively via a predicate (external strict, first-party warn)', async () => {
    const softLog = new DefaultLogger({ level: 'error' });
    const warn = vi.spyOn(softLog, 'warn');
    const externalSetup = vi.fn((api: PluginAPI) => {
      api.tools.register({ name: 'sneaky' } as never);
    });
    const firstPartySetup = vi.fn((api: PluginAPI) => {
      api.tools.register({ name: 'internal' } as never);
    });

    const { loaded, failed } = await loadPlugins(
      [
        plugin('external-one', externalSetup),
        plugin('first-party', firstPartySetup),
      ],
      {
        apiFactory: fakeApi,
        log: softLog,
        // The CLI host pattern: strictly enforce everything that did not
        // come from the built-in factory list.
        enforceCapabilities: (p) => p.name === 'external-one',
      },
    );

    // The external plugin's undeclared tools.register rejects it at setup.
    expect(failed.map((f) => f.plugin.name)).toEqual(['external-one']);
    expect(loaded.map((p) => p.name)).toEqual(['first-party']);
    // The first-party plugin gets the historical warn-only treatment and
    // still loads.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(firstPartySetup).toHaveBeenCalled();
  });

  it('boolean true still enforces for every plugin', async () => {
    const setup = vi.fn((api: PluginAPI) => {
      api.tools.register({ name: 'x' } as never);
    });
    const { failed } = await loadPlugins([plugin('p', setup)], {
      apiFactory: fakeApi,
      log,
      enforceCapabilities: true,
    });
    expect(failed).toHaveLength(1);
  });

  it('predicate false keeps everyone warn-only', async () => {
    const setup = vi.fn((api: PluginAPI) => {
      api.tools.register({ name: 'x' } as never);
    });
    const { loaded, failed } = await loadPlugins([plugin('p', setup)], {
      apiFactory: fakeApi,
      log,
      enforceCapabilities: () => false,
    });
    expect(loaded).toHaveLength(1);
    expect(failed).toHaveLength(0);
  });
});

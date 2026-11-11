import type { Dirent } from 'node:fs';
import type { Plugin } from '@wrongstack/contracts/types/plugin';
import { describe, expect, it, vi } from 'vitest';
import {
  Container,
  DefaultPluginAPI,
  EventBus,
  ProviderRegistry,
  SlashCommandRegistry,
  ToolRegistry,
} from '../../src/index.js';
import {
  type DiscoveryIo,
  discoverExternalPlugins,
  resolvePluginTarget,
} from '../../src/plugin/discovery.js';
import { loadPlugins } from '../../src/plugin/loader.js';
import { PluginUiRegistry } from '../../src/plugin/plugin-ui.js';

function memoryIo(files: Record<string, string>, dirs: string[] = []): DiscoveryIo {
  const dirSet = new Set(dirs);
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '');
  return {
    async readdir(root) {
      const r = norm(root);
      if (!dirSet.has(r)) throw new Error('ENOENT');
      const names = new Set<string>();
      for (const key of Object.keys(files)) {
        if (key.startsWith(`${r}/`)) names.add(key.slice(r.length + 1).split('/')[0]!);
      }
      for (const dir of dirSet) {
        if (dir.startsWith(`${r}/`)) names.add(dir.slice(r.length + 1).split('/')[0]!);
      }
      return [...names].map((name) => ({
        name,
        isDirectory: () => dirSet.has(`${r}/${name}`),
        isFile: () => files[`${r}/${name}`] !== undefined,
      })) as unknown as Dirent[];
    },
    async stat(p) {
      const key = norm(p);
      if (files[key] !== undefined) return { isFile: () => true, isDirectory: () => false };
      if (dirSet.has(key)) return { isFile: () => false, isDirectory: () => true };
      throw new Error('ENOENT');
    },
    async readFile(p) {
      const contents = files[norm(p)];
      if (contents === undefined) throw new Error('ENOENT');
      return contents;
    },
  };
}

function makeHarness(uiRegistry = new PluginUiRegistry({ throttleMs: 0 })) {
  const log = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => log),
    setLevel: vi.fn(),
  } as never;
  const toolRegistry = new ToolRegistry();
  const providerRegistry = new ProviderRegistry();
  const slashCommandRegistry = new SlashCommandRegistry();
  const events = new EventBus();
  const container = new Container();
  const pipelines = {} as Parameters<typeof DefaultPluginAPI>[0]['pipelines'];

  const apiFactory = (plugin: Plugin) =>
    new DefaultPluginAPI({
      ownerName: plugin.name,
      capabilities: plugin.capabilities,
      container,
      events,
      pipelines,
      toolRegistry,
      providerRegistry,
      slashCommandRegistry,
      config: { version: 1, provider: 'anthropic', model: 'claude', features: {} } as never,
      log,
      uiRegistry,
    });

  return { log, toolRegistry, slashCommandRegistry, events, uiRegistry, apiFactory };
}

describe('Zero-build TypeScript plugin discovery', () => {
  const TS = 'export default { name: "x", apiVersion: "^0.1", setup() {} };';

  it('discovers .ts and .mts single-file and directory plugins while ignoring .d.ts and test files', async () => {
    const fs = memoryIo(
      {
        '/plugins/single-tool.ts': TS,
        '/plugins/esm-tool.mts': TS,
        '/plugins/ambient.d.ts': 'export interface Foo {}',
        '/plugins/types.d.mts': 'export type Bar = string;',
        '/plugins/single-tool.test.ts': TS,
        '/plugins/single-tool.spec.mts': TS,
        '/plugins/dir-ts/index.ts': TS,
        '/plugins/dir-mts/index.mts': TS,
      },
      ['/plugins', '/plugins/dir-ts', '/plugins/dir-mts'],
    );

    const { candidates, skipped } = await discoverExternalPlugins(['/plugins'], fs);
    expect(skipped).toEqual([]);
    expect(candidates.map((c) => c.name)).toEqual(['dir-mts', 'dir-ts', 'esm-tool', 'single-tool']);

    const resolvedDir = await resolvePluginTarget('/plugins/dir-ts', fs);
    expect(resolvedDir?.replaceAll('\\', '/')).toBe('/plugins/dir-ts/index.ts');
  });
});

describe('PluginHostHandle atomic reload, rollback, api.signal, and Declarative PluginUiRegistry', () => {
  it('atomically hot-swaps tools, aborts old api.signal, and drains old UI chips on reloadPlugin', async () => {
    const uiRegistry = new PluginUiRegistry({ throttleMs: 0 });
    const h = makeHarness(uiRegistry);
    let v1Signal: AbortSignal | undefined;

    const v1: Plugin = {
      name: 'live-ext',
      version: '1.0.0',
      apiVersion: '^0.1',
      capabilities: { tools: true, ui: true },
      setup(api) {
        v1Signal = api.signal;
        api.tools.register({
          name: 'greet',
          description: 'v1 tool',
          inputSchema: { type: 'object', properties: {} },
          permission: 'auto',
          mutating: false,
          execute: async () => 'hello-v1',
        });
        api.ui?.registerStatusChip({ id: 'state', text: 'v1-ready' });
      },
    };

    const host = await loadPlugins([v1], {
      apiFactory: h.apiFactory,
      log: h.log,
      enforceCapabilities: true,
    });

    expect(h.toolRegistry.get('greet')).toBeDefined();
    expect(uiRegistry.listStatusChips().map((c) => c.text)).toEqual(['v1-ready']);
    expect(v1Signal?.aborted).toBe(false);

    const v2: Plugin = {
      name: 'live-ext',
      version: '2.0.0',
      apiVersion: '^0.1',
      capabilities: { tools: true, ui: true },
      setup(api) {
        api.tools.register({
          name: 'greet',
          description: 'v2 tool',
          inputSchema: { type: 'object', properties: {} },
          permission: 'auto',
          mutating: false,
          execute: async () => 'hello-v2',
        });
        api.ui?.registerStatusChip({ id: 'state', text: 'v2-live' });
      },
    };

    const reloadRes = await host.reloadPlugin(v2);
    expect(reloadRes).toEqual({
      status: 'reloaded',
      previousVersion: '1.0.0',
      version: '2.0.0',
    });
    expect(v1Signal?.aborted).toBe(true);
    expect(uiRegistry.listStatusChips().map((c) => c.text)).toEqual(['v2-live']);
    const tool = h.toolRegistry.get('greet');
    const out = await tool!.execute({}, {} as never);
    expect(out).toBe('hello-v2');

    // Unload removes tools and UI chips cleanly.
    const unloaded = await host.unloadPlugin('live-ext');
    expect(unloaded).toBe(true);
    expect(h.toolRegistry.get('greet')).toBeUndefined();
    expect(uiRegistry.listStatusChips()).toEqual([]);
  });

  it('rejects pre-flight schema/version errors BEFORE tearing down v1 and rolls back v1 if v2 setup throws', async () => {
    const h = makeHarness();
    let v1TeardownCount = 0;

    const v1: Plugin = {
      name: 'resilient-plug',
      version: '1.0.0',
      apiVersion: '^0.1',
      capabilities: { tools: true, teardown: true },
      setup(api) {
        api.tools.register({
          name: 'ping',
          description: 'ping tool',
          inputSchema: { type: 'object', properties: {} },
          permission: 'auto',
          mutating: false,
          execute: async () => 'pong-v1',
        });
      },
      teardown() {
        v1TeardownCount += 1;
      },
    };

    const host = await loadPlugins([v1], {
      apiFactory: h.apiFactory,
      log: h.log,
      enforceCapabilities: true,
    });

    // 1. Pre-flight apiVersion mismatch must NOT touch v1 at all.
    const badVersion: Plugin = {
      name: 'resilient-plug',
      apiVersion: '^99.0.0',
      setup() {},
    };
    await expect(host.reloadPlugin(badVersion)).rejects.toThrow();
    expect(v1TeardownCount).toBe(0);
    expect(h.toolRegistry.get('ping')).toBeDefined();

    // 2. Runtime setup() failure rolls back to v1 automatically!
    const brokenSetup: Plugin = {
      name: 'resilient-plug',
      version: '2.0.0',
      apiVersion: '^0.1',
      capabilities: { tools: true, teardown: true },
      setup(api) {
        api.tools.register({
          name: 'half-registered',
          description: 'transient',
          inputSchema: { type: 'object', properties: {} },
          permission: 'auto',
          mutating: false,
          execute: async () => 'never',
        });
        throw new Error('v2 crashed midway');
      },
    };
    await expect(host.reloadPlugin(brokenSetup)).rejects.toThrow('v2 crashed midway');
    expect(h.toolRegistry.get('half-registered')).toBeUndefined();
    expect(h.toolRegistry.get('ping')).toBeDefined();
    const pong = await h.toolRegistry.get('ping')!.execute({}, {} as never);
    expect(pong).toBe('pong-v1');
  });

  it('enforces capabilities.ui under strict capability enforcement', async () => {
    const h = makeHarness();
    const unauthorizedUiPlugin: Plugin = {
      name: 'sneaky-ui',
      apiVersion: '^0.1',
      capabilities: { tools: true }, // missing ui: true!
      setup(api) {
        api.ui?.registerStatusChip({ id: 'x', text: 'nope' });
      },
    };

    const host = await loadPlugins([unauthorizedUiPlugin], {
      apiFactory: h.apiFactory,
      log: h.log,
      enforceCapabilities: true,
    });
    expect(host.loaded).toEqual([]);
    expect(host.failed).toHaveLength(1);
    expect(h.uiRegistry.listStatusChips()).toEqual([]);
  });

  it('sanitizes terminal escape sequences, clamps 24-char status chips, bounds view depth, and throttles updates', async () => {
    vi.useFakeTimers();
    try {
      const uiRegistry = new PluginUiRegistry({ throttleMs: 250 });
      let emissions = 0;
      uiRegistry.subscribe(() => {
        emissions += 1;
      });

      const handle = uiRegistry.registerStatusChip('plug', {
        id: ' build ',
        text: '\x1b[31m\x1b]52;c;evil\x07SuperLongStatusChipTextExceedingTwentyFourChars',
        tone: 'accent',
      });
      expect(emissions).toBe(1);
      const chip = uiRegistry.listStatusChips()[0]!;
      expect(chip.text).not.toContain('\x1b');
      expect(chip.text.length).toBeLessThanOrEqual(24);

      // Burst 10 updates within 50ms -> coalesced to trailing edge at 250ms (<= 4 Hz).
      for (let i = 0; i < 10; i += 1) {
        handle.update({ text: `step-${i}` });
      }
      expect(emissions).toBe(1);
      vi.advanceTimersByTime(260);
      expect(emissions).toBe(2);
      expect(uiRegistry.listStatusChips()[0]?.text).toBe('step-9');

      // Deep view tree > depth 8 is clamped + sanitized.
      let deepNode: any = { kind: 'text', text: '\x1b[2Jleaf' };
      for (let i = 0; i < 11; i += 1) {
        deepNode = { kind: 'stack', direction: 'vertical', children: [deepNode] };
      }
      uiRegistry.registerPanel('plug', {
        id: 'inspector',
        title: '\x1b_Gevil\x1b\\Inspector',
        render: () => deepNode,
      });
      const panel = uiRegistry.getPanel('plug:inspector')!;
      expect(panel.title).toBe('Inspector');
      const rendered = await panel.render();
      const serialized = JSON.stringify(rendered);
      expect(serialized).not.toContain('\x1b');
      expect(serialized).toContain('[view depth limit exceeded]');

      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts api.signal on unload, awaits waitForQuiescence, rolls back when reloaded setup() throws, and survives 50 consecutive reload cycles', async () => {
    const h = makeHarness();
    let v1SignalAborted = false;
    const quiesceCalls: Array<{ name: string; timeoutMs: number }> = [];

    const v1: Plugin = {
      name: 'live-worker',
      version: '1.0.0',
      apiVersion: '^0.1',
      capabilities: { tools: true, slashCommands: true, ui: true },
      setup(api) {
        api.signal?.addEventListener('abort', () => {
          v1SignalAborted = true;
        });
        api.tools.register({
          name: 'live_probe',
          description: 'v1',
          inputSchema: { type: 'object', properties: {} },
          permission: 'read',
          execute: async () => 'gen-0',
        });
        api.ui?.registerStatusChip({ id: 'gen', text: 'gen-0' });
      },
    };

    const host = await loadPlugins([v1], {
      apiFactory: h.apiFactory,
      log: h.log,
      quiescenceTimeoutMs: 2_500,
      waitForQuiescence: async (pluginName, timeoutMs) => {
        quiesceCalls.push({ name: pluginName, timeoutMs });
      },
    });

    // Reloading with a broken setup() aborts v1, runs quiescence, then rolls back to v1 cleanly!
    const brokenV2: Plugin = {
      name: 'live-worker',
      version: '2.0.0-broken',
      apiVersion: '^0.1',
      capabilities: { tools: true, ui: true },
      setup(api) {
        // Register partial state before throwing — must be drained before rollback!
        api.ui?.registerStatusChip({ id: 'leaked', text: 'bad' });
        throw new Error('simulated setup crash');
      },
    };

    await expect(host.reloadPlugin(brokenV2)).rejects.toThrow('simulated setup crash');
    expect(v1SignalAborted).toBe(true);
    expect(quiesceCalls).toEqual([{ name: 'live-worker', timeoutMs: 2_500 }]);
    expect(await h.toolRegistry.get('live_probe')?.execute({}, {} as never)).toBe('gen-0');
    expect(h.uiRegistry.listStatusChips().map((c) => c.id)).toEqual(['gen']);

    // 50 consecutive reload cycles — zero leaked tools, commands, or UI chips!
    for (let cycle = 1; cycle <= 50; cycle += 1) {
      const nextGen: Plugin = {
        name: 'live-worker',
        version: `1.0.${cycle}`,
        apiVersion: '^0.1',
        capabilities: { tools: true, slashCommands: true, ui: true },
        setup(api) {
          expect(api.signal?.aborted).toBe(false);
          api.tools.register({
            name: 'live_probe',
            description: `gen-${cycle}`,
            inputSchema: { type: 'object', properties: {} },
            permission: 'read',
            execute: async () => `gen-${cycle}`,
          });
          api.slashCommands.register({
            name: 'gen',
            description: `gen-${cycle}`,
            run: async () => ({ message: `gen-${cycle}` }),
          });
          api.ui?.registerStatusChip({ id: 'gen', text: `gen-${cycle}` });
        },
      };
      const res = await host.reloadPlugin(nextGen);
      expect(res.status).toBe('reloaded');
    }

    expect(host.loaded).toHaveLength(1);
    expect(await h.toolRegistry.get('live_probe')?.execute({}, {} as never)).toBe('gen-50');
    expect(h.uiRegistry.listStatusChips()).toHaveLength(1);
    expect(h.uiRegistry.listStatusChips()[0]?.text).toBe('gen-50');

    await host.dispose();
    expect(h.toolRegistry.get('live_probe')).toBeUndefined();
    expect(h.uiRegistry.listStatusChips()).toEqual([]);
  });
});

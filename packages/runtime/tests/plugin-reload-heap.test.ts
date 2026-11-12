import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Container, EventBus } from '@wrongstack/contracts/kernel';
import type { Config, Logger } from '@wrongstack/contracts/types';
import { loadPlugins } from '@wrongstack/core/plugin';
import { ProviderRegistry, SlashCommandRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractiveTrustRepinCallback } from '../src/plugin-host/external-plugins.js';
import { setupPlugins } from '../src/plugin-host.js';
import { runPluginManagementCommand } from '../src/plugin-management/management.js';
import { parsePluginReloadArgs } from '../src/plugin-management/plugin-watch.js';
import { buildImageCommand } from '../src/portable-commands/image.js';

function silentLogger(): Logger {
  const log = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => log),
    setLevel: vi.fn(),
  };
  return log as never as Logger;
}

function forceGarbageCollection(): void {
  const bunRuntime = (globalThis as { Bun?: { gc?: (sync?: boolean) => void } }).Bun;
  if (typeof bunRuntime?.gc === 'function') {
    bunRuntime.gc(true);
    bunRuntime.gc(true);
    return;
  }
  const gcFn = (globalThis as { gc?: () => void }).gc;
  if (typeof gcFn === 'function') {
    gcFn();
    gcFn();
  }
}

function writeSoakPluginSource(iteration: number): string {
  return [
    'export default {',
    '  name: "soak-reload-ts",',
    `  version: "1.0.${iteration}",`,
    '  apiVersion: "^0.1",',
    '  capabilities: { tools: true, slashCommands: true, ui: true },',
    '  setup(api: any) {',
    `    api.ui?.registerStatusChip({ id: "iter", text: "iter:${iteration}" });`,
    '    api.ui?.registerPanel({',
    '      id: "status",',
    '      title: "Soak Status",',
    `      render: () => ({ kind: "text", text: "iteration=${iteration}" }),`,
    '    });',
    '    api.slashCommands.register({',
    '      name: "soak-cmd",',
    '      description: "Soak test command",',
    `      run: async () => ({ message: "rev-${iteration}" }),`,
    '    });',
    '    api.tools.register({',
    '      name: "soak_tool",',
    '      description: "Soak test tool",',
    '      inputSchema: { type: "object", properties: {} },',
    '      permission: "auto",',
    '      mutating: false,',
    `      execute: async () => "tool-${iteration}",`,
    '    });',
    '  },',
    '};',
  ].join('\n');
}

describe('50-consecutive /plugin reload heap & listener hygiene gate', () => {
  let rootDir = '';
  let globalRoot = '';
  let projectRoot = '';

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'wstack-reload-heap-'));
    globalRoot = join(rootDir, 'global');
    projectRoot = join(rootDir, 'project');
    await mkdir(join(globalRoot, 'plugins'), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('keeps retained post-GC heap growth < 2 MiB and leaves zero duplicate registrations across 50 consecutive reloads', async () => {
    const entryPath = join(globalRoot, 'plugins', 'soak-reload-ts.ts');
    await writeFile(entryPath, writeSoakPluginSource(0));

    const events = new EventBus();
    const toolRegistry = new ToolRegistry();
    const slashCommandRegistry = new SlashCommandRegistry();
    const config: Config = {
      version: 1,
      provider: 'anthropic',
      model: 'claude',
      features: {
        mcp: false,
        plugins: true,
        pluginsTrust: false,
        memory: false,
        modelsRegistry: false,
        skills: false,
      },
    } as never as Config;

    const handle = await setupPlugins({
      config,
      container: new Container(),
      events,
      pipelines: {} as never,
      toolRegistry,
      providerRegistry: new ProviderRegistry(),
      slashCommandRegistry,
      mcpRegistry: {} as never,
      log: silentLogger(),
      agent: {},
      sessionWriter: { transcriptPath: join(rootDir, 'soak.jsonl'), append: vi.fn() } as never,
      configStore: { get: () => config, update: vi.fn(), watch: () => () => {} } as never,
      paths: {
        globalRoot,
        configDir: globalRoot,
        globalConfig: join(globalRoot, 'config.json'),
        globalSkills: join(globalRoot, 'skills'),
        globalPrompts: join(globalRoot, 'prompts'),
        globalMemory: join(globalRoot, 'memory.md'),
        historyFile: join(globalRoot, 'history'),
        syncConfig: join(globalRoot, 'sync.json'),
        projectRoot,
      },
    });

    expect(handle?.reloadExternal).toBeTypeOf('function');

    // Warm up bundler/JIT caches with 3 initial reload cycles before measuring baseline heap.
    for (let warm = 1; warm <= 3; warm++) {
      await writeFile(entryPath, writeSoakPluginSource(warm));
      const warmRes = await handle!.reloadExternal!('soak-reload-ts');
      expect(warmRes.failed).toEqual([]);
      expect(warmRes.reloaded).toEqual(['soak-reload-ts']);
    }

    forceGarbageCollection();
    await new Promise((r) => setTimeout(r, 15));
    forceGarbageCollection();
    const baselineHeapBytes = process.memoryUsage().heapUsed;

    const RELOAD_CYCLES = 50;
    for (let i = 1; i <= RELOAD_CYCLES; i++) {
      await writeFile(entryPath, writeSoakPluginSource(100 + i));
      const res = await handle!.reloadExternal!('soak-reload-ts');
      expect(res.failed).toEqual([]);
      expect(res.reloaded).toEqual(['soak-reload-ts']);
    }

    // Verify zero stale/duplicate registrations remain after 50 swaps.
    expect(handle?.uiRegistry?.listStatusChips()).toHaveLength(1);
    expect(handle?.uiRegistry?.listStatusChips()[0]?.text).toBe(`iter:${100 + RELOAD_CYCLES}`);
    expect(handle?.uiRegistry?.listPanels()).toHaveLength(1);
    const toolOut = await toolRegistry.get('soak_tool')!.execute({}, {} as never, {
      signal: new AbortController().signal,
    });
    expect(toolOut).toBe(`tool-${100 + RELOAD_CYCLES}`);
    const cmdOut = await slashCommandRegistry
      .get('soak-reload-ts:soak-cmd')!
      .run('', undefined as never);
    expect(cmdOut?.message).toBe(`rev-${100 + RELOAD_CYCLES}`);
    expect(slashCommandRegistry.list().filter((c) => c.name.includes('soak-cmd'))).toHaveLength(1);

    forceGarbageCollection();
    await new Promise((r) => setTimeout(r, 20));
    forceGarbageCollection();
    const afterHeapBytes = process.memoryUsage().heapUsed;
    const retainedDeltaBytes = Math.max(0, afterHeapBytes - baselineHeapBytes);

    // Plan §6 acceptance gate: < 2 MiB retained heap growth across 50 consecutive reloads.
    expect(retainedDeltaBytes).toBeLessThan(2 * 1024 * 1024);

    await handle?.dispose();
  }, 30_000);

  it('parses /plugin reload --force cleanly and bypasses waitForQuiescence when force is true', async () => {
    expect(parsePluginReloadArgs(['--force'])).toEqual({ targetName: undefined, force: true });
    expect(parsePluginReloadArgs(['my-plug', '--force'])).toEqual({
      targetName: 'my-plug',
      force: true,
    });
    expect(parsePluginReloadArgs(['--all', '-f'])).toEqual({ targetName: undefined, force: true });

    const waitForQuiescence = vi.fn(async () => {});
    const host = await loadPlugins(
      [
        {
          name: 'q-plug',
          version: '1.0.0',
          apiVersion: '^0.1',
          setup() {},
        },
      ],
      {
        log: silentLogger(),
        waitForQuiescence,
        apiFactory: () => ({}) as never,
      },
    );

    await host.reloadPlugin({
      name: 'q-plug',
      version: '1.0.1',
      apiVersion: '^0.1',
      setup() {},
    });
    expect(waitForQuiescence).toHaveBeenCalledTimes(1);

    await host.reloadPlugin(
      {
        name: 'q-plug',
        version: '1.0.2',
        apiVersion: '^0.1',
        setup() {},
      },
      { force: true },
    );
    expect(waitForQuiescence).toHaveBeenCalledTimes(1);
    await host.dispose();
  });

  it('supports interactive [diff] closure summary inspection before TOFU re-pin confirmation', async () => {
    const entryPath = join(globalRoot, 'plugins', 'diff-check.ts');
    await writeFile(
      entryPath,
      'export const A = 1;\nexport default { name: "diff-check", apiVersion: "^0.1", setup() {} };\n',
    );

    const prompts: unknown[] = [];
    const notifications: string[] = [];
    const callback = createInteractiveTrustRepinCallback(
      {
        prompt: vi
          .fn()
          .mockImplementationOnce(async (_owner, opts) => {
            prompts.push(opts);
            return 'diff';
          })
          .mockImplementationOnce(async (_owner, opts) => {
            prompts.push(opts);
            return true;
          }),
        notify: (_owner, message) => notifications.push(message),
      },
      [join(globalRoot, 'plugins')],
    );

    const approved = await callback({
      label: 'diff-check',
      entryPath,
      previousIntegrity: 'sha256:1111222233334444',
      nextIntegrity: 'sha256:aaaabbbbccccdddd',
      pinnedAt: '2026-11-12T10:00:00.000Z',
    });

    expect(approved).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(notifications[0]).toContain('Single-file entry:');
    expect(notifications[0]).toContain('3 lines');
  });

  it('aborts api.signal before teardown on --force reload, preserves external plugin path/options on toggle, and opens latest screenshot via bare /image', async () => {
    // 1. Force reload aborts lifetime BEFORE teardown runs
    const abortController = new AbortController();
    let abortedDuringTeardown = false;
    const host = await loadPlugins(
      [
        {
          name: 'force-bg',
          version: '1.0.0',
          apiVersion: '^0.1',
          setup() {},
          teardown() {
            abortedDuringTeardown = abortController.signal.aborted;
          },
        },
      ],
      {
        log: silentLogger(),
        apiFactory: () =>
          ({
            signal: abortController.signal,
            abortLifetime: (reason?: unknown) => abortController.abort(reason),
          }) as never,
      },
    );

    await host.reloadPlugin(
      {
        name: 'force-bg',
        version: '1.0.1',
        apiVersion: '^0.1',
        setup() {},
      },
      { force: true },
    );
    expect(abortedDuringTeardown).toBe(true);
    await host.dispose();

    // 2. Toggle external plugin with path + options preserves both across off -> on
    const configPath = join(globalRoot, 'config.json');
    const initialPlugins = [
      { name: 'ext-custom', path: './plugins/ext-custom.ts', options: { retries: 3 } },
    ];
    await writeFile(configPath, JSON.stringify({ plugins: initialPlugins }, null, 2));
    const baseCfg = {
      features: { plugins: true },
      plugins: initialPlugins,
    } as never as Config;

    const disableRes = await runPluginManagementCommand(['toggle', 'ext-custom'], {
      config: baseCfg,
      configPath,
    });
    expect(disableRes.code).toBe(0);
    expect(disableRes.patch?.plugins).toEqual([
      {
        name: 'ext-custom',
        path: './plugins/ext-custom.ts',
        options: { retries: 3 },
        enabled: false,
      },
    ]);

    const enableRes = await runPluginManagementCommand(['toggle', 'ext-custom'], {
      config: { ...baseCfg, plugins: disableRes.patch?.plugins } as never as Config,
      configPath,
    });
    expect(enableRes.code).toBe(0);
    expect(enableRes.patch?.plugins).toEqual([
      {
        name: 'ext-custom',
        path: './plugins/ext-custom.ts',
        options: { retries: 3 },
        enabled: true,
      },
    ]);

    // 3. Bare `/image` opens the latest tool screenshot via getLastImagePath
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x08, 0x08, 0x06, 0x00, 0x00, 0x00,
    ]);
    const shotPath = join(projectRoot, 'latest-shot.png');
    await writeFile(shotPath, pngHeader);
    const openedActions: string[] = [];
    const imgCmd = buildImageCommand({
      projectRoot,
      getLastImagePath: () => shotPath,
      onPanelOpen: {
        current: (action: string) => {
          openedActions.push(action);
          return true;
        },
      },
    });
    const imgOut = await imgCmd.run('');
    expect(imgOut?.message).toBeUndefined();
    expect(openedActions).toHaveLength(1);
    expect(openedActions[0]).toMatch(/^image:.*latest-shot\.png$/);
  });
});

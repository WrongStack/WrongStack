import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, Logger } from '@wrongstack/contracts/types';
import { defaultPluginTrustPath, normalizeTrustKey, pinPluginTrust } from '@wrongstack/core/plugin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPluginManagementCommand } from '../src/commands.js';
import { hashPluginClosure, loadExternalPlugins, setupPlugins } from '../src/plugin-host.js';

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

describe('Zero-build external TypeScript plugins, TOFU closure isolation, and live /plugin reload', () => {
  let rootDir = '';
  let globalRoot = '';
  let projectRoot = '';

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'wstack-ts-plug-'));
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

  it('isolates single-file TOFU hashes in shared discovery roots while hashing full directory closures', async () => {
    const discoveryRoot = join(globalRoot, 'plugins');
    const singleA = join(discoveryRoot, 'alpha.ts');
    const singleB = join(discoveryRoot, 'beta.ts');
    await writeFile(
      singleA,
      'export interface Cfg { tag: string }\nexport default { name: "alpha", apiVersion: "^0.1", setup() {} };\n',
    );

    const hashBeforeSibling = await hashPluginClosure(singleA, [discoveryRoot]);
    await writeFile(singleB, 'export default { name: "beta", apiVersion: "^0.1", setup() {} };\n');
    const hashAfterSibling = await hashPluginClosure(singleA, [discoveryRoot]);
    // Adding or editing a sibling single-file plugin in ~/.wrongstack/plugins MUST NOT mutate alpha.ts's hash!
    expect(hashAfterSibling).toBe(hashBeforeSibling);

    // Conversely, inside a dedicated plugin directory, modifying a helper .ts file MUST change the closure hash!
    const pkgDir = join(discoveryRoot, 'multi-ts');
    await mkdir(pkgDir, { recursive: true });
    const entryFile = join(pkgDir, 'index.ts');
    const helperFile = join(pkgDir, 'helper.ts');
    await writeFile(helperFile, 'export const MSG: string = "v1";\n');
    await writeFile(
      entryFile,
      'import { MSG } from "./helper.ts";\nexport default { name: "multi-ts", apiVersion: "^0.1", msg: MSG, setup() {} };\n',
    );

    const dirHashV1 = await hashPluginClosure(entryFile, [discoveryRoot]);
    await writeFile(helperFile, 'export const MSG: string = "tampered-v2";\n');
    const dirHashV2 = await hashPluginClosure(entryFile, [discoveryRoot]);
    expect(dirHashV2).not.toBe(dirHashV1);

    // Verify loadExternalPlugins refuses tampered helper under TOFU until re-pinned:
    await writeFile(helperFile, 'export const MSG: string = "v1";\n');
    const log = silentLogger();
    const baseCfg = {
      version: 1,
      provider: 'anthropic',
      model: 'claude',
      features: { plugins: true, pluginsTrust: 'tofu' },
    } as never as Config;
    const hooks = {
      nameFromSpec: (s: string) => s,
      isBuiltinSpec: () => false,
      warnIfDeprecated: () => false,
    };

    const firstLoad = await loadExternalPlugins(
      {
        config: baseCfg,
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
      },
      hooks,
    );
    expect(firstLoad.map((p) => p.name)).toContain('multi-ts');

    // Tamper helper.ts without re-pinning -> refused pre-import!
    await writeFile(helperFile, 'export const MSG: string = "tampered-v2";\n');
    const failedLabels: string[] = [];
    const tamperedLoad = await loadExternalPlugins(
      {
        config: baseCfg,
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        reloadGeneration: 1,
        onlyName: 'multi-ts',
        onFailure: (label) => failedLabels.push(label),
      },
      hooks,
    );
    expect(tamperedLoad).toEqual([]);
    expect(failedLabels).toEqual(['multi-ts']);

    // Re-pinning the updated closure allows reloadGeneration=2 to load the updated helper.ts cleanly!
    const newHash = await hashPluginClosure(entryFile, [discoveryRoot]);
    await pinPluginTrust(
      defaultPluginTrustPath(globalRoot),
      normalizeTrustKey(entryFile),
      normalizeTrustKey(entryFile),
      newHash,
      entryFile,
    );
    const repinnedLoad = await loadExternalPlugins(
      {
        config: baseCfg,
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        reloadGeneration: 2,
        onlyName: 'multi-ts',
      },
      hooks,
    );
    expect(repinnedLoad).toHaveLength(1);
    expect((repinnedLoad[0] as unknown as { msg: string }).msg).toBe('tampered-v2');
  });

  it('hot-reloads a live TypeScript plugin end-to-end via setupPlugins().reloadExternal and /plugin reload', async () => {
    const discoveryRoot = join(globalRoot, 'plugins');
    const pluginDir = join(discoveryRoot, 'calc-ts');
    await mkdir(pluginDir, { recursive: true });
    const helperPath = join(pluginDir, 'math.ts');
    const entryPath = join(pluginDir, 'index.ts');

    await writeFile(
      helperPath,
      'export function computeLabel(n: number): string { return `v1:${n * 2}`; }\n',
    );
    await writeFile(
      entryPath,
      [
        'import { computeLabel } from "./math.ts";',
        'interface Input { value: number }',
        'export default {',
        '  name: "calc-ts",',
        '  version: "0.1.0",',
        '  apiVersion: "^0.1",',
        '  capabilities: { tools: true, ui: true },',
        '  setup(api: any) {',
        '    api.ui?.registerStatusChip({ id: "ver", text: "calc:v1" });',
        '    api.tools.register({',
        '      name: "calc_double",',
        '      description: "Doubles a number",',
        '      inputSchema: { type: "object", properties: { value: { type: "number" } } },',
        '      permission: "auto",',
        '      mutating: false,',
        '      execute: async (input: Input) => computeLabel(input.value),',
        '    });',
        '  },',
        '};',
      ].join('\n'),
    );

    const { Container, EventBus } = await import('@wrongstack/contracts/kernel');
    const { ProviderRegistry, SlashCommandRegistry, ToolRegistry } = await import(
      '@wrongstack/core/registry'
    );

    const toolRegistry = new ToolRegistry();
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
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry,
      providerRegistry: new ProviderRegistry(),
      slashCommandRegistry: new SlashCommandRegistry(),
      mcpRegistry: {} as never,
      log: silentLogger(),
      agent: {},
      sessionWriter: { transcriptPath: join(rootDir, 's.jsonl'), append: vi.fn() } as never,
      configStore: { get: () => config, update: vi.fn(), watch: () => () => {} } as never,
      // Omit globalConfig/builtin paths? Wait: pass paths with hostOwnedBuiltins skipping builtins so test runs in <20ms!
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
      // Disable built-ins via extensions config? Easier: omit `paths`? No, `paths.globalRoot` is used for discovery!
      // Passing `hostOwnedBuiltins` or disabling builtins in `config.plugins`: let's check — builtins load fast, or we can mock/skip them via `hostOwnedBuiltins`!
    });

    expect(handle).toBeDefined();
    expect(toolRegistry.get('calc_double')).toBeDefined();
    const v1Out = await toolRegistry.get('calc_double')!.execute({ value: 21 }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(v1Out).toBe('v1:42');
    expect(handle?.uiRegistry?.listStatusChips().some((c) => c.text === 'calc:v1')).toBe(true);

    // Edit BOTH math.ts and index.ts on disk and hot-reload via `/plugin reload calc-ts`!
    await writeFile(
      helperPath,
      'export function computeLabel(n: number): string { return `v2:${n * 10}`; }\n',
    );
    await writeFile(
      entryPath,
      [
        'import { computeLabel } from "./math.ts";',
        'export default {',
        '  name: "calc-ts",',
        '  version: "0.2.0",',
        '  apiVersion: "^0.1",',
        '  capabilities: { tools: true, ui: true },',
        '  setup(api: any) {',
        '    api.ui?.registerStatusChip({ id: "ver", text: "calc:v2" });',
        '    api.tools.register({',
        '      name: "calc_double",',
        '      description: "Multiplies by 10",',
        '      inputSchema: { type: "object", properties: { value: { type: "number" } } },',
        '      permission: "auto",',
        '      mutating: false,',
        '      execute: async (input: { value: number }) => computeLabel(input.value),',
        '    });',
        '  },',
        '};',
      ].join('\n'),
    );

    const pluginCmd = buildPluginManagementCommand({
      reloadPlugins: (name) => handle!.reloadExternal!(name),
    });
    const cmdRes = await pluginCmd.run('reload calc-ts', undefined as never);
    expect(cmdRes?.message).toContain('Reloaded: calc-ts');

    const v2Out = await toolRegistry.get('calc_double')!.execute({ value: 21 }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(v2Out).toBe('v2:210');
    expect(handle?.uiRegistry?.listStatusChips().some((c) => c.text === 'calc:v2')).toBe(true);
    expect(handle?.uiRegistry?.listStatusChips().some((c) => c.text === 'calc:v1')).toBe(false);

    await handle?.dispose();
  });

  it('bridges @wrongstack/plugin-sdk for standalone .ts plugins outside node_modules and emits plugin.reloaded', async () => {
    const discoveryRoot = join(globalRoot, 'plugins');
    const standaloneEntry = join(discoveryRoot, 'standalone-sdk.ts');

    await writeFile(
      standaloneEntry,
      [
        'import { definePlugin } from "@wrongstack/plugin-sdk";',
        'export default definePlugin(',
        '  {',
        '    name: "standalone-sdk",',
        '    version: "1.0.0",',
        '    capabilities: { ui: true },',
        '  },',
        '  (api) => {',
        '    api.ui?.registerStatusChip({ id: "sdk", text: "sdk:v1" });',
        '  },',
        ');',
      ].join('\n'),
    );

    const { Container, EventBus } = await import('@wrongstack/contracts/kernel');
    const { ProviderRegistry, SlashCommandRegistry, ToolRegistry } = await import(
      '@wrongstack/core/registry'
    );

    const events = new EventBus();
    const reloadedPayloads: Array<{
      name: string;
      version?: string | undefined;
      durationMs: number;
    }> = [];
    events.on('plugin.reloaded', (payload) => {
      reloadedPayloads.push(payload);
    });

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
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      slashCommandRegistry: new SlashCommandRegistry(),
      mcpRegistry: {} as never,
      log: silentLogger(),
      agent: {},
      sessionWriter: { transcriptPath: join(rootDir, 's2.jsonl'), append: vi.fn() } as never,
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

    expect(handle?.uiRegistry?.listStatusChips().some((c) => c.text === 'sdk:v1')).toBe(true);

    // Update the standalone .ts plugin and hot-reload (exercises Bun.build virtual bridge too!)
    await writeFile(
      standaloneEntry,
      [
        'import { definePlugin } from "@wrongstack/plugin-sdk";',
        'export default definePlugin(',
        '  {',
        '    name: "standalone-sdk",',
        '    version: "1.1.0",',
        '    capabilities: { ui: true },',
        '  },',
        '  (api) => {',
        '    api.ui?.registerStatusChip({ id: "sdk", text: "sdk:v2" });',
        '  },',
        ');',
      ].join('\n'),
    );

    const res = await handle!.reloadExternal!('standalone-sdk');
    expect(res.reloaded).toEqual(['standalone-sdk']);
    expect(handle?.uiRegistry?.listStatusChips().some((c) => c.text === 'sdk:v2')).toBe(true);
    expect(reloadedPayloads).toHaveLength(1);
    expect(reloadedPayloads[0]?.name).toBe('standalone-sdk');
    expect(reloadedPayloads[0]?.version).toBe('1.1.0');
    expect(reloadedPayloads[0]?.durationMs).toBeGreaterThanOrEqual(0);

    await handle?.dispose();
  });

  it('pins the directory Merkle closure in wstack plugin trust so loadExternalPlugins accepts edited helper .ts files', async () => {
    const discoveryRoot = join(globalRoot, 'plugins');
    const pkgDir = join(discoveryRoot, 'dir-trust-ts');
    await mkdir(pkgDir, { recursive: true });
    const entryFile = join(pkgDir, 'index.ts');
    const helperFile = join(pkgDir, 'helper.ts');
    await writeFile(helperFile, 'export const TAG = "v1";\n');
    await writeFile(
      entryFile,
      'import { TAG } from "./helper.ts";\nexport default { name: "dir-trust-ts", apiVersion: "^0.1", tag: TAG, setup() {} };\n',
    );

    const log = silentLogger();
    const baseCfg = {
      version: 1,
      provider: 'anthropic',
      model: 'claude',
      features: { plugins: true, pluginsTrust: 'tofu' },
    } as never as Config;
    const hooks = {
      nameFromSpec: (s: string) => s,
      isBuiltinSpec: () => false,
      warnIfDeprecated: () => false,
    };

    // Initial TOFU load pins v1 closure
    const v1Loaded = await loadExternalPlugins(
      { config: baseCfg, log, globalRoot, projectRoot, reservedNames: new Set() },
      hooks,
    );
    expect(v1Loaded).toHaveLength(1);

    // Edit helper.ts -> TOFU blocks until trusted via `wstack plugin trust dir-trust-ts`
    await writeFile(helperFile, 'export const TAG = "v2-trusted-via-cli";\n');
    const blocked = await loadExternalPlugins(
      {
        config: baseCfg,
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        reloadGeneration: 1,
        onlyName: 'dir-trust-ts',
      },
      hooks,
    );
    expect(blocked).toEqual([]);

    const { runPluginManagementCommand } = await import('../src/plugin-management.js');
    const trustRes = await runPluginManagementCommand(['trust', 'dir-trust-ts'], {
      config: baseCfg,
      configPath: join(globalRoot, 'config.json'),
      globalRoot,
      projectRoot,
    });
    expect(trustRes.code).toBe(0);
    expect(trustRes.message).toContain('Re-pinned "dir-trust-ts"');

    const v2Loaded = await loadExternalPlugins(
      {
        config: baseCfg,
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        reloadGeneration: 2,
        onlyName: 'dir-trust-ts',
      },
      hooks,
    );
    expect(v2Loaded).toHaveLength(1);
    expect((v2Loaded[0] as unknown as { tag: string }).tag).toBe('v2-trusted-via-cli');
  });

  it('supports /plugin reload --all, in-session /plugin trust auto-reload, /plugin watch security boundary, and tool quiescence', async () => {
    const userPluginPath = join(globalRoot, 'plugins', 'watchable.ts');
    const projectPluginPath = join(projectRoot, '.wrongstack', 'plugins', 'repo-local.ts');
    await mkdir(join(globalRoot, 'plugins'), { recursive: true });
    await mkdir(join(projectRoot, '.wrongstack', 'plugins'), { recursive: true });
    await writeFile(
      userPluginPath,
      'export default { name: "watchable", version: "0.1.0", setup() {} };\n',
    );
    await writeFile(
      projectPluginPath,
      'export default { name: "repo-local", version: "0.1.0", setup() {} };\n',
    );

    const configPath = join(globalRoot, 'config.json');
    const cfg = { version: 1, provider: 'anthropic', model: 'claude' } as never as Config;
    await writeFile(configPath, JSON.stringify(cfg, null, 2));

    const reloadCalls: Array<string | undefined> = [];
    const { buildPluginManagementCommand } = await import('../src/commands.js');
    const { PluginDevWatchController } = await import('../src/plugin-management.js');
    const watchController = new PluginDevWatchController();

    const pluginCmd = buildPluginManagementCommand({
      configStore: { get: () => cfg, update: vi.fn(), watch: () => () => {} } as never,
      getProfileConfigPath: () => configPath,
      paths: { globalRoot } as never,
      projectRoot,
      pluginWatchController: watchController,
      reloadPlugins: async (name) => {
        reloadCalls.push(name);
        return { reloaded: [name ?? 'watchable'], unloaded: [], failed: [] };
      },
    });

    // 1. `/plugin reload --all` normalizes `--all` -> `undefined`
    const reloadAllRes = await pluginCmd.run('reload --all', {} as never);
    expect(reloadCalls[0]).toBeUndefined();
    expect(reloadAllRes?.message).toContain('Reloaded: watchable');

    // 2. `/plugin trust repo-local` pins closure trust AND immediately triggers reloadPlugins('repo-local')
    const trustRes = await pluginCmd.run('trust repo-local', {} as never);
    expect(trustRes?.message).toContain('Re-pinned "repo-local"');
    expect(trustRes?.message).toContain('Reloaded: repo-local');
    expect(reloadCalls[1]).toBe('repo-local');

    // 3. `/plugin watch` strictly refuses project-local plugins and path traversal
    const refusedProject = await pluginCmd.run('watch repo-local', {} as never);
    expect(refusedProject?.message).toContain('Refused to watch project-local plugin "repo-local"');
    const refusedTraversal = await pluginCmd.run('watch ../outside', {} as never);
    expect(refusedTraversal?.message).toContain('Security boundary: invalid plugin name');

    // 4. `/plugin watch watchable` watches ~/.wrongstack/plugins/watchable.ts and unwatch stops cleanly
    const startedWatch = await pluginCmd.run('watch watchable', {} as never);
    expect(startedWatch?.message).toContain('Watching user-global plugin "watchable"');
    expect(watchController.list()).toEqual(['watchable']);
    const stoppedWatch = await pluginCmd.run('watch off watchable', {} as never);
    expect(stoppedWatch?.message).toContain('Stopped watching: watchable');
    expect(watchController.list()).toEqual([]);
    watchController.dispose();

    // 5. `installPluginToolQuiescence` waits for in-flight tool owned by a plugin to finish
    const { installPluginToolQuiescence } = await import('../src/plugin-host.js');
    const { ToolRegistry } = await import('@wrongstack/core/registry');
    let capturedMiddleware:
      | ((payload: unknown, next: (v: unknown) => Promise<unknown>) => Promise<unknown>)
      | undefined;
    const toolReg = new ToolRegistry();
    toolReg.register(
      {
        name: 'slow_plugin_op',
        description: 'Slow op',
        inputSchema: { type: 'object', properties: {} },
        permission: 'auto',
        mutating: false,
        execute: async () => 'ok',
      },
      'calc-ts',
    );
    const waitForQuiescence = installPluginToolQuiescence(
      {
        toolCall: {
          use(mw: { handler: typeof capturedMiddleware }) {
            capturedMiddleware = mw.handler;
          },
        } as never,
      },
      toolReg,
    );
    expect(capturedMiddleware).toBeDefined();

    let finishTool!: () => void;
    const inFlightPromise = capturedMiddleware!(
      { tool: { name: 'slow_plugin_op' }, toolUse: { name: 'slow_plugin_op' } },
      () =>
        new Promise((resolve) => {
          finishTool = () => resolve({ ok: true });
        }),
    );

    let quiesced = false;
    const waitPromise = waitForQuiescence('calc-ts', 2_000).then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    expect(quiesced).toBe(false);

    finishTool();
    await inFlightPromise;
    await waitPromise;
    expect(quiesced).toBe(true);
  });
});

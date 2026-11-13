import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config, Logger } from '@wrongstack/contracts/types';
import { defaultPluginTrustPath, normalizeTrustKey, pinPluginTrust } from '@wrongstack/core/plugin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPluginManagementCommand } from '../src/commands.js';
import {
  hashPluginClosure,
  importExternalPluginModule,
  loadExternalPlugins,
  setupPlugins,
} from '../src/plugin-host.js';

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

  it('prompts for interactive TOFU re-pin on /plugin reload and fails closed when headless or denied', async () => {
    const discoveryRoot = join(globalRoot, 'plugins');
    const pluginDir = join(discoveryRoot, 'repin-demo');
    await mkdir(pluginDir, { recursive: true });
    const entryPath = join(pluginDir, 'index.ts');

    const writeVersion = async (tag: string) => {
      await writeFile(
        entryPath,
        [
          'export default {',
          '  name: "repin-demo",',
          '  version: "0.1.0",',
          '  apiVersion: "^0.1",',
          '  capabilities: { tools: true },',
          '  setup(api: any) {',
          '    api.tools.register({',
          '      name: "repin_echo",',
          '      description: "Echoes version tag",',
          '      inputSchema: { type: "object", properties: {} },',
          '      permission: "auto",',
          '      mutating: false,',
          `      execute: async () => "${tag}",`,
          '    });',
          '  },',
          '};',
        ].join('\n'),
      );
    };

    await writeVersion('v1');

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
        pluginsTrust: 'tofu',
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

    const execEcho = () =>
      toolRegistry.get('repin_echo')!.execute({}, {} as never, {
        signal: new AbortController().signal,
      });
    expect(await execEcho()).toBe('v1');

    // Modify plugin source on disk so closure hash changes
    await writeVersion('v2');

    // (a) Headless reload (no prompt handler attached on uiRegistry) MUST fail closed and keep v1
    const headlessReport = await handle!.reloadExternal!('repin-demo');
    expect(headlessReport.failed).toContain('repin-demo');
    expect(await execEcho()).toBe('v1');

    // (b) Interactive prompt returning `false` MUST fail closed and keep v1
    const seenPrompts: Array<{ title: string; message?: string | undefined }> = [];
    handle!.uiRegistry!.setHandlers({
      onPrompt: async (_owner, opts) => {
        seenPrompts.push({ title: opts.title, message: opts.message });
        return false;
      },
    });
    const deniedReport = await handle!.reloadExternal!('repin-demo');
    expect(seenPrompts).toHaveLength(1);
    expect(seenPrompts[0]?.message).toContain('repin-demo');
    expect(seenPrompts[0]?.message).toContain('Re-pin trust and reload?');
    expect(deniedReport.failed).toContain('repin-demo');
    expect(await execEcho()).toBe('v1');

    // (c) Interactive prompt returning `true` re-pins trust store and hot-reloads v2
    handle!.uiRegistry!.setHandlers({
      onPrompt: async () => true,
    });
    const acceptedReport = await handle!.reloadExternal!('repin-demo');
    expect(acceptedReport.reloaded).toEqual(['repin-demo']);
    expect(acceptedReport.failed).toEqual([]);
    expect(await execEcho()).toBe('v2');
  });

  it('transpiles non-erasable TS syntax via mode:transform fallback, resolves .js→.ts cycles, preserves sourceURL, and enforces <= 64 local file cap', async () => {
    const pluginDir = join(globalRoot, 'plugins', 'node-fallback-demo');
    await mkdir(pluginDir, { recursive: true });

    const stripModesSeen: Array<'strip' | 'transform' | undefined> = [];
    const mockNodeStripTypes = (code: string, opts?: { mode?: 'strip' | 'transform' }): string => {
      stripModesSeen.push(opts?.mode);
      if (opts?.mode === 'strip' && /\benum\s+/.test(code)) {
        const err = new SyntaxError(
          'TypeScript enum is not supported in strip-only mode',
        ) as Error & {
          code?: string;
        };
        err.code = 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX';
        throw err;
      }
      return code
        .replace(
          /export\s+enum\s+Stage\s*\{\s*Ready\s*=\s*"ready"\s*,?\s*\}/g,
          'export const Stage = { Ready: "ready" };',
        )
        .replace(/:\s*(?:string|number)/g, '');
    };

    const helperAPath = join(pluginDir, 'cycle-a.ts');
    const helperBPath = join(pluginDir, 'cycle-b.ts');
    const entryPath = join(pluginDir, 'index.ts');

    await writeFile(
      helperAPath,
      [
        'import { B_TAG } from "./cycle-b.js";',
        'export enum Stage { Ready = "ready" }',
        'export function formatStage(version: string): string {',
        '  return `${Stage.Ready}:${B_TAG}:${version}`;',
        '}',
      ].join('\n'),
    );
    await writeFile(
      helperBPath,
      [
        'import { Stage } from "./cycle-a.js";',
        'export const B_TAG: string = "b1";',
        'export function readStageFromB(): string { return Stage.Ready; }',
        'export function captureStack(): string { return new Error("trace-probe").stack ?? ""; }',
      ].join('\n'),
    );
    await writeFile(
      entryPath,
      [
        'import { definePlugin } from "@wrongstack/plugin-sdk";',
        'import { formatStage } from "./cycle-a.js";',
        'import { captureStack } from "./cycle-b.js";',
        'export const label: string = formatStage("g1");',
        'export const stackSample: string = captureStack();',
        'export default definePlugin({ name: "node-fallback-demo", apiVersion: "^0.1", setup() {} });',
      ].join('\n'),
    );

    const modV1 = (await importExternalPluginModule(pathToFileURL(entryPath).href, {
      reloadGeneration: 1,
      stripTypeScriptTypes: mockNodeStripTypes,
    })) as { label: string; stackSample: string; default: { name: string } };

    expect(modV1.default.name).toBe('node-fallback-demo');
    expect(modV1.label).toBe('ready:b1:g1');
    // Confirm `mode: 'strip'` threw on `enum` and automatically fell back to `mode: 'transform'`
    expect(stripModesSeen).toContain('strip');
    expect(stripModesSeen).toContain('transform');
    // Inline `//# sourceURL=` preserves `.ts` file identity in stack traces
    expect(modV1.stackSample).toContain('cycle-b.ts');

    // Hot-reload after editing nested helper `cycle-b.ts` -> fresh value returned on gen=2!
    await writeFile(
      helperBPath,
      [
        'import { Stage } from "./cycle-a.js";',
        'export const B_TAG: string = "b2-reloaded";',
        'export function readStageFromB(): string { return Stage.Ready; }',
        'export function captureStack(): string { return new Error("trace-probe").stack ?? ""; }',
      ].join('\n'),
    );

    const modV2 = (await importExternalPluginModule(pathToFileURL(entryPath).href, {
      reloadGeneration: 2,
      stripTypeScriptTypes: mockNodeStripTypes,
    })) as { label: string };
    expect(modV2.label).toBe('ready:b2-reloaded:g1');

    // Exceeding MAX_PLUGIN_CLOSURE_FILES (64) rejects deterministically
    const oversizedDir = join(globalRoot, 'plugins', 'oversized-closure');
    await mkdir(oversizedDir, { recursive: true });
    const totalFiles = 66;
    for (let i = 0; i < totalFiles; i++) {
      const nextImport =
        i + 1 < totalFiles
          ? `import { v as nextV } from "./f${i + 1}.ts";\n`
          : 'const nextV = 0;\n';
      await writeFile(
        join(oversizedDir, `f${i}.ts`),
        `${nextImport}export const v: number = ${i} + nextV;\n`,
      );
    }
    await expect(
      importExternalPluginModule(pathToFileURL(join(oversizedDir, 'f0.ts')).href, {
        reloadGeneration: 1,
        stripTypeScriptTypes: mockNodeStripTypes,
      }),
    ).rejects.toThrow('exceeds maximum of 64 local files');
  });

  it('refreshes tool_search catalog discovery immediately (< 50 ms) when tools are added or removed via /plugin reload', async () => {
    const discoveryRoot = join(globalRoot, 'plugins');
    const entryPath = join(discoveryRoot, 'live-search-plugin.ts');

    await writeFile(
      entryPath,
      [
        'export default {',
        '  name: "live-search-plugin",',
        '  version: "0.1.0",',
        '  apiVersion: "^0.1",',
        '  capabilities: { tools: true },',
        '  setup(api: any) {',
        '    api.tools.register({',
        '      name: "zeta_v1_inspector",',
        '      description: "Inspects zeta telemetry frames v1",',
        '      inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },',
        '      permission: "auto",',
        '      mutating: false,',
        '      execute: async () => "v1",',
        '    });',
        '  },',
        '};',
      ].join('\n'),
    );

    const { Container, EventBus } = await import('@wrongstack/contracts/kernel');
    const { ProviderRegistry, SlashCommandRegistry, ToolRegistry } = await import(
      '@wrongstack/core/registry'
    );
    const { toolSearchTool } = await import('@wrongstack/tools/tool-search');

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

    const runSearch = (query: string) =>
      toolSearchTool.execute(
        { query },
        {
          tools: [],
          catalogTools: toolRegistry.list(),
        } as never,
        { signal: new AbortController().signal },
      );

    const beforeReload = await runSearch('zeta_v1_inspector');
    expect(beforeReload.tools.map((t) => t.name)).toContain('zeta_v1_inspector');

    // Replace zeta_v1_inspector with omega_v2_profiler and hot-reload
    await writeFile(
      entryPath,
      [
        'export default {',
        '  name: "live-search-plugin",',
        '  version: "0.2.0",',
        '  apiVersion: "^0.1",',
        '  capabilities: { tools: true },',
        '  setup(api: any) {',
        '    api.tools.register({',
        '      name: "omega_v2_profiler",',
        '      description: "Profiles omega flamegraphs in real time",',
        '      inputSchema: { type: "object", properties: { sampleHz: { type: "number" } }, required: ["sampleHz"] },',
        '      permission: "auto",',
        '      mutating: false,',
        '      execute: async () => "v2",',
        '    });',
        '  },',
        '};',
      ].join('\n'),
    );

    const report = await handle!.reloadExternal!('live-search-plugin');
    expect(report.reloaded).toEqual(['live-search-plugin']);

    const t0 = performance.now();
    const removedLookup = await runSearch('zeta_v1_inspector');
    const addedLookup = await runSearch('omega_v2_profiler');
    const searchElapsedMs = performance.now() - t0;

    expect(searchElapsedMs).toBeLessThan(50);
    expect(removedLookup.tools.map((t) => t.name)).not.toContain('zeta_v1_inspector');
    expect(addedLookup.tools[0]?.name).toBe('omega_v2_profiler');
    expect(addedLookup.tools[0]?.inputSchema).toMatchObject({
      required: ['sampleHz'],
    });
  });

  it('holds non-forced reloadPlugin until active tool.execute settles without aborting v1 signal mid-call', async () => {
    const { installPluginToolQuiescence } = await import('../src/plugin-host.js');
    const { Container, EventBus } = await import('@wrongstack/contracts/kernel');
    const { createDefaultPipelines } = await import('@wrongstack/core/agent');
    const { DefaultPluginAPI, loadPlugins, PluginUiRegistry } = await import(
      '@wrongstack/core/plugin'
    );
    const { ProviderRegistry, SlashCommandRegistry, ToolRegistry } = await import(
      '@wrongstack/core/registry'
    );

    const pipelines = createDefaultPipelines();
    const toolRegistry = new ToolRegistry();
    const uiRegistry = new PluginUiRegistry({ throttleMs: 0 });
    const waitForQuiescence = installPluginToolQuiescence(pipelines, toolRegistry);
    const noopLog = {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return noopLog;
      },
      setLevel() {},
    };
    const container = new Container();
    const events = new EventBus();
    const providerRegistry = new ProviderRegistry();
    const slashCommandRegistry = new SlashCommandRegistry();

    let markEntered!: () => void;
    let releaseExec!: () => void;
    const entered = new Promise<void>((r) => {
      markEntered = r;
    });
    const gate = new Promise<void>((r) => {
      releaseExec = r;
    });
    let signalAbortedMidCall = false;
    let finished = false;

    const v1 = {
      name: 'quiesce-live',
      version: '1.0.0',
      apiVersion: '^0.1',
      capabilities: { tools: true },
      setup(api: any) {
        api.tools.register({
          name: 'gated_op',
          description: 'Gated op',
          inputSchema: { type: 'object', properties: {} },
          permission: 'auto',
          mutating: false,
          async execute() {
            markEntered();
            await gate;
            signalAbortedMidCall = Boolean(api.signal?.aborted);
            finished = true;
            return 'v1-done';
          },
        });
      },
    };
    const v2 = { ...v1, version: '2.0.0', setup() {} };

    const host = await loadPlugins([v1], {
      log: noopLog as never,
      waitForQuiescence,
      quiescenceTimeoutMs: 5_000,
      apiFactory: (plugin) =>
        new DefaultPluginAPI({
          ownerName: plugin.name,
          capabilities: plugin.capabilities,
          container,
          events,
          pipelines: pipelines as never,
          toolRegistry,
          providerRegistry,
          slashCommandRegistry,
          config: { version: 1, provider: 'anthropic', model: 'claude', features: {} } as never,
          log: noopLog as never,
          uiRegistry,
        }),
    });

    const execP = toolRegistry
      .get('gated_op')!
      .execute({}, {} as never, { signal: new AbortController().signal });
    await entered;

    let reloadedBeforeGate = false;
    const reloadP = host.reloadPlugin(v2).then(() => {
      if (!finished) reloadedBeforeGate = true;
    });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(reloadedBeforeGate).toBe(false);

    releaseExec();
    await execP;
    await reloadP;
    expect(signalAbortedMidCall).toBe(false);
    await host.dispose();
  });
});

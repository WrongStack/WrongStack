import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Container, EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import type { Config, Logger, ModelsRegistry, SessionWriter } from '@wrongstack/contracts/types';
import { type Agent, createDefaultPipelines } from '@wrongstack/core/agent';
import { ExtensionRegistry } from '@wrongstack/core/extension';
import { HookRegistry, HookRunner } from '@wrongstack/core/hooks';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { CONFIG_BEHAVIOR_DEFAULTS, DefaultConfigStore } from '@wrongstack/core/storage';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { setupPlugins } from '@wrongstack/runtime/plugin-host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginExtensionFanout } from '../src/server/standalone-plugin-extensions.js';
import {
  loadStandalonePlugins,
  STANDALONE_HOST_OWNED_PLUGINS,
} from '../src/server/standalone-plugins.js';

// The project mailbox is a daemon; plugins only need something to hand to api.mailbox.
const mailbox = vi.hoisted(() => ({ close: vi.fn(async () => undefined) }));
vi.mock('@wrongstack/coordination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/coordination')>()),
  getSharedProjectMailbox: vi.fn(() => mailbox),
}));

let root: string;
const loaded: Array<{ dispose(): Promise<void> }> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ws-standalone-plugins-'));
  mailbox.close.mockClear();
});

afterEach(async () => {
  for (const plugins of loaded.splice(0)) await plugins.dispose();
  await rm(root, { recursive: true, force: true });
});

function makeLogger(): Logger {
  const logger: Logger = {
    level: 'info',
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return logger;
}

async function load(overrides: Partial<Config> = {}, setup?: typeof setupPlugins) {
  const projectRoot = join(root, 'project');
  const wpaths = resolveWstackPaths({ projectRoot, globalRoot: join(root, 'home') });
  const config = {
    ...CONFIG_BEHAVIOR_DEFAULTS,
    provider: 'fixture',
    model: 'fixture-model',
    ...overrides,
  } as Config;
  const container = new Container();
  container.bind(TOKENS.ConfigStore, () => new DefaultConfigStore(config));
  const toolRegistry = new ToolRegistry();
  const hookRegistry = new HookRegistry();
  const logger = makeLogger();
  const agent = {
    extensions: new ExtensionRegistry(),
    ctx: { provider: { id: 'fixture', capabilities: {} }, model: 'fixture-model' },
  } as unknown as Agent;
  const session = {
    id: 'tab-1',
    transcriptPath: join(root, 'tab-1.jsonl'),
    append: vi.fn(async () => undefined),
  } as unknown as SessionWriter;
  const plugins = await loadStandalonePlugins({
    config,
    getConfig: () => config,
    container,
    events: new EventBus(),
    pipelines: createDefaultPipelines(),
    toolRegistry,
    providerRegistry: new ProviderRegistry(),
    modelsRegistry: {} as ModelsRegistry,
    hookRegistry,
    logger,
    wpaths,
    agent,
    getSession: () => session,
    safeMode: false,
    setup,
  });
  loaded.push(plugins);
  const names = plugins.host?.loaded.map((plugin) => plugin.name) ?? [];
  return { plugins, names, toolRegistry, hookRegistry, logger, agent };
}

describe('standalone host plugin set', () => {
  it('loads the default-on plugins the CLI loads, and their hooks guard the tool pipeline', async () => {
    const { names, toolRegistry, hookRegistry, logger } = await load();

    for (const name of [
      'injection-shield',
      'adversary-mode',
      'secret-scanner',
      'dep-guard',
      'error-lens',
      'context-pins',
      'wstack-prompts',
      'wstack-skills',
    ]) {
      expect(names, name).toContain(name);
    }
    // Opt-in plugins stay off by default, as in the CLI.
    expect(names).not.toContain('path-guard');
    expect(names).not.toContain('telegram');
    // Served by the standalone Chimera owner, never loaded twice — and said so.
    expect(names).not.toContain('wstack-chimera');
    expect(names).not.toContain('wstack-auto-review');
    expect(vi.mocked(logger.info).mock.calls.map(([message]) => String(message))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('built-in plugin "wstack-chimera" is served by this host'),
        expect.stringContaining('built-in plugin "wstack-auto-review" is served by this host'),
      ]),
    );

    expect(toolRegistry.get('secret_scanner_status')).toBeDefined();
    expect(toolRegistry.get('injection_shield_status')).toBeDefined();
    // secret-scanner's PreToolUse policy hook sits on the registry the executor runs.
    const runner = new HookRunner({ registry: hookRegistry });
    const blocked = await runner.preToolUse(
      'write',
      { path: 'config.ts', content: 'const key = "AKIAIOSFODNN7EXAMPLE";' },
      { cwd: root, session: { id: 'tab-1' } },
    );
    expect(blocked.block).toBe(true);
  });

  it('loads the set the CLI loads, minus only the built-ins it serves itself', async () => {
    const standalone = await load();
    // The CLI host calls the same loader with no host-owned built-ins (cli/src/wiring/plugins.ts).
    const cli = await load({}, (deps) => setupPlugins({ ...deps, hostOwnedBuiltins: undefined }));

    expect(cli.names).toEqual(expect.arrayContaining(['wstack-chimera', 'wstack-auto-review']));
    expect(standalone.names).toEqual(
      cli.names.filter((name) => !Object.hasOwn(STANDALONE_HOST_OWNED_PLUGINS, name)),
    );
  });

  it('does not load a plugin the user disabled, by either switch', async () => {
    const { names } = await load({
      plugins: [{ name: 'secret-scanner', enabled: false }],
      extensions: { 'injection-shield': { enabled: false } },
    } as Partial<Config>);

    expect(names).not.toContain('secret-scanner');
    expect(names).not.toContain('injection-shield');
    expect(names).toContain('dep-guard');
  });

  it('loads an opt-in plugin the user enabled', async () => {
    const { names } = await load({ plugins: [{ name: 'path-guard' }] } as Partial<Config>);
    expect(names).toContain('path-guard');
  });

  it('loads nothing when features.plugins is off', async () => {
    const { plugins, toolRegistry } = await load({
      features: { ...CONFIG_BEHAVIOR_DEFAULTS.features, plugins: false },
    } as Partial<Config>);
    expect(plugins.host).toBeUndefined();
    expect(toolRegistry.get('secret_scanner_status')).toBeUndefined();
  });

  it('dispose tears down the plugins hooks, tools, mirrored extensions and the mailbox', async () => {
    const { plugins, toolRegistry, hookRegistry, agent } = await load();
    const laterTab = new ExtensionRegistry();
    plugins.attach({ extensions: laterTab } as unknown as Agent);
    // context-pins contributes to every conversation's system prompt, not only the first.
    expect(laterTab.listSystemPromptContributors()).toHaveLength(
      agent.extensions.listSystemPromptContributors().length,
    );
    expect(laterTab.listSystemPromptContributors().length).toBeGreaterThan(0);
    expect(hookRegistry.countByOwner('secret-scanner')).toBeGreaterThan(0);

    await plugins.dispose();
    await plugins.dispose();

    expect(plugins.host?.disposed).toBe(true);
    expect(hookRegistry.countByOwner('secret-scanner')).toBe(0);
    expect(hookRegistry.countByOwner('injection-shield')).toBe(0);
    expect(toolRegistry.get('secret_scanner_status')).toBeUndefined();
    expect(laterTab.listSystemPromptContributors()).toHaveLength(0);
    expect(agent.extensions.listSystemPromptContributors()).toHaveLength(0);
    expect(mailbox.close).toHaveBeenCalledOnce();
  });

  it('names a reason for every built-in it does not load through the shared loader', () => {
    expect(Object.keys(STANDALONE_HOST_OWNED_PLUGINS).sort()).toEqual([
      'wstack-auto-review',
      'wstack-chimera',
      'wstack-specialist-triggers',
    ]);
  });
});

describe('PluginExtensionFanout', () => {
  it('mirrors plugin extensions onto every conversation and removes them everywhere', () => {
    const onError = vi.fn();
    const fanout = new PluginExtensionFanout(onError);
    const first = new ExtensionRegistry();
    first.register({ name: 'fallback-model' });
    fanout.attach(first);
    const off = fanout.register({ name: 'llm-cache' });
    fanout.registerOrReplace({ name: 'fallback-model' });
    const later = new ExtensionRegistry();
    fanout.attach(later);
    fanout.attach(later);

    // A plugin's replacement is scoped on each conversation, as through api.extensions.
    expect(first.list()).toEqual(['llm-cache', 'fallback-model']);
    expect(later.list()).toEqual(['llm-cache', 'fallback-model']);
    expect(onError).not.toHaveBeenCalled();

    off();
    expect(first.list()).toEqual(['fallback-model']);
    expect(later.list()).toEqual(['fallback-model']);

    fanout.clear();
    // The conversation's own extension survives the plugins' replacement going away.
    expect(first.list()).toEqual(['fallback-model']);
    expect(later.list()).toEqual([]);
  });

  it('reports a conversation that refuses a duplicate name without failing the others', () => {
    const onError = vi.fn();
    const fanout = new PluginExtensionFanout(onError);
    const owner = new ExtensionRegistry();
    owner.register({ name: 'token-throttle' });
    const other = new ExtensionRegistry();
    fanout.attach(owner);
    fanout.attach(other);
    fanout.register({ name: 'token-throttle' });
    expect(other.list()).toEqual(['token-throttle']);
    expect(onError).toHaveBeenCalledOnce();
    expect(fanout.unregister('token-throttle')).toBe(true);
    expect(other.list()).toEqual([]);
    expect(owner.list()).toEqual(['token-throttle']);
  });
});

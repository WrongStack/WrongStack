import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { ProviderAuthStrategy } from '@wrongstack/contracts/types/provider-auth';
import type { SlashCommand } from '@wrongstack/contracts/types/slash-command';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry } from '../../src/extension/registry.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultPluginAPI, type PluginAPIInit } from '../../src/plugin/api.js';
import { loadPlugins } from '../../src/plugin/loader.js';
import { ProviderAuthRegistry } from '../../src/registry/provider-auth-registry.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { SlashCommandRegistry } from '../../src/registry/slash-command-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';

function tool(name: string): Tool {
  return {
    name,
    description: '',
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    async execute() {
      return 'base';
    },
  };
}

function setup() {
  const tools = new ToolRegistry();
  const providers = new ProviderRegistry();
  const auth = new ProviderAuthRegistry();
  const commands = new SlashCommandRegistry();
  const extensions = new ExtensionRegistry();
  const configOff = vi.fn();
  const configStore = { watch: vi.fn(() => configOff) };
  const create = (ownerName = 'test') =>
    new DefaultPluginAPI({
      ownerName,
      official: true,
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as PluginAPIInit['pipelines'],
      toolRegistry: tools,
      providerRegistry: providers,
      providerAuthRegistry: auth,
      slashCommandRegistry: commands,
      extensions,
      configStore,
      config: { providers: {}, log: { level: 'error' } } as PluginAPIInit['config'],
      log: new DefaultLogger({ level: 'error' }),
    });
  return { tools, providers, auth, commands, extensions, configStore, configOff, create };
}

const command = (name: string): SlashCommand => ({
  name,
  description: '',
  aliases: ['alias'],
  async run() {
    return {};
  },
});
const strategy = (label: string): ProviderAuthStrategy => ({
  id: 'test-auth',
  providerId: 'test',
  label,
  aliases: ['login-test'],
  interactionTypes: ['browser'],
  async begin() {
    throw new Error('unused');
  },
});

describe('plugin-owned registrations', () => {
  it('rolls back registrations when setup fails and teardown throws', async () => {
    const h = setup();
    const handle = await loadPlugins(
      [
        {
          name: 'failed',
          apiVersion: '^0.1',
          setup(api) {
            api.tools.register(tool('half-loaded'));
            api.extensions.register({ name: 'half-loaded' });
            throw new Error('setup failed');
          },
          teardown() {
            throw new Error('teardown failed');
          },
        },
      ],
      { apiFactory: () => h.create(), log: new DefaultLogger({ level: 'error' }) },
    );
    expect(handle.failed).toHaveLength(1);
    expect(h.tools.get('half-loaded')).toBeUndefined();
    expect(h.extensions.has('half-loaded')).toBe(false);
  });

  it('drops a contributor result that finishes after its plugin unloads', async () => {
    const h = setup();
    const api = h.create();
    let resolve!: (blocks: Array<{ type: 'text'; text: string }>) => void;
    const pending = new Promise<Array<{ type: 'text'; text: string }>>((done) => {
      resolve = done;
    });
    api.registerSystemPromptContributor(async () => pending);
    const contribution = h.extensions.listSystemPromptContributors()[0]!({} as never);
    api.drainCleanup();
    resolve([{ type: 'text', text: 'late plugin instruction' }]);
    expect(await contribution).toEqual([]);
  });
  it('drains tool, extension, prompt, provider, auth, command and config registrations without teardown', () => {
    const h = setup();
    const api = h.create();
    api.tools.register(tool('owned'));
    api.extensions.register({ name: 'owned-extension' });
    api.registerSystemPromptContributor(async () => [{ type: 'text', text: 'owned-prompt' }]);
    api.providers.register({
      type: 'owned-provider',
      family: 'openai',
      create: () => {
        throw new Error('unused');
      },
    });
    api.providerAuth.register(strategy('Owned'));
    api.slashCommands.register(command('owned-command'));
    api.onConfigChange(() => {});
    api.drainCleanup();
    api.drainCleanup();
    expect(h.tools.get('owned')).toBeUndefined();
    expect(h.extensions.list()).toEqual([]);
    expect(h.extensions.listSystemPromptContributors()).toEqual([]);
    expect(h.providers.has('owned-provider')).toBe(false);
    expect(h.auth.has('login-test')).toBe(false);
    expect(h.commands.list()).toEqual([]);
    expect(h.configOff).toHaveBeenCalledTimes(2);
    expect(() => api.tools.register(tool('late'))).toThrow('unloaded');
    expect(() => api.extensions.register({ name: 'late' })).toThrow('unloaded');
    const replacement = h.create('test');
    replacement.tools.register(tool('owned'));
    expect(() => api.tools.unregister('owned')).toThrow('unloaded');
    expect(h.tools.get('owned')).toBeDefined();
    expect(() => api.extensions.clear()).toThrow('unloaded');
  });

  it('removes a middle tool wrapper while preserving live wrappers and disabled state', async () => {
    const h = setup();
    h.tools.register(tool('read'));
    const a = h.create('a');
    const b = h.create('b');
    const wrap =
      (label: string) =>
      (original: Tool): Tool => ({
        ...original,
        async execute(input, ctx, opts) {
          return `${await original.execute(input, ctx, opts)}:${label}`;
        },
      });
    a.tools.wrap('read', wrap('a'));
    b.tools.wrap('read', wrap('b'));
    h.tools.disable('read');
    a.drainCleanup();
    expect(h.tools.isDisabled('read')).toBe(true);
    h.tools.enable('read');
    expect(
      await h.tools.get('read')!.execute({}, {} as never, { signal: new AbortController().signal }),
    ).toBe('base:b');
    expect(h.tools.ownerOf('read')).toBe('core+b');
    b.drainCleanup();
    expect(h.tools.ownerOf('read')).toBe('core');
  });

  it('does not resurrect an unloaded provider, auth strategy or slash command under a live override', () => {
    const h = setup();
    const base = command('status');
    h.commands.register(base);
    h.auth.register(strategy('Base'));
    h.providers.register({
      type: 'test',
      family: 'openai',
      create: () => ({ id: 'base' }) as never,
    });
    const a = h.create('a');
    const b = h.create('b');
    for (const api of [a, b]) {
      api.slashCommands.register(command('status'));
      api.providerAuth.register(strategy(api === a ? 'A' : 'B'));
      api.providers.register({
        type: 'test',
        family: 'openai',
        create: () => ({ id: api === a ? 'a' : 'b' }) as never,
      });
    }
    a.drainCleanup();
    expect(h.auth.get('login-test')?.label).toBe('B');
    expect(h.commands.ownerOf('status')).toBe('b');
    b.drainCleanup();
    expect(h.auth.get('login-test')?.label).toBe('Base');
    expect(h.commands.get('status')).toBe(base);
    expect(h.providers.create({ type: 'test' } as never).id).toBe('base');
  });

  it('preserves independent replacements made after registration', () => {
    const h = setup();
    const api = h.create();
    api.tools.register(tool('same'));
    h.tools.override('same', { ...tool('same'), description: 'new' });
    api.extensions.register({ name: 'same' });
    h.extensions.registerOrReplace({ name: 'same' });
    api.providerAuth.register(strategy('Old'));
    h.auth.register(strategy('New'));
    api.drainCleanup();
    expect(h.tools.get('same')?.description).toBe('new');
    expect(h.extensions.has('same')).toBe(true);
    expect(h.auth.get('test-auth')?.label).toBe('New');
  });

  it('restores a base extension after scoped overrides close in either order', () => {
    const h = setup();
    const beforeRun = vi.fn();
    h.extensions.register({ name: 'first' });
    h.extensions.register({ name: 'base', beforeRun });
    h.extensions.register({ name: 'last' });
    const a = h.create('a');
    const b = h.create('b');
    a.extensions.registerOrReplace({ name: 'base' });
    b.extensions.registerOrReplace({ name: 'base' });
    a.drainCleanup();
    b.drainCleanup();
    expect(h.extensions.has('base')).toBe(true);
    expect(h.extensions.list()).toEqual(['first', 'base', 'last']);
  });

  it('owns equal contributor functions independently and makes their disposers idempotent', () => {
    const h = setup();
    const contributor = async () => [{ type: 'text' as const, text: 'same' }];
    const a = h.create('a');
    const b = h.create('b');
    const off = a.registerSystemPromptContributor(contributor);
    b.registerSystemPromptContributor(contributor);
    off();
    off();
    expect(h.extensions.listSystemPromptContributors()).toHaveLength(1);
    a.drainCleanup();
    expect(h.extensions.listSystemPromptContributors()).toHaveLength(1);
    b.drainCleanup();
    expect(h.extensions.listSystemPromptContributors()).toHaveLength(0);
  });
});

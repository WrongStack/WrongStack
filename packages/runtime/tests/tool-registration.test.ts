import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { Container, EventBus } from '@wrongstack/core/kernel';
import { DefaultPluginAPI } from '@wrongstack/core/plugin';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import type { MemoryStore, Tool } from '@wrongstack/core/types';
import { LegacyMemoryPortAdapter } from '@wrongstack/sage';
import { describe, expect, it } from 'vitest';
import { registerCanonicalHostTools } from '../src/tool-registration.js';

const coordinationTool: Tool = {
  name: 'coordination-test',
  description: 'Test coordination tool.',
  inputSchema: { type: 'object', properties: {} },
  permission: 'auto',
  mutating: false,
  async execute() {
    return 'ok';
  },
};

function legacyMemoryStore(): MemoryStore {
  const store: MemoryStore = {
    async readAll() {
      return '';
    },
    async read() {
      return '';
    },
    async remember() {},
    async forget() {
      return 0;
    },
    async consolidate() {},
    async clear() {},
    async list() {
      return [];
    },
    async search() {
      return [];
    },
    withTraceId() {
      return store;
    },
  };
  return store;
}

describe('canonical host tool registration', () => {
  it('keeps the normal leader direct surface bounded while retaining lazy tools', () => {
    const registry = new ToolRegistry();
    const context = { ...coordinationTool, name: 'context_manager' };
    const coordination = ['mailbox', 'mail_send', 'mail_inbox', 'fleet_status'].map((name) => ({
      ...coordinationTool,
      name,
    }));
    registerCanonicalHostTools({
      registry,
      tier: 'medium',
      contextTool: context,
      memory: { enabled: true, store: new LegacyMemoryPortAdapter(legacyMemoryStore()) },
      coordinationTools: coordination,
    });
    for (const name of ['skill', 'delegate', 'mcp_control', 'mcp_use']) {
      registry.register({ ...coordinationTool, name });
      registry.exposeToProvider(name);
    }

    // 68 built-ins + context + 4 legacy-memory + 4 coordination + 4 host
    // gateways stay executable, but only the bounded 55-schema surface is sent
    // directly to the provider.
    expect(registry.list()).toHaveLength(81);
    expect(registry.listForProvider()).toHaveLength(55);
    expect(registry.get('browser_open')).toBeDefined();
    expect(registry.listForProvider().map((tool) => tool.name)).not.toContain('browser_open');
  });

  it('exposes plugin-registered tools to the provider under a token-saving tier', () => {
    // Integration regression for the plugin provider-surface gap: when the
    // host restricts the direct provider surface (tier !== 'off'), tools
    // registered through DefaultPluginAPI must still reach the LLM. The
    // plugin API calls ToolRegistry.exposeToProvider on every register.
    const registry = new ToolRegistry();
    registerCanonicalHostTools({
      registry,
      tier: 'medium',
      memory: { enabled: false, store: null },
    });
    const directCount = registry.listForProvider().length;
    const pluginTool = { ...coordinationTool, name: 'gitignore_guard_test' };
    const api = new DefaultPluginAPI({
      ownerName: 'gitignore-guard',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry: registry,
      providerRegistry: new ProviderRegistry(),
      config: {} as never,
      log: new DefaultLogger({ level: 'error' }),
    });

    api.tools.register(pluginTool);

    expect(registry.listForProvider().map((tool) => tool.name)).toContain('gitignore_guard_test');
    expect(registry.listForProvider()).toHaveLength(directCount + 1);
    // The restricted built-in surface is otherwise unchanged.
    expect(registry.listForProvider().map((tool) => tool.name)).not.toContain('browser_open');
  });

  it('applies tier selection, legacy memory, coordination, and disabled policy', () => {
    const registry = new ToolRegistry();

    const result = registerCanonicalHostTools({
      registry,
      tier: 'minimal',
      memory: { enabled: true, store: new LegacyMemoryPortAdapter(legacyMemoryStore()) },
      coordinationTools: [coordinationTool],
      disabledTools: ['grep'],
    });

    expect(result.memoryBackend).toBe('legacy');
    expect(result.builtinTools.map((tool) => tool.name)).toContain('read');
    expect(result.builtinTools.map((tool) => tool.name)).not.toContain('exec');
    expect(registry.list().map((tool) => tool.name)).toContain('exec');
    expect(registry.listForProvider().map((tool) => tool.name)).not.toContain('exec');
    expect(registry.listForProvider().map((tool) => tool.name)).toContain('tool_search');
    expect(registry.get('remember')).toBeDefined();
    expect(registry.get('coordination-test')).toBe(coordinationTool);
    expect(registry.get('grep')).toBeUndefined();
  });

  it('does not register memory tools when memory is disabled', () => {
    const registry = new ToolRegistry();

    const result = registerCanonicalHostTools({
      registry,
      tier: 'minimal',
      memory: { enabled: false, store: new LegacyMemoryPortAdapter(legacyMemoryStore()) },
    });

    expect(result.memoryBackend).toBe('disabled');
    expect(registry.get('remember')).toBeUndefined();
  });

  it('registers context and SAGE tools while defaulting optional tool lists', () => {
    const registry = new ToolRegistry();
    const sagePort = {
      getCapability: () => ({
        remember: async () => undefined,
        forget: async () => 0,
        search: async () => [],
        related: async () => [],
      }),
    } as never;

    const result = registerCanonicalHostTools({
      registry,
      tier: 'minimal',
      contextTool: coordinationTool,
      memory: { enabled: true, store: sagePort },
    });

    expect(result.memoryBackend).toBe('sage');
    expect(registry.get('coordination-test')).toBe(coordinationTool);
    expect(registry.get('search_memory')).toBeDefined();
    expect(registry.get('find_related_memories')).toBeDefined();
  });

  it('leaves the nextsteps tool unregistered by default', () => {
    const registry = new ToolRegistry();

    registerCanonicalHostTools({ registry, tier: 'minimal' });

    // Opt-in: an omitted `nextSteps` option must behave exactly like `off`, so
    // the existing `<nextsteps>` block stays the only route for every host that
    // has not been updated.
    expect(registry.get('nextsteps')).toBeUndefined();
  });

  it('leaves the nextsteps tool unregistered when explicitly disabled', () => {
    const registry = new ToolRegistry();

    registerCanonicalHostTools({ registry, tier: 'minimal', nextSteps: { enabled: false } });

    expect(registry.get('nextsteps')).toBeUndefined();
  });

  it('registers the nextsteps tool when enabled, regardless of tier', () => {
    const registry = new ToolRegistry();

    registerCanonicalHostTools({ registry, tier: 'minimal', nextSteps: { enabled: true } });

    // Not part of any tier list — the toggle alone decides, so a token-saving
    // tier cannot silently drop a tool the user turned on.
    expect(registry.get('nextsteps')?.name).toBe('nextsteps');
  });

  it('keeps memory disabled when enabled without a store', () => {
    const result = registerCanonicalHostTools({
      registry: new ToolRegistry(),
      tier: 'minimal',
      memory: { enabled: true, store: null },
    });

    expect(result.memoryBackend).toBe('disabled');
  });
});

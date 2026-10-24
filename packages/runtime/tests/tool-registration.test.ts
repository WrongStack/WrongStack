import { Container, EventBus } from '@wrongstack/contracts/kernel';
import type { MemoryStore, Tool } from '@wrongstack/contracts/types';
import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { DefaultPluginAPI } from '@wrongstack/core/plugin';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { LegacyMemoryPortAdapter } from '@wrongstack/sage';
import { builtinToolsPack } from '@wrongstack/tools';
import { toolSearchTool } from '@wrongstack/tools/tool-search';
import { BUILTIN_TIER_COUNTS } from '@wrongstack/tools/tool-tier';
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

    // Every built-in stays executable, but only a bounded schema surface is
    // sent directly to the provider. `tool_search` / `tool_use` are inside the
    // built-in count and on the direct surface at every tier: they are how the
    // model reaches the tools the tier withheld.
    //
    // Counts are DERIVED from the catalog and the tier arrays, never
    // hand-written. A hardcoded total made this test fail on any concurrent
    // catalog edit (adding one built-in moved the real count 80 -> 81 while
    // the literal stayed 80), which reads exactly like cross-suite state
    // corruption under the full gate but is not: the root vitest pool is
    // `forks`, one child process per file, so no other suite can mutate
    // this registry. Deriving the numbers keeps the real invariant (the
    // surface stays bounded and consistent) without the edit race.
    const builtins = builtinToolsPack.tools.length;
    const legacyMemory = 4; // remember, forget, search_memory, find_related_memories
    const hostGateways = 4; // skill, delegate, mcp_control, mcp_use (below)
    expect(registry.list()).toHaveLength(
      builtins + 1 /* context */ + legacyMemory + coordination.length + hostGateways,
    );

    const directNames = registry.listForProvider().map((tool) => tool.name);
    // The host adds `memory_search` to the direct set, but the legacy backend
    // registers `find_related_memories` under that slot instead — so count the
    // memory names the registry actually holds rather than the names the host
    // requested. `tool_search` / `tool_use` need no term: they are already
    // inside BUILTIN_TIER_COUNTS.medium via TIER1, so the Set dedupes them.
    const memoryDirect = ['remember', 'search_memory', 'memory_search'].filter((name) =>
      registry.get(name),
    ).length;
    expect(directNames).toHaveLength(
      BUILTIN_TIER_COUNTS.medium +
        1 /* context */ +
        memoryDirect +
        coordination.length +
        hostGateways,
    );
    expect(registry.get('browser_open')).toBeDefined();
    expect(registry.get('tool_script')).toBeDefined();
    expect(directNames).not.toContain('browser_open');
    expect(directNames).toContain('tool_script');
  });

  it('registers the real skill tool on the direct surface when a skill loader is given', async () => {
    // Regression: the host wiring that registered `skill` was deleted with a
    // dead parallel wiring module, while the default progressive manifest kept
    // telling the model to "call the `skill` tool" — every skill was unloadable.
    const manifest = {
      name: 'demo-skill',
      description: 'Demo skill.',
      path: 'C:/skills/demo-skill/SKILL.md',
    } as never;
    const loader = {
      list: async () => [manifest],
      listEntries: async () => [],
      find: async (name: string) => (name === 'demo-skill' ? manifest : undefined),
      readBody: async () => '---\nname: demo-skill\n---\n# Demo body',
    } as never;
    for (const tier of ['minimal', 'off'] as const) {
      const registry = new ToolRegistry();
      registerCanonicalHostTools({ registry, tier, skillLoader: loader });
      expect(registry.isExposedToProvider('skill'), `tier ${tier}`).toBe(true);
    }

    const registry = new ToolRegistry();
    registerCanonicalHostTools({ registry, tier: 'minimal' });
    expect(registry.get('skill')).toBeUndefined();
  });

  it('keeps every enabled lazy tool discoverable with an invocation schema', async () => {
    const registry = new ToolRegistry();
    registerCanonicalHostTools({ registry, tier: 'minimal' });
    const direct = registry.listForProvider();
    const catalog = registry.list();
    const directNames = new Set(direct.map((tool) => tool.name));
    const lazy = catalog.filter((tool) => !directNames.has(tool.name));
    const ctx = {
      cwd: 'C:/project',
      projectRoot: 'C:/project',
      tools: direct,
      catalogTools: catalog,
    } as never;

    expect([...directNames]).toEqual(expect.arrayContaining(['tool_search', 'tool_use']));
    expect(lazy.length).toBeGreaterThan(0);
    for (const expected of lazy) {
      const result = await toolSearchTool.execute({ query: expected.name, limit: 100 }, ctx, {
        signal: new AbortController().signal,
      });
      const discovered = result.tools.find((tool) => tool.name === expected.name);
      expect(discovered?.inputSchema, `${expected.name} has no lazy invocation schema`).toEqual(
        expected.inputSchema,
      );
    }
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
    expect(registry.listForProvider().map((tool) => tool.name)).toContain('remember');
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

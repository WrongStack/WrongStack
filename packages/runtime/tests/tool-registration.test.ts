import { ToolRegistry } from '@wrongstack/core/registry';
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

import { ToolRegistry } from '@wrongstack/core/registry';
import { describe, expect, it, vi } from 'vitest';

/**
 * Pins the CLI adapter contract around canonical host tool registration:
 *
 *   1. The builtin tool pack is always registered (memory
 *      feature flag does not gate it).
 *   2. The context manager tool is always registered as a
 *      "default" tool, with the compactor passed through.
 *   3. The four memory tools (remember / forget / search /
 *      related) are only registered when both
 *      `config.features.memory === true` AND
 *      `memoryStore` is truthy. If memoryStore is null
 *      (the runtime null-case when the store is not yet
 *      bound), the memory tools are skipped silently.
 *   4. The coordination tools (mailbox / mail_send /
 *      mail_inbox / fleet_status) are always registered, regardless of
 *      the memory feature flag, with the events bus passed
 *      through.
 *
 * The test uses a fake `ToolRegistry` to assert adapter delegation without
 * coupling to the concrete registry implementation.
 */

const { registerBuiltinTools } = await import('../../src/boot/tool-registry.js');

function makeFakeToolRegistry() {
  const calls: { kind: string; toolName: string; isDefault: boolean; toolCount?: number }[] = [];
  return {
    registry: {
      registerAllOrThrow: vi.fn((tools: unknown[], packName: string) => {
        calls.push({ kind: 'bulk', toolName: packName, isDefault: false, toolCount: tools.length });
      }),
      registerDefault: vi.fn((_tool: unknown) => {
        calls.push({ kind: 'default', toolName: '<default>', isDefault: true });
      }),
      register: vi.fn((_tool: unknown) => {
        // Each tool factory is a function; we capture the
        // shape by storing the function reference. The
        // helper calls register(tool) with a tool instance.
        calls.push({ kind: 'single', toolName: '<tool>', isDefault: false });
      }),
      setProviderToolNames: vi.fn(),
      // The canonical registration path also configures the registry it is
      // handed. A fake that answers only the register* calls made
      // `registerCanonicalHostTools` throw on the first configuration step,
      // so none of the delegation this suite pins was ever reached.
      setEventBus: vi.fn(),
      applyDisabled: vi.fn(),
      applyDisabledMeta: vi.fn(),
    },
    calls,
  };
}

function makeEvents() {
  return { _kind: 'fakeEvents' };
}

function makeWpaths() {
  return { projectDir: '/tmp/project' };
}

describe('registerBuiltinTools', () => {
  it('always registers the builtin tool pack and the context manager default', () => {
    const { registry, calls } = makeFakeToolRegistry();
    registerBuiltinTools({
      toolRegistry: registry as never,
      compactor: { _kind: 'fakeCompactor' },
      config: { features: { memory: false } },
      memoryStore: null,
      events: makeEvents() as never,
      wpaths: makeWpaths() as never,
    });
    expect(calls.some((c) => c.kind === 'bulk')).toBe(true);
    expect(calls.some((c) => c.kind === 'default')).toBe(true);
  });

  it('skips memory tools when config.features.memory is false', () => {
    const { registry, calls } = makeFakeToolRegistry();
    registerBuiltinTools({
      toolRegistry: registry as never,
      compactor: {},
      config: { features: { memory: false } },
      memoryStore: { _kind: 'fakeStore', getCapability: () => undefined } as never,
      events: makeEvents() as never,
      wpaths: makeWpaths() as never,
    });
    // Exactly four single-tool registrations: mailbox,
    // mail_send, mail_inbox, fleet_status. No memory tools.
    const singles = calls.filter((c) => c.kind === 'single');
    expect(singles).toHaveLength(4);
  });

  it('skips memory tools when memoryStore is null even if features.memory is true', () => {
    const { registry, calls } = makeFakeToolRegistry();
    registerBuiltinTools({
      toolRegistry: registry as never,
      compactor: {},
      config: { features: { memory: true } },
      memoryStore: null,
      events: makeEvents() as never,
      wpaths: makeWpaths() as never,
    });
    // Memory flag is on but the store is null \u2014 the helper
    // silently skips the memory tools. This matches the
    // pre-refactor inline behavior: `if
    // (config.features.memory)` would have crashed with
    // a TypeError on `rememberTool(memoryStore)` when
    // memoryStore is null. The refactor tightens this:
    // features.memory && memoryStore \u2014 the null case
    // is now a no-op.
    const singles = calls.filter((c) => c.kind === 'single');
    expect(singles).toHaveLength(4);
  });

  it('registers all four memory tools when features.memory is true AND memoryStore is provided', () => {
    const { registry, calls } = makeFakeToolRegistry();
    registerBuiltinTools({
      toolRegistry: registry as never,
      compactor: {},
      config: { features: { memory: true } },
      memoryStore: { _kind: 'fakeStore', getCapability: () => undefined } as never,
      events: makeEvents() as never,
      wpaths: makeWpaths() as never,
    });
    const memoryBatch = calls.find((c) => c.kind === 'bulk' && c.toolName === 'legacy-memory');
    expect(memoryBatch?.toolCount).toBe(4);

    // Coordination tools remain individual host registrations.
    const singles = calls.filter((c) => c.kind === 'single');
    expect(singles).toHaveLength(4);
  });

  it('applies configured tool description modes to the real registry', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools({
      toolRegistry: registry,
      compactor: {},
      config: {
        features: { memory: false },
        tools: { descriptionMode: { read: 'simple' } },
      },
      memoryStore: null,
      events: makeEvents() as never,
      wpaths: makeWpaths() as never,
    });
    expect(registry.getDescriptionMode('read')).toBe('simple');
  });

  it.each(['minimal', 'light', 'medium'] as const)(
    "registers the complete codebase index lifecycle in the '%s' tier",
    (tokenSavingMode) => {
      const registry = new ToolRegistry();
      registerBuiltinTools({
        toolRegistry: registry,
        compactor: {},
        config: { features: { memory: false, tokenSavingMode } },
        memoryStore: null,
        events: makeEvents() as never,
        wpaths: makeWpaths() as never,
      });

      expect(registry.get('codebase-stats')).toBeDefined();
      expect(registry.get('codebase-search')).toBeDefined();
      expect(registry.get('codebase-index')).toBeDefined();
    },
  );
});

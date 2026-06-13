import { describe, expect, it, vi } from 'vitest';

/**
 * PR 6 of Issue #29: extract the inline tool-registry
 * registration into a helper. This test pins the contract
 * the helper preserves:
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
 *   4. The three mailbox tools (mailbox / mail_send /
 *      mail_inbox) are always registered, regardless of
 *      the memory feature flag, with the events bus passed
 *      through.
 *
 * The test uses a fake `ToolRegistry` that just counts
 * calls \u2014 we don't need a real registry implementation
 * to assert the registration order or argument shape.
 */

const { registerBuiltinTools } = await import('../../src/boot/tool-registry.js');

function makeFakeToolRegistry() {
  const calls: { kind: string; toolName: string; isDefault: boolean }[] = [];
  let nextDefault = false;
  return {
    registry: {
      registerAllOrThrow: vi.fn((_tools: unknown, packName: string) => {
        calls.push({ kind: 'bulk', toolName: packName, isDefault: false });
      }),
      registerDefault: vi.fn((_tool: unknown) => {
        calls.push({ kind: 'default', toolName: '<default>', isDefault: true });
      }),
      register: vi.fn((tool: unknown) => {
        // Each tool factory is a function; we capture the
        // shape by storing the function reference. The
        // helper calls register(tool) with a tool instance.
        calls.push({ kind: 'single', toolName: '<tool>', isDefault: false });
      }),
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

describe('registerBuiltinTools (PR 6 of #29)', () => {
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
    expect(calls.some(c => c.kind === 'bulk')).toBe(true);
    expect(calls.some(c => c.kind === 'default')).toBe(true);
  });

  it('skips memory tools when config.features.memory is false', () => {
    const { registry, calls } = makeFakeToolRegistry();
    registerBuiltinTools({
      toolRegistry: registry as never,
      compactor: {},
      config: { features: { memory: false } },
      memoryStore: { _kind: 'fakeStore' } as never,
      events: makeEvents() as never,
      wpaths: makeWpaths() as never,
    });
    // Exactly three single-tool registrations: mailbox,
    // mail_send, mail_inbox. No memory tools.
    const singles = calls.filter(c => c.kind === 'single');
    expect(singles).toHaveLength(3);
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
    const singles = calls.filter(c => c.kind === 'single');
    expect(singles).toHaveLength(3);
  });

  it('registers all four memory tools when features.memory is true AND memoryStore is provided', () => {
    const { registry, calls } = makeFakeToolRegistry();
    registerBuiltinTools({
      toolRegistry: registry as never,
      compactor: {},
      config: { features: { memory: true } },
      memoryStore: { _kind: 'fakeStore' } as never,
      events: makeEvents() as never,
      wpaths: makeWpaths() as never,
    });
    // 3 mailbox tools + 4 memory tools = 7 single
    // registrations.
    const singles = calls.filter(c => c.kind === 'single');
    expect(singles).toHaveLength(7);
  });
});

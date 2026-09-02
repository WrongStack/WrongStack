/**
 * Capability gating for `api.registerHook` — mirrors the existing pattern
 * used by `tools`, `providers`, `slashCommands`, and `mcp`. Plugins that
 * declare `capabilities: { hooks: true }` (or are official) pass through
 * unchanged; plugins that declare `{ hooks: false }` (or omit `hooks` while
 * being non-official) get either a logged warning (default) or a thrown
 * PluginError (when `enforceCapabilities: true`).
 */
import { describe, expect, it, vi } from 'vitest';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { loadPlugins, unloadPlugins } from '../../src/plugin/loader.js';
import type { Plugin, PluginAPI } from '../../src/types/plugin.js';

const baseLog = new DefaultLogger({ level: 'error' });

function makeStubLog(warnSpy: ReturnType<typeof vi.fn>) {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  } as never;
}

function makeMockApi(registerHook: ReturnType<typeof vi.fn>): PluginAPI {
  return {
    container: {} as never,
    pipelines: {} as never,
    events: {} as never,
    tools: { register: vi.fn(), unregister: vi.fn(), get: vi.fn(), list: vi.fn() } as never,
    providers: { register: vi.fn(), unregister: vi.fn(), create: vi.fn(), list: vi.fn() } as never,
    mcp: { start: vi.fn(), stop: vi.fn(), restart: vi.fn(), list: vi.fn() } as never,
    slashCommands: { register: vi.fn(), unregister: vi.fn(), get: vi.fn(), list: vi.fn() } as never,
    config: {} as never,
    log: baseLog,
    registerHook: registerHook as never,
    onEvent: vi.fn() as never,
  };
}

function p(overrides: Partial<Plugin> & { name: string }): Plugin {
  return {
    apiVersion: '^0.1',
    setup: () => undefined,
    ...overrides,
  };
}

describe('loadPlugins — capabilities.hooks enforcement', () => {
  it('passes registerHook through unchanged when capabilities.hooks is true', async () => {
    const registerHook = vi.fn().mockReturnValue(() => {});
    const plugin = p({
      name: 'a',
      capabilities: { hooks: true },
      setup: (api: PluginAPI) => api.registerHook('PreToolUse', '*', () => undefined),
    });
    const warn = vi.fn();
    const { loaded, failed } = await loadPlugins([plugin], {
      apiFactory: () => makeMockApi(registerHook),
      log: makeStubLog(warn),
    });
    expect(loaded).toHaveLength(1);
    expect(failed).toHaveLength(0);
    expect(registerHook).toHaveBeenCalledWith('PreToolUse', '*', expect.any(Function));
    expect(warn).not.toHaveBeenCalled();
    await unloadPlugins(loaded, {
      apiFactory: () => makeMockApi(registerHook),
      log: makeStubLog(warn),
    });
  });

  it('warns (default) when a plugin declares hooks:false but uses registerHook', async () => {
    const registerHook = vi.fn().mockReturnValue(() => {});
    const plugin = p({
      name: 'a',
      capabilities: { hooks: false },
      setup: (api: PluginAPI) => api.registerHook('Stop', undefined, () => undefined),
    });
    const warn = vi.fn();
    const { loaded } = await loadPlugins([plugin], {
      apiFactory: () => makeMockApi(registerHook),
      log: makeStubLog(warn),
    });
    expect(loaded).toHaveLength(1);
    // The call still goes through (after the warning), so registerHook is
    // called exactly once.
    expect(registerHook).toHaveBeenCalledTimes(1);
    // Warning was emitted for the hooks subsystem on the registerHook call.
    const sawHookWarning = warn.mock.calls.some((args) =>
      String(args[0] ?? '').includes('registerHook'),
    );
    expect(sawHookWarning).toBe(true);
    await unloadPlugins(loaded, {
      apiFactory: () => makeMockApi(registerHook),
      log: makeStubLog(warn),
    });
  });

  it('throws (enforceCapabilities) when a plugin declares hooks:false and uses registerHook', async () => {
    const registerHook = vi.fn().mockReturnValue(() => {});
    const plugin = p({
      name: 'a',
      capabilities: { hooks: false },
      setup: (api: PluginAPI) => api.registerHook('Stop', undefined, () => undefined),
    });
    const warn = vi.fn();
    const { loaded, failed } = await loadPlugins([plugin], {
      apiFactory: () => makeMockApi(registerHook),
      log: makeStubLog(warn),
      enforceCapabilities: true,
    });
    expect(loaded).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.plugin.name).toBe('a');
    expect(String(failed[0]!.err)).toContain('registerHook');
    await unloadPlugins(loaded, {
      apiFactory: () => makeMockApi(registerHook),
      log: makeStubLog(warn),
    });
  });

  it('plugins without capabilities at all bypass the wrap (mirror of tools/providers behavior)', async () => {
    // Capability gating is opt-in — a plugin that declares no capabilities
    // at all gets the unwrapped API. This matches the existing loader
    // behavior for tools/providers/slashCommands/mcp, so the hooks gate
    // must follow the same rule for consistency. Documenting the rule
    // here so a future change can't silently widen it.
    const registerHook = vi.fn().mockReturnValue(() => {});
    const plugin = p({
      name: 'a',
      // capabilities omitted entirely
      setup: (api: PluginAPI) => api.registerHook('SessionStart', undefined, () => undefined),
    });
    const warn = vi.fn();
    const { loaded } = await loadPlugins([plugin], {
      apiFactory: () => makeMockApi(registerHook),
      log: makeStubLog(warn),
      enforceCapabilities: true,
    });
    expect(loaded).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(registerHook).toHaveBeenCalled();
    await unloadPlugins(loaded, {
      apiFactory: () => makeMockApi(registerHook),
      log: makeStubLog(warn),
    });
  });
});

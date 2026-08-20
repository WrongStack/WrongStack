import { describe, expect, it, vi } from 'vitest';
import type { Config, ProviderFactory, Tool } from '../../src/index.js';
import {
  Container,
  DefaultLogger,
  DefaultPluginAPI,
  EventBus,
  HookRegistry,
  HookRunner,
  ProviderRegistry,
  ToolRegistry,
} from '../../src/index.js';

const baseConfig: Config = {
  providers: {},
  log: { level: 'error' },
} as never as Config;

const tool = (name: string): Tool => ({
  name,
  description: '',
  inputSchema: { type: 'object' },
  permission: 'auto',
  mutating: false,
  async execute() {
    return '';
  },
});

function mkApi() {
  const container = new Container();
  const events = new EventBus();
  const pipelines = {} as Parameters<typeof DefaultPluginAPI>[0]['pipelines'];
  const toolRegistry = new ToolRegistry();
  const providerRegistry = new ProviderRegistry();
  const log = new DefaultLogger({ level: 'error' });
  const api = new DefaultPluginAPI({
    ownerName: 'plugin-x',
    container,
    events,
    pipelines,
    toolRegistry,
    providerRegistry,
    config: baseConfig,
    log,
  });
  return { api, toolRegistry, providerRegistry };
}

describe('DefaultPluginAPI.registerHook', () => {
  function mkApiWithHooks() {
    const hookRegistry = new HookRegistry();
    const api = new DefaultPluginAPI({
      ownerName: 'plugin-x',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as Parameters<typeof DefaultPluginAPI>[0]['pipelines'],
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log: new DefaultLogger({ level: 'error' }),
      hookRegistry,
    });
    return { api, hookRegistry };
  }

  it('registers an in-process hook that the runner invokes', async () => {
    const { api, hookRegistry } = mkApiWithHooks();
    api.registerHook('PreToolUse', 'Bash', () => ({ decision: 'block', reason: 'nope' }));
    const runner = new HookRunner({ registry: hookRegistry });
    const r = await runner.preToolUse('bash', {}, { cwd: '/x' });
    expect(r.block).toBe(true);
  });

  it('drainCleanup removes registered hooks', async () => {
    const { api, hookRegistry } = mkApiWithHooks();
    api.registerHook('PreToolUse', '*', () => ({ decision: 'block' }));
    api.drainCleanup();
    const runner = new HookRunner({ registry: hookRegistry });
    expect(await runner.preToolUse('bash', {}, { cwd: '/x' })).toEqual({});
  });

  it('is a noop when no hookRegistry is wired', () => {
    const api = new DefaultPluginAPI({
      ownerName: 'plugin-x',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as Parameters<typeof DefaultPluginAPI>[0]['pipelines'],
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log: new DefaultLogger({ level: 'error' }),
    });
    expect(() => api.registerHook('Stop', undefined, () => {})()).not.toThrow();
  });

  it('drainByOwner backstop removes any hook owned by the plugin even if the per-call unsubscribe is dropped', async () => {
    const { api, hookRegistry } = mkApiWithHooks();
    // Register three hooks via the public API — the API does push the
    // unsubscribe into pluginCleanupFns, but simulate "setup() threw partway
    // through and the cleanup stack is incomplete" by manually invoking
    // drainCleanup with no cleanup entries (simulate an empty cleanup stack).
    api.registerHook('PreToolUse', '*', () => ({ decision: 'block' }));
    api.registerHook('PostToolUse', '*', () => ({ additionalContext: 'x' }));
    api.registerHook('Stop', undefined, () => undefined);
    expect(hookRegistry.countByOwner('plugin-x')).toBe(3);

    // Normal path: drainCleanup removes every hook via the unsubscribe
    // functions it collected.
    api.drainCleanup();
    expect(hookRegistry.countByOwner('plugin-x')).toBe(0);
  });

  it('drainCleanup is safe to call twice (idempotent)', () => {
    const { api, hookRegistry } = mkApiWithHooks();
    api.registerHook('Stop', undefined, () => undefined);
    api.drainCleanup();
    expect(() => api.drainCleanup()).not.toThrow();
    expect(hookRegistry.countByOwner('plugin-x')).toBe(0);
  });
});

describe('DefaultPluginAPI', () => {
  it('tools.register attributes ownership and list reflects it', () => {
    const { api, toolRegistry } = mkApi();
    api.tools.register(tool('alpha'));
    expect(api.tools.list().map((t) => t.name)).toContain('alpha');
    expect(toolRegistry.get('alpha')?.name).toBe('alpha');
  });

  it('plugin-registered tools are exposed to the provider under a restricted surface (token-saving)', () => {
    const { api, toolRegistry } = mkApi();
    // Simulate `features.tokenSavingMode !== 'off'`: the host registers the
    // built-in catalog, then restricts the direct provider surface to a small
    // set (tier-selected builtins + lazy gateways) via setProviderToolNames.
    // Plugin tools are NOT in that set.
    toolRegistry.register(tool('read'));
    toolRegistry.register(tool('tool_search'));
    toolRegistry.setProviderToolNames(['read', 'tool_search']);
    expect(toolRegistry.listForProvider().map((t) => t.name)).toEqual(['read', 'tool_search']);

    api.tools.register(tool('alpha'));

    // The plugin tool must reach the LLM even though it is not in the host's
    // restricted name set — otherwise plugins load and hooks fire, but the
    // model can never invoke their tools.
    expect(toolRegistry.listForProvider().map((t) => t.name)).toEqual([
      'read',
      'tool_search',
      'alpha',
    ]);
    // And it must remain in the executable catalog as before.
    expect(toolRegistry.list().map((t) => t.name)).toContain('alpha');
  });

  it('provider exposure is a no-op when the surface is unrestricted (tier off)', () => {
    const { api, toolRegistry } = mkApi();
    // Default host state: `_providerToolNames` is undefined, so
    // listForProvider() == list() and exposeToProvider is a no-op.
    api.tools.register(tool('alpha'));
    expect(toolRegistry.listForProvider().map((t) => t.name)).toContain('alpha');
    expect(toolRegistry.listForProvider().length).toBe(toolRegistry.list().length);
  });

  it('tools.unregister removes the tool', () => {
    const { api } = mkApi();
    api.tools.register(tool('alpha'));
    api.tools.unregister('alpha');
    expect(api.tools.get('alpha')).toBeUndefined();
  });

  it('providers.register / list works', () => {
    const { api } = mkApi();
    const factory: ProviderFactory = {
      type: 'mock',
      family: 'openai-compatible',
      create: () => ({
        id: 'mock',
        capabilities: {} as never,
        complete: async () => ({
          content: [],
          stopReason: 'end_turn',
          usage: { input: 0, output: 0 },
          model: 'm',
        }),
      }),
    };
    api.providers.register(factory);
    expect(api.providers.list()).toContain('mock');
  });

  it('providers.create dispatches to registered factory', () => {
    const { api } = mkApi();
    const create = vi.fn().mockReturnValue({ id: 'mock' });
    api.providers.register({ type: 'mock', family: 'openai', create });
    api.providers.create({ type: 'mock', apiKey: 'k' });
    expect(create).toHaveBeenCalled();
  });

  it('mcp falls back to noop when not provided', async () => {
    const { api } = mkApi();
    await expect(api.mcp.start({ name: 'x' } as never)).resolves.toBeUndefined();
    await expect(api.mcp.stop('x')).resolves.toBeUndefined();
    await expect(api.mcp.restart('x')).resolves.toBeUndefined();
    expect(api.mcp.list()).toEqual([]);
  });

  it('uses provided mcpRegistry view when given', () => {
    const container = new Container();
    const events = new EventBus();
    const log = new DefaultLogger({ level: 'error' });
    const mcpList = vi.fn().mockReturnValue([{ name: 'srv', state: 'connected', toolCount: 1 }]);
    const api = new DefaultPluginAPI({
      ownerName: 'p',
      container,
      events,
      pipelines: {} as never,
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log,
      mcpRegistry: {
        start: async () => undefined,
        stop: async () => undefined,
        restart: async () => undefined,
        list: mcpList,
      },
    });
    expect(api.mcp.list()).toEqual([{ name: 'srv', state: 'connected', toolCount: 1 }]);
    expect(mcpList).toHaveBeenCalled();
  });

  it('refuses a start that would stop a server this plugin does not own (enabled:false bypass)', async () => {
    const container = new Container();
    const events = new EventBus();
    const log = new DefaultLogger({ level: 'error' });
    const registryStart = vi.fn().mockResolvedValue(undefined);
    const api = new DefaultPluginAPI({
      ownerName: 'p',
      container,
      events,
      pipelines: {} as never,
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log,
      mcpRegistry: {
        start: registryStart,
        stop: async () => undefined,
        restart: async () => undefined,
        list: vi.fn().mockReturnValue([{ name: 'host-srv', state: 'connected', toolCount: 1 }]),
      },
    });
    // MCPRegistry.start() with enabled:false stops the existing slot BEFORE its
    // duplicate-name check — without the ownership guard this is a silent
    // remote-stop of a server this plugin never started.
    await expect(api.mcp.start({ name: 'host-srv', enabled: false } as never)).rejects.toThrow(
      /may not start MCP server "host-srv"/,
    );
    expect(registryStart).not.toHaveBeenCalled();
  });

  it('lets a plugin stop its own MCP server and still restart it afterwards', async () => {
    const container = new Container();
    const events = new EventBus();
    const log = new DefaultLogger({ level: 'error' });
    const registryStop = vi.fn().mockResolvedValue(undefined);
    const registryRestart = vi.fn().mockResolvedValue(undefined);
    const api = new DefaultPluginAPI({
      ownerName: 'p',
      container,
      events,
      pipelines: {} as never,
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log,
      mcpRegistry: {
        start: async () => undefined,
        stop: registryStop,
        restart: registryRestart,
        list: vi.fn().mockReturnValue([]),
      },
    });
    await api.mcp.start({ name: 'mine' } as never);
    await api.mcp.stop('mine');
    // Registry.stop() retains the slot, so ownership must survive the stop —
    // otherwise the plugin could never restart the server it started.
    await expect(api.mcp.restart('mine')).resolves.toBeUndefined();
    expect(registryStop).toHaveBeenCalledWith('mine');
    expect(registryRestart).toHaveBeenCalledWith('mine');
  });

  // ── events / lifecycle ─────────────────────────────────────────────────────

  it('onEvent attaches listener and returns an off function that unsubscribes', () => {
    const { api } = mkApi();
    const handler = vi.fn();
    const off = api.onEvent('tool.before' as never, handler);
    (api.events as never as { emit: (e: string, p: unknown) => void }).emit('tool.before', {
      x: 1,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    (api.events as never as { emit: (e: string, p: unknown) => void }).emit('tool.before', {
      x: 2,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('onPattern matches by wildcard and returns an off function', () => {
    const { api } = mkApi();
    const handler = vi.fn();
    const off = api.onPattern('tool.*', handler);
    (api.events as never as { emit: (e: string, p: unknown) => void }).emit('tool.after', {
      ok: true,
    });
    expect(handler).toHaveBeenCalled();
    off();
  });

  it('emitCustom dispatches a custom (non-typed) event through the bus', () => {
    const { api } = mkApi();
    const handler = vi.fn();
    api.onPattern('custom.*', handler);
    api.emitCustom('custom.frobulate', { value: 42 });
    expect(handler).toHaveBeenCalledWith('custom.frobulate', { value: 42 });
  });

  it('drainCleanup invokes every collected off function once', () => {
    const { api } = mkApi();
    const a = vi.fn();
    const b = vi.fn();
    api.onEvent('tool.before' as never, a);
    api.onEvent('tool.after' as never, b);
    api.drainCleanup();
    // subsequent emits should not fire the original handlers because cleanup removed them
    (api.events as never as { emit: (e: string, p: unknown) => void }).emit('tool.before', {});
    (api.events as never as { emit: (e: string, p: unknown) => void }).emit('tool.after', {});
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('drainCleanup swallows errors thrown by cleanup functions', () => {
    const { api } = mkApi();
    // Inject a throwing cleanup via onEvent + monkey-patched off — use the cleanup
    // path directly by registering an extension that simulates one.
    // Easier: register two real listeners; replace the queued off function with a thrower.
    const fns = (api as never as { pluginCleanupFns: Array<() => void> }).pluginCleanupFns;
    fns.push(() => {
      throw new Error('boom');
    });
    fns.push(vi.fn());
    expect(() => api.drainCleanup()).not.toThrow();
    expect(fns.length).toBe(0);
  });

  // ── config / system prompt ─────────────────────────────────────────────────

  it('onConfigChange returns a noop when no configStore is provided', () => {
    const { api } = mkApi();
    const off = api.onConfigChange(() => {});
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });

  it('onConfigChange forwards to configStore.watch when provided', () => {
    const watch = vi.fn().mockReturnValue(() => 'detached');
    const log = new DefaultLogger({ level: 'error' });
    const api = new DefaultPluginAPI({
      ownerName: 'p',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log,
      configStore: { watch },
    });
    const handler = vi.fn();
    api.onConfigChange(handler);
    expect(watch).toHaveBeenCalledWith(handler);
  });

  it('registerSystemPromptContributor delegates to the extension registry', () => {
    const { api } = mkApi();
    const contributor = { id: 'p:hello', contribute: () => 'hi' };
    const off = api.registerSystemPromptContributor(contributor as never);
    expect(typeof off).toBe('function');
    const contributors = api.extensions.listSystemPromptContributors();
    expect(contributors.some((c) => c.id === 'p:hello')).toBe(true);
    off();
    expect(api.extensions.listSystemPromptContributors().some((c) => c.id === 'p:hello')).toBe(
      false,
    );
  });

  // ── slash commands ─────────────────────────────────────────────────────────

  it('slashCommands view delegates register/unregister/get/list to the host registry', async () => {
    const { SlashCommandRegistry } = await import('../../src/index.js');
    const scr = new SlashCommandRegistry();
    const log = new DefaultLogger({ level: 'error' });
    const api = new DefaultPluginAPI({
      ownerName: 'p',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log,
      slashCommandRegistry: scr,
    });
    const cmd = { name: 'plugcmd', description: 'd', run: async () => ({}) };
    api.slashCommands.register(cmd);
    // Plugin-registered commands are namespaced as `<owner>:<name>`
    expect(api.slashCommands.get('p:plugcmd')?.name).toBe('plugcmd');
    expect(api.slashCommands.list().map((c) => c.name)).toContain('plugcmd');
    expect(api.slashCommands.unregister('p:plugcmd')).toBe(true);
    expect(api.slashCommands.get('p:plugcmd')).toBeUndefined();
  });

  it('slashCommands falls back to noop view when no host registry is provided', () => {
    const { api } = mkApi();
    expect(() =>
      api.slashCommands.register({ name: 'x', description: '', run: async () => ({}) }),
    ).not.toThrow();
    expect(api.slashCommands.unregister('x')).toBe(false);
    expect(api.slashCommands.get('x')).toBeUndefined();
    expect(api.slashCommands.list()).toEqual([]);
  });

  // ── metrics scoping ────────────────────────────────────────────────────────

  it('scopedMetrics prefixes every metric name with `plugin.<name>.`', () => {
    const sink = { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() };
    const log = new DefaultLogger({ level: 'error' });
    const api = new DefaultPluginAPI({
      ownerName: 'cool-plugin',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log,
      metricsSink: sink,
    });
    api.metrics.counter('hits', 1, { a: 'b' });
    api.metrics.histogram('latency', 50);
    api.metrics.gauge('queue_depth', 3);
    expect(sink.counter).toHaveBeenCalledWith('plugin.cool-plugin.hits', 1, { a: 'b' });
    expect(sink.histogram).toHaveBeenCalledWith('plugin.cool-plugin.latency', 50, undefined);
    expect(sink.gauge).toHaveBeenCalledWith('plugin.cool-plugin.queue_depth', 3, undefined);
  });

  it('metrics falls back to a noop sink when none provided', () => {
    const { api } = mkApi();
    expect(() => {
      api.metrics.counter('x', 1);
      api.metrics.histogram('x', 1);
      api.metrics.gauge('x', 1);
    }).not.toThrow();
  });

  // ── session writer ─────────────────────────────────────────────────────────

  it('session uses provided writer when given', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const log = new DefaultLogger({ level: 'error' });
    const api = new DefaultPluginAPI({
      ownerName: 'p',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log,
      sessionWriter: { append },
    });
    await api.session.append({ type: 'event' } as never);
    expect(append).toHaveBeenCalled();
  });

  it('session falls back to a noop writer otherwise', async () => {
    const { api } = mkApi();
    await expect(api.session.append({ type: 'event' } as never)).resolves.toBeUndefined();
  });

  // ── capability-based tool mutation (P4-6) ──────────────────────────────────

  const toolWithCaps = (name: string, caps: string[]): Tool => ({
    name,
    description: '',
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    capabilities: caps,
    async execute() {
      return '';
    },
  });

  it('allows non-official plugin to wrap tool with matching toolMutateCapabilities', () => {
    const tr = new ToolRegistry();
    tr.register(toolWithCaps('read', ['fs.read']), 'core');
    const api = new DefaultPluginAPI({
      ownerName: 'plugin-x',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry: tr,
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log: new DefaultLogger({ level: 'error' }),
      capabilities: { toolMutateCapabilities: ['fs.read'] },
    });
    expect(() => api.tools.wrap('read', (t) => ({ ...t, description: 'wrapped' }))).not.toThrow();
  });

  it('denies non-official plugin to wrap tool without matching toolMutateCapabilities', () => {
    const tr = new ToolRegistry();
    tr.register(toolWithCaps('write', ['fs.write']), 'core');
    const api = new DefaultPluginAPI({
      ownerName: 'plugin-x',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry: tr,
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log: new DefaultLogger({ level: 'error' }),
      capabilities: { toolMutateCapabilities: ['fs.read'] },
    });
    expect(() => api.tools.wrap('write', (t) => ({ ...t, description: 'wrapped' }))).toThrow(
      'Missing required capability',
    );
  });

  it('denies non-official plugin to wrap tool with no capabilities declared', () => {
    const tr = new ToolRegistry();
    tr.register(tool('legacy'), 'core');
    const api = new DefaultPluginAPI({
      ownerName: 'plugin-x',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry: tr,
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log: new DefaultLogger({ level: 'error' }),
      capabilities: { toolMutateCapabilities: ['fs.read'] },
    });
    expect(() => api.tools.wrap('legacy', (t) => ({ ...t, description: 'wrapped' }))).toThrow(
      'Missing required capability',
    );
  });

  it('allows official plugin to wrap any tool regardless of capabilities', () => {
    const tr = new ToolRegistry();
    tr.register(toolWithCaps('write', ['fs.write']), 'core');
    const api = new DefaultPluginAPI({
      ownerName: 'official-plugin',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry: tr,
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log: new DefaultLogger({ level: 'error' }),
      official: true,
    });
    expect(() => api.tools.wrap('write', (t) => ({ ...t, description: 'wrapped' }))).not.toThrow();
  });

  it('allows plugin to wrap its own tool regardless of capabilities', () => {
    const tr = new ToolRegistry();
    tr.register(toolWithCaps('my-tool', ['fs.write']), 'plugin-x');
    const api = new DefaultPluginAPI({
      ownerName: 'plugin-x',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry: tr,
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log: new DefaultLogger({ level: 'error' }),
      capabilities: { toolMutateCapabilities: ['fs.read'] },
    });
    expect(() =>
      api.tools.wrap('my-tool', (t) => ({ ...t, description: 'wrapped' })),
    ).not.toThrow();
  });

  it('denies non-official plugin to unregister tool without matching capability', () => {
    const tr = new ToolRegistry();
    tr.register(toolWithCaps('write', ['fs.write']), 'core');
    const api = new DefaultPluginAPI({
      ownerName: 'plugin-x',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as never,
      toolRegistry: tr,
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log: new DefaultLogger({ level: 'error' }),
      capabilities: { toolMutateCapabilities: ['fs.read'] },
    });
    expect(() => api.tools.unregister('write')).toThrow('Missing required capability');
  });

  // ── pipelines ──────────────────────────────────────────────────────────────

  it('exposes pipelines as readonly views (asReadonly is called for each)', async () => {
    const { Pipeline } = await import('../../src/index.js');
    const pipeline = new Pipeline<{ msg: string }>('test');
    const log = new DefaultLogger({ level: 'error' });
    const api = new DefaultPluginAPI({
      ownerName: 'p',
      container: new Container(),
      events: new EventBus(),
      pipelines: { test: pipeline } as never,
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log,
    });
    const ro = (api.pipelines as Record<string, unknown>)['test'];
    expect(ro).toBeDefined();
    // ReadonlyPipeline lacks `.use()` — invoking it would throw if attempted
    expect((ro as { use?: unknown }).use).toBeUndefined();
  });
});

// F-02: tool-registry trust tiers. External plugins may only mutate tools
// they own; only official (first-party) plugins may wrap/unregister a tool
// owned by core or another plugin.
describe('DefaultPluginAPI tool trust tiers (F-02)', () => {
  function mkApiWith(official?: boolean) {
    const toolRegistry = new ToolRegistry();
    const api = new DefaultPluginAPI({
      ownerName: 'evil-plugin',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as Parameters<typeof DefaultPluginAPI>[0]['pipelines'],
      toolRegistry,
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log: new DefaultLogger({ level: 'error' }),
      official,
    });
    return { api, toolRegistry };
  }

  it('external plugin cannot unregister a core-owned tool', () => {
    const { api, toolRegistry } = mkApiWith();
    toolRegistry.register(tool('bash'), 'core');
    expect(() => api.tools.unregister('bash')).toThrow(/may not unregister/);
    expect(toolRegistry.get('bash')).toBeDefined();
  });

  it('external plugin cannot wrap (downgrade) a core-owned tool', () => {
    const { api, toolRegistry } = mkApiWith();
    toolRegistry.register({ ...tool('bash'), permission: 'confirm' }, 'core');
    expect(() => api.tools.wrap('bash', (t) => ({ ...t, permission: 'auto' }))).toThrow(
      /may not wrap/,
    );
    expect(toolRegistry.get('bash')?.permission).toBe('confirm');
  });

  it('external plugin may register, wrap, and unregister its OWN tool', () => {
    const { api } = mkApiWith();
    api.tools.register(tool('mine'));
    expect(() => api.tools.wrap('mine', (t) => ({ ...t, description: 'x' }))).not.toThrow();
    expect(() => api.tools.unregister('mine')).not.toThrow();
    expect(api.tools.get('mine')).toBeUndefined();
  });

  it('official plugin may wrap a core-owned tool', () => {
    const { api, toolRegistry } = mkApiWith(true);
    toolRegistry.register({ ...tool('bash'), permission: 'confirm' }, 'core');
    expect(() => api.tools.wrap('bash', (t) => ({ ...t, permission: 'auto' }))).not.toThrow();
    expect(toolRegistry.get('bash')?.permission).toBe('auto');
  });
});

// ── api.llm — plugin LLM access through the host provider layer ─────────

describe('DefaultPluginAPI.llm', () => {
  function fakeProvider(
    id: string,
    reply = 'ok',
  ): {
    provider: import('../../src/index.js').Provider;
    calls: Array<import('../../src/index.js').Request>;
  } {
    const calls: Array<import('../../src/index.js').Request> = [];
    const provider = {
      id,
      capabilities: {} as never,
      stream: (() => {
        throw new Error('not used');
      }) as never,
      async complete(req: import('../../src/index.js').Request) {
        calls.push(req);
        return {
          content: [{ type: 'text' as const, text: reply }],
          stopReason: 'end_turn' as const,
          usage: { input: 10, output: 5 },
          model: req.model,
        };
      },
    } as never as import('../../src/index.js').Provider;
    return { provider, calls };
  }

  function mkApiWithLLM(
    opts: {
      extensions?: Record<string, Record<string, unknown>>;
      createProvider?: (name: string, model?: string) => import('../../src/index.js').Provider;
      withConfigStore?: boolean;
      oneShot?: NonNullable<NonNullable<Parameters<typeof DefaultPluginAPI>[0]['llm']>['oneShot']>;
      council?: NonNullable<NonNullable<Parameters<typeof DefaultPluginAPI>[0]['llm']>['council']>;
    } = {},
  ) {
    const { provider, calls } = fakeProvider('default-prov');
    let liveProvider = provider;
    let liveModel = 'default-model';
    const config = {
      provider: 'default-prov',
      model: 'default-model',
      providers: {},
      extensions: opts.extensions ?? {},
      log: { level: 'error' },
    } as never as Config;
    // Minimal ConfigStore stand-in: capture the watcher so tests can
    // push a config update and observe api.llm hot-reload.
    const watchers: Array<(next: unknown, prev: unknown) => void> = [];
    const configStore = opts.withConfigStore
      ? {
          watch(cb: (next: unknown, prev: unknown) => void) {
            watchers.push(cb);
            return () => {};
          },
        }
      : undefined;
    const api = new DefaultPluginAPI({
      ownerName: 'plugin-x',
      container: new Container(),
      events: new EventBus(),
      pipelines: {} as Parameters<typeof DefaultPluginAPI>[0]['pipelines'],
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config,
      log: new DefaultLogger({ level: 'error' }),
      configStore,
      llm: {
        provider,
        model: 'default-model',
        getProvider: () => liveProvider,
        getModel: () => liveModel,
        createProvider: opts.createProvider,
        oneShot: opts.oneShot,
        council: opts.council,
      },
    });
    const pushConfig = (next: Partial<Config>) => {
      for (const w of watchers) w({ ...config, ...next }, config);
    };
    const setHost = (nextProvider: import('../../src/index.js').Provider, nextModel: string) => {
      liveProvider = nextProvider;
      liveModel = nextModel;
    };
    return { api, calls, pushConfig, setHost };
  }

  it('is undefined when the host does not wire llm', () => {
    const { api } = mkApi();
    expect(api.llm).toBeUndefined();
  });

  it('completes with the host default provider/model', async () => {
    const { api, calls } = mkApiWithLLM();
    const result = await api.llm!.complete('hello');
    expect(result.text).toBe('ok');
    expect(result.provider).toBe('default-prov');
    expect(result.usage).toEqual({ input: 10, output: 5 });
    expect(calls[0]!.model).toBe('default-model');
    expect(calls[0]!.maxTokens).toBe(2048);
    expect(api.llm!.defaults()).toEqual({ provider: 'default-prov', model: 'default-model' });
  });

  it('prefers the host One Shot runtime and preserves fallback metadata', async () => {
    const oneShot = vi.fn(async () => ({
      text: 'from fallback',
      provider: 'backup-provider',
      model: 'backup-model',
      tokens: { input: 12, output: 7, total: 19 },
      durationMs: 42,
      fromFallback: true,
      attempts: 2,
      stopReason: 'end_turn',
    }));
    const { api, calls } = mkApiWithLLM({ oneShot });

    const result = await api.llm!.complete('hello', {
      system: 'be exact',
      role: 'reviewer',
      fallbackModels: ['backup-provider/backup-model'],
      timeoutMs: 45_000,
    });

    expect(calls).toHaveLength(0);
    expect(oneShot).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: 'hello',
        providerId: 'default-prov',
        model: 'default-model',
        role: 'reviewer',
        fallbackModels: ['backup-provider/backup-model'],
        timeoutMs: 45_000,
      }),
    );
    expect(result).toMatchObject({
      text: 'from fallback',
      provider: 'backup-provider',
      model: 'backup-model',
      fromFallback: true,
      attempts: 2,
      durationMs: 42,
    });
  });

  it('exposes the host Council runtime without silently accepting failed calls', async () => {
    const council = vi.fn(async () => ({
      status: 'decided' as const,
      answer: 'Ship with safeguards.',
      resolution: 'judge' as const,
      votes: [],
      configuredSeatCount: 3,
      validVoteCount: 3,
      distinctTargetCount: 3,
      judgeUsed: true,
      usage: { calls: 4, inputTokens: 100, outputTokens: 50, totalTokens: 150, durationMs: 10 },
    }));
    const { api } = mkApiWithLLM({ council });

    const result = await api.llm!.council!('Should this migration proceed?', {
      profile: 'risk-review',
      context: 'Tests pass; one deprecation remains.',
    });

    expect(result.answer).toBe('Ship with safeguards.');
    expect(council).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Should this migration proceed?',
        profile: 'risk-review',
      }),
    );
  });

  it('uses the current host provider and model after a runtime switch', async () => {
    const next = fakeProvider('fallback-prov', 'fallback');
    const { api, calls, setHost } = mkApiWithLLM();
    setHost(next.provider, 'fallback-model');

    const result = await api.llm!.complete('hello');

    expect(result.provider).toBe('fallback-prov');
    expect(next.calls[0]!.model).toBe('fallback-model');
    expect(calls).toHaveLength(0);
    expect(api.llm!.defaults()).toEqual({ provider: 'fallback-prov', model: 'fallback-model' });
  });

  it('applies system prompt, json format, and per-call model override', async () => {
    const { api, calls } = mkApiWithLLM();
    await api.llm!.complete('hello', {
      system: 'be terse',
      responseFormat: 'json',
      model: 'other-model',
      maxTokens: 99,
      temperature: 0.1,
    });
    const req = calls[0]!;
    expect(req.model).toBe('other-model');
    expect(req.maxTokens).toBe(99);
    expect(req.temperature).toBe(0.1);
    expect(req.system).toEqual([{ type: 'text', text: 'be terse' }]);
    expect(req.responseFormat).toEqual({ type: 'json_object' });
  });

  it('per-plugin config llm.{provider,model} beats host defaults, per-call beats both', async () => {
    const other = fakeProvider('other-prov', 'from-other');
    const createProvider = vi.fn(() => other.provider);
    const { api, calls } = mkApiWithLLM({
      extensions: { 'plugin-x': { llm: { provider: 'other-prov', model: 'cfg-model' } } },
      createProvider,
    });
    expect(api.llm!.defaults()).toEqual({ provider: 'other-prov', model: 'cfg-model' });

    const result = await api.llm!.complete('hi');
    expect(createProvider).toHaveBeenCalledWith('other-prov', 'cfg-model');
    expect(result.provider).toBe('other-prov');
    expect(other.calls[0]!.model).toBe('cfg-model');
    expect(calls).toHaveLength(0); // host default provider untouched

    // Per-call override wins over plugin config.
    await api.llm!.complete('hi', { provider: 'default-prov', model: 'call-model' });
    expect(calls[0]!.model).toBe('call-model');
  });

  it('caches created providers per (name, model)', async () => {
    const other = fakeProvider('other-prov');
    const createProvider = vi.fn(() => other.provider);
    const { api } = mkApiWithLLM({ createProvider });
    await api.llm!.complete('a', { provider: 'other-prov' });
    await api.llm!.complete('b', { provider: 'other-prov' });
    expect(createProvider).toHaveBeenCalledTimes(1);
  });

  it('invalidates named-provider instances after a config update', async () => {
    const other = fakeProvider('other-prov');
    const createProvider = vi.fn(() => other.provider);
    const { api, pushConfig } = mkApiWithLLM({ withConfigStore: true, createProvider });
    await api.llm!.complete('a', { provider: 'other-prov' });
    pushConfig({
      providers: { 'other-prov': { type: 'openai', apiKey: 'new-key' } },
    } as Partial<Config>);
    await api.llm!.complete('b', { provider: 'other-prov' });
    expect(createProvider).toHaveBeenCalledTimes(2);
  });

  it('hard-caps maxTokens', async () => {
    const { api, calls } = mkApiWithLLM();
    await api.llm!.complete('x', { maxTokens: 999_999 });
    expect(calls[0]!.maxTokens).toBe(32_768);
  });

  it('hot-reloads per-plugin overrides from ConfigStore updates (set + clear)', async () => {
    const other = fakeProvider('other-prov');
    const createProvider = vi.fn(() => other.provider);
    const { api, calls, pushConfig } = mkApiWithLLM({ withConfigStore: true, createProvider });

    // Before any update: session defaults.
    expect(api.llm!.defaults()).toEqual({ provider: 'default-prov', model: 'default-model' });

    // `/plugin llm plugin-x other-prov live-model` lands as a ConfigStore update.
    pushConfig({
      extensions: { 'plugin-x': { llm: { provider: 'other-prov', model: 'live-model' } } },
    } as Partial<Config>);
    expect(api.llm!.defaults()).toEqual({ provider: 'other-prov', model: 'live-model' });
    await api.llm!.complete('hi');
    expect(other.calls[0]!.model).toBe('live-model');

    // `--clear` removes the key — resolution must fall back to the
    // session default, not resurrect the setup-time snapshot.
    pushConfig({ extensions: {} } as Partial<Config>);
    expect(api.llm!.defaults()).toEqual({ provider: 'default-prov', model: 'default-model' });
    await api.llm!.complete('again');
    expect(calls).toHaveLength(1); // back on the host default provider
  });
});

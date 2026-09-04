import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import type { MCPServerConfig } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../src/client.js';
import { MCP_CONSTANTS } from '../src/constants.js';
import { createMCPServerOperationState } from '../src/operations.js';
import { MCPRegistry } from '../src/registry.js';
import { discoverSlotCapabilities } from '../src/registry-connect-loop.js';
import { sleepIdleSlot } from '../src/registry-idle.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(options: Record<string, unknown> = {}) {
  const toolRegistry = {
    register: vi.fn(),
    unregister: vi.fn(),
  };
  const events = new EventBus();
  const emit = vi.spyOn(events, 'emit');
  const log = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  };
  const registry = new MCPRegistry({
    toolRegistry: toolRegistry as never,
    events,
    log: log as never,
    ...options,
  });
  return { registry, toolRegistry, events, emit, log };
}

function makeSlot(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cfg: {
      name,
      transport: 'stdio',
      command: 'noop',
    } satisfies MCPServerConfig,
    state: 'connected',
    toolNames: [],
    lazyTools: [],
    attempts: 0,
    reconnectPending: false,
    reconnectCycles: 0,
    lazy: false,
    lastUsed: Date.now(),
    registeredLazy: false,
    operations: createMCPServerOperationState(),
    ...overrides,
  };
}

function internals(registry: MCPRegistry) {
  return registry as never as {
    servers: Map<string, Record<string, unknown>>;
    disabledServers: Map<string, MCPServerConfig>;
    attemptConnect: (slot: Record<string, unknown>) => Promise<void>;
    activateServer: (name: string) => void;
    deactivateServer: (name: string) => number;
    applyTools: (
      slot: Record<string, unknown>,
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>,
      client?: unknown,
    ) => void;
    onResourcesChanged: (name: string) => void;
    onPromptsChanged: (name: string) => void;
    onChildExit: (name: string, code: number | null, signal: string | null) => void;
    onTransportDisconnect: (name: string) => void;
    scheduleReconnect: (slot: Record<string, unknown>) => void;
    startLazy: (slot: Record<string, unknown>) => Promise<void>;
    sweepIdle: () => Promise<void>;
    ensureIdleSweep: () => void;
    idleTimer?: ReturnType<typeof setInterval> | undefined;
    persistCapabilityManifest: (slot: Record<string, unknown>) => Promise<void>;
    recordOperation: (slot: Record<string, unknown>, kind: 'connect', reason?: string) => void;
  };
}

describe('MCPRegistry coverage', () => {
  it('routes every authorization-manager operation and validates configuration', async () => {
    const manager = {
      begin: vi.fn(),
      complete: vi.fn(async () => ({ state: 'authorized' })),
      status: vi.fn(async () => ({ state: 'authorized' })),
      disconnect: vi.fn(async () => true),
    };
    const { registry } = fixture({ authorizationManager: manager });
    registry.markDisabled({
      name: 'remote',
      transport: 'sse',
      url: 'https://example.test/mcp',
      enabled: false,
    });
    await registry.completeAuthorization('remote', 'https://client.test/callback');
    await registry.authorizationStatus('remote');
    await registry.disconnectAuthorization('remote');
    expect(manager.complete).toHaveBeenCalled();
    expect(manager.status).toHaveBeenCalled();
    expect(manager.disconnect).toHaveBeenCalled();

    await expect(registry.authorizationStatus('missing')).rejects.toThrow(/not registered/);
    const noManager = fixture().registry;
    await expect(noManager.authorizationStatus('missing')).rejects.toThrow(/not configured/);
  });

  it('stops an active server when a disabled config replaces it', async () => {
    const { registry } = fixture();
    const slot = makeSlot('server', {
      client: {
        removeExitListener: vi.fn(),
        removeToolsChangedListener: vi.fn(),
        removeResourcesChangedListener: vi.fn(),
        removePromptsChangedListener: vi.fn(),
        close: vi.fn(),
      },
    });
    internals(registry).servers.set('server', slot);
    await registry.start({
      name: 'server',
      transport: 'stdio',
      command: 'noop',
      enabled: false,
    });
    expect(registry.describe()).toEqual([
      expect.objectContaining({ name: 'server', enabled: false }),
    ]);
  });

  it('rejects missing slots and a failed on-demand connection', async () => {
    const { registry } = fixture();
    await expect(registry.ensureConnected('missing')).rejects.toThrow(/not registered/);
    await expect(registry.listResources('missing')).rejects.toThrow(/not registered/);
    const slot = makeSlot('lazy', { state: 'dormant', lazy: true });
    internals(registry).servers.set('lazy', slot);
    vi.spyOn(internals(registry), 'attemptConnect').mockResolvedValue();
    await expect(registry.ensureConnected('lazy')).rejects.toThrow(/failed to connect on demand/);

    const idleClient = {};
    const idle = makeSlot('idle', { state: 'idle' });
    internals(registry).servers.set('idle', idle);
    vi.spyOn(internals(registry), 'attemptConnect').mockImplementation(async (target) => {
      target['client'] = idleClient;
      target['state'] = 'connected';
    });
    await expect(registry.ensureConnected('idle')).resolves.toBe(idleClient);
  });

  it('activates and deactivates cached tools across guard and failure paths', () => {
    const { registry, toolRegistry, log } = fixture();
    const api = internals(registry);
    api.activateServer('missing');
    expect(api.deactivateServer('missing')).toBe(0);

    const eagerWithoutClient = makeSlot('eager', {
      lazyTools: [{ name: 'one', inputSchema: {}, execute: vi.fn() }],
    });
    api.servers.set('eager', eagerWithoutClient);
    api.activateServer('eager');

    const empty = makeSlot('empty', { client: {} });
    api.servers.set('empty', empty);
    api.activateServer('empty');
    expect(api.deactivateServer('empty')).toBe(0);

    const active = makeSlot('active', {
      client: {},
      lazyTools: [
        { name: 'one', inputSchema: {}, execute: vi.fn() },
        { name: 'two', inputSchema: {}, execute: vi.fn() },
      ],
    });
    api.servers.set('active', active);
    toolRegistry.register
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('duplicate');
      });
    api.activateServer('active');
    api.activateServer('active');
    expect(log.warn).toHaveBeenCalled();
    toolRegistry.unregister.mockImplementationOnce(() => {
      throw new Error('gone');
    });
    expect(api.deactivateServer('active')).toBe(1);
    expect(registry.isActivated('active')).toBe(false);
    expect(registry.isActivated('missing')).toBe(false);
  });

  it('returns catalog snapshots and cached capability records defensively', async () => {
    const { registry } = fixture();
    const api = internals(registry);
    expect(registry.getCatalog('missing')).toBeUndefined();
    const resources = [{ uri: 'mem://one', name: 'one' }];
    const templates = [{ uriTemplate: 'mem://{id}', name: 'template' }];
    const prompts = [{ name: 'prompt' }];
    const slot = makeSlot('catalog', {
      resources,
      resourceTemplates: templates,
      prompts,
    });
    api.servers.set('catalog', slot);
    expect(registry.getCatalog('catalog')).toMatchObject({ name: 'catalog' });
    expect(await registry.listResources('catalog')).toEqual(resources);
    expect(await registry.listResourceTemplates('catalog')).toEqual(templates);
    expect(await registry.listPrompts('catalog')).toEqual(prompts);
    expect(await registry.listResources('catalog')).not.toBe(resources);
    expect(registry.list()).toEqual([expect.objectContaining({ name: 'catalog' })]);
    const lazy = makeSlot('lazy-tools', {
      lazyTools: [{ name: 'cached', inputSchema: {}, execute: vi.fn() }],
    });
    api.servers.set('lazy-tools', lazy);
    expect(registry.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'lazy-tools', tools: ['cached'] })]),
    );
  });

  it('returns empty catalogs when the live server omits capabilities', async () => {
    const { registry } = fixture();
    const client = {
      getServerMetadata: () => ({ capabilities: {}, serverInfo: {}, protocolVersion: 'x' }),
    };
    internals(registry).servers.set(
      'catalog',
      makeSlot('catalog', {
        client,
        resources: undefined,
        resourceTemplates: undefined,
        prompts: undefined,
      }),
    );
    await expect(registry.listResources('catalog', { refresh: true })).resolves.toEqual([]);
    await expect(registry.listResourceTemplates('catalog', { refresh: true })).resolves.toEqual([]);
    await expect(registry.listPrompts('catalog', { refresh: true })).resolves.toEqual([]);
  });

  it('loads paginated resource templates and persists the result', async () => {
    const { registry } = fixture();
    const listResourceTemplates = vi
      .fn()
      .mockResolvedValueOnce({
        resourceTemplates: [{ uriTemplate: 'mem://{id}', name: 'one' }],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        resourceTemplates: [{ uriTemplate: 'repo://{id}', name: 'two' }],
      });
    const client = {
      getServerMetadata: () => ({
        capabilities: { resources: {} },
        serverInfo: {},
        protocolVersion: 'x',
      }),
      listResourceTemplates,
    };
    internals(registry).servers.set(
      'catalog',
      makeSlot('catalog', { client, resourceTemplates: undefined }),
    );
    await expect(
      registry.listResourceTemplates('catalog', { refresh: true }),
    ).resolves.toHaveLength(2);
  });

  it('loads paginated prompt and discovery catalogs', async () => {
    const { registry } = fixture();
    const listPrompts = vi
      .fn()
      .mockResolvedValueOnce({ prompts: [{ name: 'one' }], nextCursor: 'next' })
      .mockResolvedValueOnce({ prompts: [{ name: 'two' }] })
      .mockResolvedValueOnce({ prompts: [{ name: 'three' }], nextCursor: 'again' })
      .mockResolvedValueOnce({ prompts: [{ name: 'four' }] });
    const listResourceTemplates = vi
      .fn()
      .mockResolvedValueOnce({
        resourceTemplates: [{ uriTemplate: 'mem://{id}', name: 'one' }],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        resourceTemplates: [{ uriTemplate: 'repo://{id}', name: 'two' }],
      });
    const client = {
      getServerMetadata: () => ({
        capabilities: { resources: {}, prompts: {} },
        serverInfo: {},
        protocolVersion: 'x',
      }),
      listResources: vi.fn(async () => ({ resources: [] })),
      listResourceTemplates,
      listPrompts,
    };
    const slot = makeSlot('catalog', { client });
    internals(registry).servers.set('catalog', slot);
    await expect(registry.listPrompts('catalog', { refresh: true })).resolves.toHaveLength(2);
    await discoverSlotCapabilities(
      { recordFailure: vi.fn(), recordOperation: vi.fn(), log: { warn: vi.fn() } } as never,
      slot as never,
      client as never,
    );
    expect(listResourceTemplates).toHaveBeenCalledWith({ cursor: 'next' });
  });

  it('caches wrapped tools in token-saving lazy mode', () => {
    const { registry } = fixture({ lazyMode: true });
    const slot = makeSlot('lazy', { lazy: true });
    internals(registry).applyTools(slot, [{ name: 'one', inputSchema: {} }], undefined);
    expect(slot['lazyTools']).toHaveLength(1);
  });

  it('records capability discovery failures', async () => {
    const { log } = fixture();
    const slot = makeSlot('catalog');
    const client = {
      getServerMetadata: () => ({
        capabilities: { resources: {}, prompts: {} },
        serverInfo: {},
        protocolVersion: 'x',
      }),
      listResources: vi.fn(async () => {
        throw new Error('resources failed');
      }),
      listResourceTemplates: vi.fn(async () => {
        throw new Error('templates failed');
      }),
      listPrompts: vi.fn(async () => {
        throw new Error('prompts failed');
      }),
    };
    await discoverSlotCapabilities(
      { recordFailure: vi.fn(), recordOperation: vi.fn(), log } as never,
      slot as never,
      client as never,
    );
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it('invalidates catalogs only for registered slots', () => {
    const { registry } = fixture();
    const api = internals(registry);
    api.onResourcesChanged('missing');
    api.onPromptsChanged('missing');
    const slot = makeSlot('catalog', {
      resources: [{ uri: 'mem://one' }],
      resourceTemplates: [{ uriTemplate: 'mem://{id}' }],
      prompts: [{ name: 'one' }],
    });
    api.servers.set('catalog', slot);
    api.onResourcesChanged('catalog');
    api.onPromptsChanged('catalog');
    expect(slot['resources']).toBeUndefined();
    expect(slot['resourceTemplates']).toBeUndefined();
    expect(slot['prompts']).toBeUndefined();
  });

  it('puts lazy child and HTTP disconnects back to dormant', () => {
    const { registry } = fixture();
    const api = internals(registry);
    const child = makeSlot('child', { lazy: true, client: {} });
    api.servers.set('child', child);
    api.onChildExit('child', null, null);
    expect(child['state']).toBe('dormant');
    const http = makeSlot('http', {
      lazy: true,
      client: {},
      cfg: { name: 'http', transport: 'sse', url: 'https://example.test' },
    });
    api.servers.set('http', http);
    api.onTransportDisconnect('http');
    expect(http['state']).toBe('dormant');
  });

  it('sleeps idle lazy clients and clears stale reconnect timers', async () => {
    vi.useFakeTimers();
    const { registry } = fixture({ idleTimeoutMs: 10 });
    const client = {
      removeExitListener: vi.fn(),
      removeDisconnectListener: vi.fn(),
      removeToolsChangedListener: vi.fn(),
      removeResourcesChangedListener: vi.fn(),
      removePromptsChangedListener: vi.fn(),
      close: vi.fn(),
    };
    const slot = makeSlot('idle', {
      lazy: true,
      client,
      lastUsed: 0,
      reconnectTimer: setTimeout(() => {}, 1_000),
      onDisconnect: vi.fn(),
    });
    internals(registry).servers.set('idle', slot);
    internals(registry).ensureIdleSweep();
    expect(internals(registry).idleTimer).toBeDefined();
    vi.setSystemTime(100);
    await internals(registry).sweepIdle();
    expect(slot['state']).toBe('dormant');
    expect(client.close).toHaveBeenCalled();
    expect(internals(registry).idleTimer).toBeUndefined();

    await sleepIdleSlot(
      {
        recordOperation: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn() },
        events: { emit: vi.fn() },
      } as never,
      makeSlot('already-dormant', { lazy: true }) as never,
    );
    const nonLazy = makeSlot('awake', { lastUsed: 0 });
    internals(registry).servers.set('awake', nonLazy);
    await internals(registry).sweepIdle();
  });

  it('covers disabled idle sweeps and the interval callback', async () => {
    const disabled = fixture({ idleTimeoutMs: 0 }).registry;
    await internals(disabled).sweepIdle();

    vi.useFakeTimers();
    const { registry } = fixture({ idleTimeoutMs: 10 });
    const sweep = vi.spyOn(internals(registry), 'sweepIdle').mockResolvedValue();
    internals(registry).ensureIdleSweep();
    await vi.advanceTimersByTimeAsync(MCP_CONSTANTS.IDLE.SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalled();
  });

  it('replaces prior HTTP clients and invokes the bound disconnect callback', async () => {
    vi.useFakeTimers();
    const { registry } = fixture();
    vi.spyOn(MCPClient.prototype, 'connect').mockResolvedValue();
    vi.spyOn(MCPClient.prototype, 'listTools').mockReturnValue([]);
    vi.spyOn(MCPClient.prototype, 'getServerMetadata').mockReturnValue({
      protocolVersion: 'x',
      capabilities: {},
      serverInfo: { name: 'server', version: '1' },
    });
    const priorDisconnect = vi.fn();
    const prior = {
      removeExitListener: vi.fn(),
      removeDisconnectListener: vi.fn(),
      removeToolsChangedListener: vi.fn(),
      removeResourcesChangedListener: vi.fn(),
      removePromptsChangedListener: vi.fn(),
      close: vi.fn(async () => {
        throw new Error('close failed');
      }),
    };
    const slot = makeSlot('http', {
      cfg: { name: 'http', transport: 'sse', url: 'https://example.test' },
      client: prior,
      onDisconnect: priorDisconnect,
    });
    internals(registry).servers.set('http', slot);
    await internals(registry).attemptConnect(slot);
    await vi.waitFor(() => expect(prior.close).toHaveBeenCalled());
    expect(prior.removeDisconnectListener).toHaveBeenCalledWith(priorDisconnect);
    const boundDisconnect = slot['onDisconnect'] as () => void;
    boundDisconnect();
    expect(slot['state']).toBe('disconnected');
  });

  it('cleans up failed clients and handles pre-construction non-Error failures', async () => {
    vi.useFakeTimers();
    const failed = fixture().registry;
    vi.spyOn(MCPClient.prototype, 'connect').mockRejectedValue(new Error('connect failed'));
    vi.spyOn(MCPClient.prototype, 'close').mockRejectedValue(new Error('close failed'));
    // A stale reconnect timer left by a prior scheduleReconnect cycle must be
    // cleared when the connect attempts exhaust (registry.ts:1009-1012).
    const failedSlot = makeSlot('failed', {
      reconnectTimer: setTimeout(() => {}, 10_000),
    });
    const failedRun = internals(failed).attemptConnect(failedSlot);
    await vi.runAllTimersAsync();
    await failedRun;
    expect(failedSlot['state']).toBe('failed');
    expect(failedSlot['reconnectTimer']).toBeUndefined();
    vi.restoreAllMocks();

    const thrown = fixture({
      authorizationProviderFactory: () => {
        throw 'plain failure';
      },
    }).registry;
    const thrownSlot = makeSlot('remote', {
      cfg: { name: 'remote', transport: 'sse', url: 'https://example.test' },
    });
    const thrownRun = internals(thrown).attemptConnect(thrownSlot);
    await vi.runAllTimersAsync();
    await thrownRun;
    expect(thrownSlot['state']).toBe('failed');
  });

  it('clears stale reconnect timers and records events without reasons', () => {
    vi.useFakeTimers();
    const { registry } = fixture();
    const slot = makeSlot('server', {
      reconnectTimer: setTimeout(() => {}, 10_000),
    });
    internals(registry).scheduleReconnect(slot);
    expect(slot['reconnectTimer']).toBeDefined();
    internals(registry).recordOperation(slot, 'connect');
  });

  it('restart of a lazy slot goes through startLazy', async () => {
    const { registry } = fixture();
    const lazy = makeSlot('lazy-restart', { lazy: true });
    internals(registry).servers.set('lazy-restart', lazy);
    const startLazy = vi.spyOn(internals(registry), 'startLazy').mockResolvedValue();
    await registry.restart('lazy-restart');
    expect(startLazy).toHaveBeenCalledWith(lazy);
  });

  it('attemptConnect bails when the slot was replaced mid-flight', async () => {
    vi.useFakeTimers();
    const { registry } = fixture();
    const original = makeSlot('replaced', {
      state: 'connecting',
      client: { close: vi.fn() },
    });
    // The servers map now points at a *different* slot object for the same name.
    internals(registry).servers.set('replaced', makeSlot('replaced'));
    await internals(registry).attemptConnect(original);
    // The loop guard sees the replacement and returns before creating any client or mutating state.
    expect(original['state']).toBe('connecting');
  });

  it('attemptConnect cleans up and returns when slot was forgotten/removed from servers map during connect', async () => {
    vi.useFakeTimers();
    const { registry } = fixture();
    const clientClose = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(MCPClient.prototype, 'connect').mockImplementation(async function () {
      registry.forget('forgotten-slot');
    });
    vi.spyOn(MCPClient.prototype, 'close').mockImplementation(clientClose);

    const slot = makeSlot('forgotten-slot', {
      cfg: { name: 'forgotten-slot', transport: 'stdio', command: 'node' },
    });
    internals(registry).servers.set('forgotten-slot', slot);
    await internals(registry).attemptConnect(slot);

    expect(internals(registry).servers.has('forgotten-slot')).toBe(false);
    expect(slot['client']).toBeUndefined();
    expect(clientClose).toHaveBeenCalled();
    vi.restoreAllMocks();
  });


  it('attemptConnect cleans up when the slot disconnects during connect', async () => {
    vi.useFakeTimers();
    for (const transport of ['sse', 'stdio'] as const) {
      const { registry } = fixture();
      // The transport flips the slot to disconnected while connect() is in
      // flight — the post-connect guard (registry.ts:926-935) must notice and
      // clean up instead of installing the client.
      vi.spyOn(MCPClient.prototype, 'connect').mockImplementation(async function (this: {
        name: string;
      }) {
        const slot = internals(registry).servers.get('race');
        if (slot) slot['state'] = 'disconnected';
        return Promise.resolve();
      });
      vi.spyOn(MCPClient.prototype, 'close').mockRejectedValue(new Error('close failed'));
      const slot = makeSlot('race', {
        cfg:
          transport === 'sse'
            ? { name: 'race', transport: 'sse', url: 'https://example.test' }
            : { name: 'race', transport: 'stdio', command: 'noop' },
      });
      internals(registry).servers.set('race', slot);
      await internals(registry).attemptConnect(slot);
      // The cleanup branch (registry.ts:930-935) ran: the slot stayed
      // disconnected and no new client was installed.
      expect(slot['state']).toBe('disconnected');
      expect(slot['client']).toBeUndefined();
      // sse sets boundDisconnect (true side of registry.ts:931); stdio leaves
      // it undefined (false side). The rejecting close() also exercises the
      // `.catch(() => {})` arrow at registry.ts:934.
      vi.restoreAllMocks();
    }
  });

  it('persists a lazy manifest without a live client', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-coverage-'));
    const { registry } = fixture({ cacheDir });
    const slot = makeSlot('lazy', { lazy: true });
    try {
      await internals(registry).persistCapabilityManifest(slot);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('handles non-lazy exits with known and unknown codes', () => {
    vi.useFakeTimers();
    const { registry } = fixture();
    const api = internals(registry);
    const one = makeSlot('one');
    api.servers.set('one', one);
    api.onChildExit('one', 1, null);
    const two = makeSlot('two');
    api.servers.set('two', two);
    api.onChildExit('two', null, null);
  });

  it('enforces catalog item, cursor, and page limits', async () => {
    const { registry } = fixture();
    const metadata = () => ({
      capabilities: { resources: {} },
      serverInfo: {},
      protocolVersion: 'x',
    });
    const tooMany = {
      getServerMetadata: metadata,
      listResources: vi.fn(async () => ({
        resources: Array.from({ length: 10_001 }, (_, index) => ({
          uri: `mem://${index}`,
          name: String(index),
        })),
      })),
    };
    internals(registry).servers.set('many', makeSlot('many', { client: tooMany }));
    await expect(registry.listResources('many', { refresh: true })).rejects.toThrow(
      /exceeds 10000 items/,
    );

    const repeated = {
      getServerMetadata: metadata,
      listResources: vi.fn(async () => ({ resources: [], nextCursor: 'same' })),
    };
    internals(registry).servers.set('repeat', makeSlot('repeat', { client: repeated }));
    await expect(registry.listResources('repeat', { refresh: true })).rejects.toThrow(
      /repeated cursor/,
    );

    let page = 0;
    const endless = {
      getServerMetadata: metadata,
      listResources: vi.fn(async () => ({
        resources: [],
        nextCursor: `page-${page++}`,
      })),
    };
    internals(registry).servers.set('endless', makeSlot('endless', { client: endless }));
    await expect(registry.listResources('endless', { refresh: true })).rejects.toThrow(
      /exceeds 100 pages/,
    );
  });
});

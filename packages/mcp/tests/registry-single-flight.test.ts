import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { describe, expect, it, vi } from 'vitest';
import { createMCPServerOperationState } from '../src/operations.js';
import { MCPRegistry } from '../src/registry.js';

describe('MCPRegistry single-flight & cancellation', () => {
  const dummyToolRegistry = {
    register: vi.fn(),
    unregister: vi.fn(),
  } as unknown as ToolRegistry;

  const dummyEvents = {
    emit: vi.fn(),
    on: vi.fn(),
  } as unknown as EventBus;

  const dummyLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;

  it('single-flights concurrent ensureConnected calls during start', async () => {
    const registry = new MCPRegistry({
      toolRegistry: dummyToolRegistry,
      events: dummyEvents,
      log: dummyLogger,
    });

    const cfg = {
      name: 'stdio-test',
      transport: 'stdio' as const,
      command: 'node',
      args: ['-e', 'console.log("hello")'],
    };

    let connectCount = 0;
    vi.spyOn(registry as any, 'attemptConnect').mockImplementation(async (slot: any) => {
      connectCount++;
      await new Promise((r) => setTimeout(r, 50));
      slot.client = {} as any;
      slot.state = 'connected';
    });

    // Launch start() and multiple ensureConnected() concurrently
    const startP = registry.start(cfg);
    const ensureP1 = registry.ensureConnected('stdio-test');
    const ensureP2 = registry.ensureConnected('stdio-test');

    await Promise.all([startP, ensureP1, ensureP2]);

    // Should only have initiated ONE connection attempt!
    expect(connectCount).toBe(1);
  });

  it('whenStarted waits for background starts, whether they connect or fail', async () => {
    // A one-shot run starts its servers in the background and then runs one
    // turn; it waits here so the turn's tool list includes theirs.
    const registry = new MCPRegistry({
      toolRegistry: dummyToolRegistry,
      events: dummyEvents,
      log: dummyLogger,
    });
    const connected: string[] = [];
    vi.spyOn(registry as any, 'attemptConnect').mockImplementation(async (slot: any) => {
      await new Promise((r) => setTimeout(r, slot.cfg.name === 'slow' ? 60 : 10));
      if (slot.cfg.name === 'broken') throw new Error('spawn failed');
      slot.client = {} as any;
      slot.state = 'connected';
      connected.push(slot.cfg.name);
    });
    const stdio = (name: string) => ({ name, transport: 'stdio' as const, command: 'node' });

    await registry.whenStarted(); // nothing in flight: resolves at once
    for (const name of ['slow', 'fast', 'broken']) {
      void registry.start(stdio(name)).catch(() => {});
    }
    await registry.whenStarted();
    expect(connected.sort()).toEqual(['fast', 'slow']);
  });

  it('aborts retry delay if server is stopped while backoff timer is active', async () => {
    const registry = new MCPRegistry({
      toolRegistry: dummyToolRegistry,
      events: dummyEvents,
      log: dummyLogger,
    });

    const cfg = {
      name: 'retry-cancel-test',
      transport: 'stdio' as const,
      command: 'nonexistent-command-xyz',
      args: [],
    };

    let attemptCount = 0;
    vi.spyOn(registry as any, 'attemptConnect').mockImplementation(async (slot: any) => {
      attemptCount++;
      slot.state = 'disconnected'; // Simulate stop() being called during attempt or retry delay
    });

    await registry.start(cfg).catch(() => {});
    await registry.stop('retry-cancel-test');

    expect(attemptCount).toBeLessThanOrEqual(1);
  });

  it('returns the cached client without a new attempt when already connected', async () => {
    const registry = new MCPRegistry({
      toolRegistry: dummyToolRegistry,
      events: dummyEvents,
      log: dummyLogger,
    });

    const client = { name: 'cached-client' };
    const attemptConnect = vi.spyOn(registry as any, 'attemptConnect');

    // Seed the servers map with an already-connected slot, then call the
    // private singleFlightConnect directly — ensureConnected has its own
    // fast path at registry.ts:252, so this exercises the single-flight
    // cache hit at registry.ts:228.
    const slot = {
      cfg: { name: 'already-connected', transport: 'stdio' as const, command: 'node' },
      state: 'connected' as const,
      client,
      toolNames: [],
      lazyTools: [],
      attempts: 0,
      reconnectPending: false,
      reconnectCycles: 0,
    };
    (registry as any).servers.set('already-connected', slot);

    const result = await (registry as any).singleFlightConnect(slot);
    expect(result).toBe(client);
    expect(attemptConnect).not.toHaveBeenCalled();
  });

  it('records wake operation and increments wakeCount only once on concurrent calls from dormant', async () => {
    const registry = new MCPRegistry({
      toolRegistry: dummyToolRegistry,
      events: dummyEvents,
      log: dummyLogger,
    });

    const slot: any = {
      cfg: { name: 'dormant-race', transport: 'stdio' as const, command: 'node', lazy: true },
      state: 'dormant' as const,
      toolNames: [],
      lazyTools: [],
      attempts: 0,
      reconnectPending: false,
      reconnectCycles: 0,
      lazy: true,
      lastUsed: Date.now(),
      registeredLazy: false,
      operations: {
        consecutiveFailures: 0,
        failures: { transport: 0, protocol: 0, tool: 0 },
        reconnectCount: 0,
        wakeCount: 0,
        sleepCount: 0,
        restartCount: 0,
        connectionSamples: [],
        discoverySamples: [],
        callSamples: [],
        inFlightCalls: 0,
        peakInFlightCalls: 0,
        recentEvents: [],
      },
    };
    (registry as any).servers.set('dormant-race', slot);

    vi.spyOn(registry as any, 'attemptConnect').mockImplementation(async (s: any) => {
      await new Promise((r) => setTimeout(r, 20));
      s.state = 'connected';
      s.client = { name: 'woken-client' };
    });

    const p1 = registry.ensureConnected('dormant-race');
    const p2 = registry.ensureConnected('dormant-race');
    const p3 = registry.ensureConnected('dormant-race');

    const results = await Promise.all([p1, p2, p3]);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(slot.operations.wakeCount).toBe(1);
    const wakeEvents = slot.operations.recentEvents.filter((e: any) => e.kind === 'wake');
    expect(wakeEvents).toHaveLength(1);
  });

  // The repo's own invariant, stated at registry.test.ts:105-109 ("no orphan
  // client"): a client must never end up live-but-unreachable, "with registry
  // listeners pointing into a slot no one can reach". `stop()` breaks it by a
  // different route than `start()` ever did. It sets `state='disconnected'` but
  // leaves `slot.client` on the CLOSING client until after its await, so a
  // demand-wake (lazy tool calls resolve through `ensureConnected`,
  // registry-connect-loop.ts:77) sees both single-flight guards inert —
  // `state !== 'connected'` and `connecting` never set by stop() — connects for
  // real, and is then erased by stop()'s unconditional post-await writes. The
  // woken client and its child process are then unreachable by any later
  // stop()/idle sweep/disconnect, and its disconnect handler reference is gone,
  // so no teardown can ever detach the listener still registered on it.
  it('stop() does not orphan a client a demand-wake installed during its close', async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const woken = {
      close: vi.fn(async () => {}),
      removeExitListener: vi.fn(),
      removeDisconnectListener: vi.fn(),
      removeToolsChangedListener: vi.fn(),
    };
    const closing = {
      close: async () => {
        await closeGate;
      },
      removeExitListener: vi.fn(),
      removeDisconnectListener: vi.fn(),
      removeToolsChangedListener: vi.fn(),
    };
    const wokenHandler = vi.fn();

    const registry = new MCPRegistry({
      toolRegistry: dummyToolRegistry,
      events: dummyEvents,
      log: dummyLogger,
    });
    const slot: any = {
      cfg: { name: 'stop-race', transport: 'stdio', command: 'node' },
      state: 'connected',
      client: closing,
      lazy: true,
      toolNames: [],
      lazyTools: [],
      discoveredTools: [],
      lastUsed: Date.now(),
      reconnectPending: false,
      reconnectTimer: undefined,
      reconnectCycles: 0,
      attempts: 0,
      registeredLazy: false,
      onDisconnect: vi.fn(),
      operations: createMCPServerOperationState(),
    };
    (registry as any).servers.set('stop-race', slot);
    vi.spyOn(registry as any, 'attemptConnect').mockImplementation(async (s: any) => {
      s.client = woken;
      s.onDisconnect = wokenHandler;
      s.state = 'connected';
    });

    const stopping = registry.stop('stop-race');
    // `stop()` is now parked inside `await closing.close()`.
    await registry.ensureConnected('stop-race');
    releaseClose();
    await stopping;

    const tracked = slot.client === woken;
    const tornDown = woken.close.mock.calls.length > 0;
    expect(tracked || tornDown).toBe(true);
    // If the slot kept the woken client, its handler must still be reachable.
    if (tracked) expect(slot.onDisconnect).toBe(wokenHandler);
  });

  // stop()'s drain is bounded to two passes, and each pass awaits close(). A wake
  // that lands in the FINAL pass's window therefore re-installs a client after the
  // loop has detached it, breaking the postcondition registry.test.ts:337-342 pins
  // (`after?.client` undefined once stop() resolves) and orphaning a client that
  // nothing closes - the "no orphan client" invariant of registry.test.ts:105-109.
  // Gates are created eagerly per client and released by index so the second wake
  // cannot coalesce into the first pass's window.
  it('stop() leaves no live client when a wake lands in its final close window', async () => {
    const releases: Array<() => void> = [];
    const mkClient = () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.push(release);
      return {
        close: vi.fn(() => pending),
        removeExitListener: vi.fn(),
        removeDisconnectListener: vi.fn(),
        removeToolsChangedListener: vi.fn(),
      };
    };
    const clients = [mkClient(), mkClient(), mkClient()];
    const registry = new MCPRegistry({
      toolRegistry: dummyToolRegistry,
      events: dummyEvents,
      log: dummyLogger,
    });
    const slot: any = {
      cfg: { name: 'final-window', transport: 'stdio', command: 'node' },
      state: 'connected',
      client: clients[0],
      lazy: true,
      toolNames: [],
      lazyTools: [],
      discoveredTools: [],
      lastUsed: Date.now(),
      reconnectPending: false,
      reconnectTimer: undefined,
      reconnectCycles: 0,
      attempts: 0,
      registeredLazy: false,
      onDisconnect: vi.fn(),
      operations: createMCPServerOperationState(),
    };
    (registry as any).servers.set('final-window', slot);
    let wakes = 0;
    vi.spyOn(registry as any, 'attemptConnect').mockImplementation(async (s: any) => {
      wakes += 1;
      s.client = clients[wakes];
      s.onDisconnect = vi.fn();
      s.state = 'connected';
    });

    const stopping = registry.stop('final-window');
    await registry.ensureConnected('final-window'); // wake 1 -> consumed by pass 2
    releases[0]?.();
    await new Promise((resolve) => setImmediate(resolve)); // pass 2 detaches, parks
    await registry.ensureConnected('final-window'); // wake 2 -> lands in final window
    releases[1]?.();
    // Drain-until-empty semantics: stop() now also closes the wake-2 client,
    // and it awaits that close before resolving — open its gate too. Under the
    // old bounded loop this gate was never waited on (that was the bug).
    releases[2]?.();
    await stopping;

    expect(wakes).toBe(2);
    expect(slot.client).toBeUndefined();
    expect(clients.every((c) => c.close.mock.calls.length > 0)).toBe(true);
  });
});

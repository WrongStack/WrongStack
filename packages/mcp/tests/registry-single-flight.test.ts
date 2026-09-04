import { describe, expect, it, vi } from 'vitest';
import { MCPRegistry } from '../src/registry.js';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';

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
});


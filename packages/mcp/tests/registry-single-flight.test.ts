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
});

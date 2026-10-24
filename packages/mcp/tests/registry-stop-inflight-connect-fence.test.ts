/**
 * Characterization: the post-connect guard in attemptConnectSlot
 * (registry-connect-loop.ts, the `slot.state === 'disconnected'` check right
 * after `await client.connect()`) fences the LAST stop()/wake race window —
 * a demand-wake whose transport connect is still in flight (has not yet
 * assigned slot.client) when stop() resolves.
 *
 * Round 27 made stop() drain until the slot is empty, which closes every
 * window where a wake has already ASSIGNED. The remaining window — connect
 * parked pre-assignment — is only safe because of that guard: stop()
 * unconditionally leaves state='disconnected', and when the parked connect
 * later resolves, the guard sees it and tears the fresh client down without
 * assigning (no orphan transport, no resurrect-after-stop). Removing or
 * "simplifying" the guard would silently reopen the leak, so this suite pins
 * exactly that behavior.
 *
 * Harness: the REAL wake path runs end to end (ensureConnected →
 * singleFlightConnect → attemptConnect → attemptConnectSlot constructs a real
 * MCPClient); only the transport boundary is gated —
 * MCPClient.prototype.connect parks on a gate before the assignment, and
 * close/listTools/getServerMetadata are stubbed at the same boundary. The
 * control proves the harness would observe a resurrect if one occurred.
 */
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../src/client.js';
import { createMCPServerOperationState } from '../src/operations.js';
import { MCPRegistry } from '../src/registry.js';

function makeRegistry() {
  return new MCPRegistry({
    toolRegistry: { register: vi.fn(), unregister: vi.fn() } as unknown as ToolRegistry,
    events: { emit: vi.fn(), on: vi.fn() } as unknown as EventBus,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
  });
}

function seedDormantSlot(registry: MCPRegistry, name: string) {
  const slot: any = {
    cfg: { name, transport: 'stdio', command: 'node' },
    state: 'dormant',
    client: undefined,
    lazy: true,
    toolNames: [],
    lazyTools: [],
    discoveredTools: [],
    lastUsed: Date.now(),
    reconnectPending: false,
    reconnectTimer: undefined,
    reconnectCycles: 0,
    attempts: 0,
    registeredLazy: true,
    onDisconnect: undefined,
    operations: createMCPServerOperationState(),
  };
  (registry as any).servers.set(name, slot);
  return slot;
}

/** Run a gated demand-wake with an optional stop() landing mid-park. */
async function scenario(withStop: boolean) {
  const registry = makeRegistry();
  const slot = seedDormantSlot(registry, 'inflight-fence');

  let releaseConnect!: () => void;
  const connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  let closedCount = 0;
  const spies = [
    vi.spyOn(MCPClient.prototype, 'connect').mockImplementation(async () => {
      await connectGate;
    }),
    vi.spyOn(MCPClient.prototype, 'close').mockImplementation(async () => {
      closedCount += 1;
    }),
    vi.spyOn(MCPClient.prototype, 'listTools').mockReturnValue([]),
    vi.spyOn(MCPClient.prototype, 'getServerMetadata').mockReturnValue(undefined),
  ];

  try {
    // Wake in flight: parks inside the gated transport connect BEFORE
    // attemptConnectSlot's assignment. singleFlightConnect's IIFE runs the
    // connect prefix synchronously, so by the first tick slot.connecting is
    // set, state is 'connecting', and no client is assigned yet.
    const wake = registry.ensureConnected('inflight-fence');
    await new Promise((resolve) => setImmediate(resolve));

    const preconditions = {
      connecting: slot.connecting !== undefined,
      clientUnassigned: slot.client === undefined,
      stateConnecting: slot.state === 'connecting',
    };

    if (withStop) {
      // The drain sees an EMPTY slot (zero passes) and resolves while the
      // transport connect is still parked — the exact residual window.
      await registry.stop('inflight-fence');
    }

    releaseConnect();
    const outcome = await wake.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
    await new Promise((resolve) => setImmediate(resolve));

    return { slot, closedCount, outcome, preconditions };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe('stop() vs in-flight demand-wake: the post-connect guard', () => {
  it('a wake parked pre-assignment must not resurrect a client after stop()', async () => {
    const { slot, closedCount, outcome, preconditions } = await scenario(true);
    // The scenario held: wake in flight, assignment pending.
    expect(preconditions.connecting).toBe(true);
    expect(preconditions.clientUnassigned).toBe(true);
    expect(preconditions.stateConnecting).toBe(true);

    // Pinned postcondition: no live client after stop() resolved.
    expect(
      slot.client,
      `slot.client must be undefined after stop(); state was ${slot.state}`,
    ).toBeUndefined();
    expect(slot.state).not.toBe('connected');
    // The guard closed the fresh client instead of orphaning its transport.
    expect(closedCount).toBeGreaterThanOrEqual(1);
    // The demand-wake itself failed (no client to hand out) — expected.
    expect(outcome).toBe('rejected');
  });

  it('CONTROL: without stop(), the same wake assigns a client (a resurrect would be detected)', async () => {
    const { slot, closedCount, outcome, preconditions } = await scenario(false);
    expect(preconditions.connecting).toBe(true);
    expect(outcome).toBe('resolved');
    expect(slot.client).toBeDefined();
    expect(slot.state).toBe('connected');
    expect(closedCount).toBe(0);
  });
});

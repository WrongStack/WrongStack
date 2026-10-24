/**
 * PROBE (round 24, disposable): does `MCPRegistry.stop()`'s bounded 2-pass drain
 * actually hold its postcondition when a demand-wake lands in the FINAL pass?
 *
 * Round 17 replaced stop()'s single teardown with a 2-pass drain, but every pass
 * still awaits `close()`, so the window is relocated, not closed. Two wakes are
 * enough to reach the last one:
 *   pass 1 detaches the original and parks on its close
 *   -> wake #1 installs client A
 *   -> pass 2 detaches A and parks on A.close()          <-- FINAL window
 *   -> wake #2 installs client B, loop ends
 *
 * Pinned postcondition under test (registry.test.ts:342): once `stop()` resolves,
 * `slot.client` is undefined. Also required by registry.test.ts:105-109 ("no
 * orphan client"): a client that was installed must not be left open.
 *
 * Harness fixes for round 18's two FALSE reds: gates are created eagerly per
 * client and released BY INDEX (no snapshot loop that can miss a later gate), and
 * each wake is awaited so no wake is coalesced by the fast path.
 */
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { describe, expect, it, vi } from 'vitest';
import { createMCPServerOperationState } from '../src/operations.js';
import { MCPRegistry } from '../src/registry.js';

function makeClient() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    close: vi.fn(async () => {
      await gate;
    }),
    removeExitListener: vi.fn(),
    removeDisconnectListener: vi.fn(),
    removeToolsChangedListener: vi.fn(),
  };
}

describe('stop() final-drain-window postcondition', () => {
  it('leaves no live client when a wake lands in the last drain pass', async () => {
    const registry = new MCPRegistry({
      toolRegistry: { register: vi.fn(), unregister: vi.fn() } as unknown as ToolRegistry,
      events: { emit: vi.fn(), on: vi.fn() } as unknown as EventBus,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    });

    const original = makeClient();
    const slot: any = {
      cfg: { name: 'late-wake', transport: 'stdio', command: 'node' },
      state: 'connected',
      client: original,
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
      onDisconnect: vi.fn(),
      operations: createMCPServerOperationState(),
    };
    (registry as any).servers.set('late-wake', slot);

    // Every wake installs its OWN client, synchronously, exactly as
    // registry-connect-loop.ts:266-269 assigns client/onDisconnect/state.
    const installed: any[] = [];
    vi.spyOn(registry as any, 'attemptConnect').mockImplementation(async (s: any) => {
      const fresh = makeClient();
      installed.push(fresh);
      s.client = fresh;
      s.onDisconnect = vi.fn();
      s.state = 'connected';
    });

    const stopping = registry.stop('late-wake'); // pass 1 parked on original.close
    await registry.ensureConnected('late-wake'); // wake #1 -> client A
    original.release(); // pass 1 done; pass 2 detaches A and parks on A.close
    await new Promise((r) => setImmediate(r));
    await registry.ensureConnected('late-wake'); // wake #2 -> client B, in the FINAL window
    installed[0]?.release(); // pass 2 finishes; the drain detaches B and parks on B.close
    // The drain-until-empty stop() awaits EVERY close it initiates, so the
    // harness must open the final client's gate as well. Under the old bounded
    // loop this line was unreachable behavior (B was never closed — the bug);
    // without it the fixed drain correctly refuses to resolve.
    installed[1]?.release();
    await stopping;

    expect(installed).toHaveLength(2);
    // Pinned postcondition.
    expect(slot.client).toBeUndefined();
    // No orphan: B was installed, so B must have been closed.
    expect(installed[1].close).toHaveBeenCalled();
  });

  it('drains ANY number of final-window wakes — a pass bound must not return', async () => {
    // Round 27: the drain loops until the slot is EMPTY. A bounded pass count
    // (2, 3, …) only relocates the orphan window to its last pass, so this
    // pins the same postcondition for a wake count beyond any plausible bound.
    const registry = new MCPRegistry({
      toolRegistry: { register: vi.fn(), unregister: vi.fn() } as unknown as ToolRegistry,
      events: { emit: vi.fn(), on: vi.fn() } as unknown as EventBus,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    });
    const original = makeClient();
    const slot: any = {
      cfg: { name: 'third-wake', transport: 'stdio', command: 'node' },
      state: 'connected',
      client: original,
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
      onDisconnect: vi.fn(),
      operations: createMCPServerOperationState(),
    };
    (registry as any).servers.set('third-wake', slot);
    const installed: any[] = [];
    vi.spyOn(registry as any, 'attemptConnect').mockImplementation(async (s: any) => {
      const fresh = makeClient();
      installed.push(fresh);
      s.client = fresh;
      s.onDisconnect = vi.fn();
      s.state = 'connected';
    });

    const stopping = registry.stop('third-wake'); // parks on original.close
    for (let i = 0; i < 3; i++) {
      await registry.ensureConnected('third-wake'); // wake #i+1 installs client i
      (i === 0 ? original.release : installed[i - 1].release)(); // previous close completes
      await new Promise((r) => setImmediate(r)); // drain advances onto the fresh client
    }
    installed[2]?.release(); // final client's gate — the drain awaits every close
    await stopping;

    expect(installed).toHaveLength(3);
    expect(slot.client).toBeUndefined();
    expect(installed.every((c) => c.close.mock.calls.length > 0)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { scheduleRegistryReconnect } from '../src/registry-reconnect.js';

describe('scheduleRegistryReconnect 32-bit timeout cap (F2235)', () => {
  it('caps oversized reconnect delays to 32-bit setTimeout max instead of overflowing to 1ms', async () => {
    let attempted = 0;
    const slot = {
      cfg: { name: 'demo' },
      state: 'disconnected',
      reconnectPending: false,
      reconnectCycles: 0,
      reconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    };

    scheduleRegistryReconnect({
      slot: slot as unknown as Parameters<typeof scheduleRegistryReconnect>[0]['slot'],
      events: { emit: () => {} } as unknown as Parameters<
        typeof scheduleRegistryReconnect
      >[0]['events'],
      log: { error: () => {}, warn: () => {}, info: () => {} } as unknown as Parameters<
        typeof scheduleRegistryReconnect
      >[0]['log'],
      maxReconnectCycles: 3,
      baseReconnectDelayMs: 1e15,
      maxReconnectDelayMs: 1e15,
      recordReconnectExhausted: () => {},
      attemptReconnect: async () => {
        attempted++;
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    if (slot.reconnectTimer) clearTimeout(slot.reconnectTimer);
    expect(attempted).toBe(0);
  });
});

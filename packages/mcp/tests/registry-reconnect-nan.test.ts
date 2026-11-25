import { describe, expect, it } from 'vitest';
import { scheduleRegistryReconnect } from '../src/registry-reconnect.js';
import type { ServerSlot } from '../src/registry-slots.js';

describe('scheduleRegistryReconnect non-finite bounds', () => {
  it('exhausts immediately instead of scheduling an infinite loop when maxReconnectCycles is NaN', () => {
    let exhausted = false;
    const slot = {
      cfg: { name: 'srv' },
      state: 'disconnected',
      reconnectCycles: 0,
      reconnectPending: false,
      reconnectTimer: undefined,
    } as unknown as ServerSlot;

    scheduleRegistryReconnect({
      slot,
      events: { emit() {} } as never,
      log: { error() {}, warn() {}, info() {}, debug() {} } as never,
      maxReconnectCycles: Number.NaN,
      baseReconnectDelayMs: Number.NaN,
      maxReconnectDelayMs: Number.NaN,
      recordReconnectExhausted: () => {
        exhausted = true;
      },
      attemptReconnect: async () => {},
    });
    if (slot.reconnectTimer) clearTimeout(slot.reconnectTimer);
    expect(exhausted).toBe(true);
    expect(slot.state).toBe('failed');
    expect(slot.reconnectPending).toBe(false);
  });
});

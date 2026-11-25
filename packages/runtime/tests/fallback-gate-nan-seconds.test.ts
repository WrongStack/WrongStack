import type { EventBus } from '@wrongstack/contracts/kernel';
import { describe, expect, it } from 'vitest';
import { createFallbackGate } from '../src/fallback-gate.js';

describe('createFallbackGate (F2182)', () => {
  it('emits sanitized autoSwitchSeconds=0 when input autoSwitchSeconds is non-finite', async () => {
    let emittedSeconds: number | undefined;
    const listeners = new Map<string, Set<(p: unknown) => void>>();
    const bus = {
      listenerCount: (ev: string) => listeners.get(ev)?.size ?? 0,
      on(ev: string, fn: (p: unknown) => void) {
        const s = listeners.get(ev) ?? new Set();
        s.add(fn);
        listeners.set(ev, s);
      },
      off(ev: string, fn: (p: unknown) => void) {
        listeners.get(ev)?.delete(fn);
      },
      emit(ev: string, payload: unknown) {
        for (const fn of [...(listeners.get(ev) ?? [])]) fn(payload);
      },
    };

    bus.on('provider.fallback_pending', (p) => {
      emittedSeconds = (p as { autoSwitchSeconds?: number }).autoSwitchSeconds;
      bus.emit('provider.fallback_choice', { requestId: 'req-1', autoSwitch: true });
    });

    const gate = createFallbackGate(bus as unknown as EventBus);
    await gate({
      events: bus as unknown as EventBus,
      sessionId: 's1',
      from: { providerId: 'openai', model: 'gpt-5' },
      status: 429,
      candidates: [{ providerId: 'anthropic', model: 'claude' }],
      autoSwitchSeconds: Number.NaN,
      requestId: 'req-1',
    });

    expect(emittedSeconds).toBe(0);
  });
});

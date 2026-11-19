import type { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFallbackGate } from '../src/fallback-gate.js';

function createStubBus(
  onPending: (payload: { requestId?: string }, choiceListeners: Set<(p: unknown) => void>) => void,
) {
  const choiceListeners = new Set<(payload: unknown) => void>();
  const bus = {
    listenerCount(event: string) {
      if (event === 'provider.fallback_pending') return 1;
      if (event === 'provider.fallback_choice') return choiceListeners.size;
      return 0;
    },
    on(event: string, fn: (payload: unknown) => void) {
      if (event === 'provider.fallback_choice') choiceListeners.add(fn);
      return () => choiceListeners.delete(fn);
    },
    off(event: string, fn: (payload: unknown) => void) {
      if (event === 'provider.fallback_choice') choiceListeners.delete(fn);
    },
    emit(event: string, payload: { requestId?: string }) {
      if (event === 'provider.fallback_pending') {
        onPending(payload, choiceListeners);
      }
    },
  } as unknown as EventBus;
  return { bus, choiceListenerCount: () => choiceListeners.size };
}

describe('createFallbackGate timer clamping and throw cleanup (F563)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cleans up both timers and the choice listener when emit throws synchronously', async () => {
    const activeTimers = new Set<number>();
    let nextId = 1;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => {
      const id = nextId++;
      activeTimers.add(id);
      return id as never;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id: unknown) => {
      activeTimers.delete(Number(id));
    }) as typeof clearTimeout);

    const { bus, choiceListenerCount } = createStubBus(() => {
      throw new Error('modal crash');
    });

    await expect(
      createFallbackGate(bus)({
        events: bus,
        sessionId: 's1',
        from: { providerId: 'a', model: 'm1' },
        status: 529,
        candidates: [{ providerId: 'b', model: 'm2' }],
        autoSwitchSeconds: 10,
        requestId: 'r-throw',
      }),
    ).rejects.toThrow('modal crash');

    expect(activeTimers.size).toBe(0);
    expect(choiceListenerCount()).toBe(0);
  });

  it('clamps huge autoSwitchSeconds to 2_147_483_647 ms to prevent 32-bit timer overflow', async () => {
    const scheduledDelays: number[] = [];
    let nextId = 1;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((_fn: () => void, ms?: number) => {
      scheduledDelays.push(ms ?? 0);
      return nextId++ as never;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    const { bus, choiceListenerCount } = createStubBus((p, listeners) => {
      for (const fn of [...listeners]) {
        fn({ requestId: p.requestId, providerId: 'openai', model: 'gpt-4o' });
      }
    });

    const choice = await createFallbackGate(bus)({
      events: bus,
      sessionId: 's2',
      from: { providerId: 'a', model: 'm1' },
      status: 529,
      candidates: [{ providerId: 'openai', model: 'gpt-4o' }],
      autoSwitchSeconds: Number.MAX_SAFE_INTEGER,
      requestId: 'r-huge',
    });

    expect(choice).toEqual({ providerId: 'openai', model: 'gpt-4o' });
    expect(scheduledDelays).toEqual([2_147_483_647, 2_147_483_647]);
    expect(choiceListenerCount()).toBe(0);
  });
});

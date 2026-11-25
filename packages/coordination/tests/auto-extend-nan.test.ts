import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it } from 'vitest';
import { attachAutoExtend } from '../src/auto-extend.js';

type Listener = (payload: unknown) => void;

function makeBus() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(event: string, fn: Listener) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((item) => item !== fn),
        );
      };
    },
    emit(event: string, payload: unknown) {
      for (const fn of listeners.get(event) ?? []) fn(payload);
    },
  };
}

describe('attachAutoExtend non-finite guards (F1978)', () => {
  it('falls back to default factor when factor is NaN and denies non-finite limits', () => {
    const bus = makeBus();
    attachAutoExtend(bus as unknown as EventBus, { factor: Number.NaN });
    let extended: Record<string, number> | null = null;
    bus.emit('budget.threshold_reached', {
      kind: 'iterations',
      limit: 100,
      extend: (patch: Record<string, number>) => {
        extended = patch;
      },
      deny: () => {},
    });
    expect(extended).toEqual({ maxIterations: 150 });

    let denied = false;
    bus.emit('budget.threshold_reached', {
      kind: 'iterations',
      limit: Number.NaN,
      extend: () => {
        throw new Error('should not extend NaN limit');
      },
      deny: () => {
        denied = true;
      },
    });
    expect(denied).toBe(true);
  });
});

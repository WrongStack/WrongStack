import { describe, expect, it, vi } from 'vitest';
import { AdaptiveConcurrencyController } from '../src/adaptive-concurrency.js';
import type { FleetBus, FleetEvent } from '../src/fleet-bus.js';

function makeFleetBus() {
  const handlers: Array<(e: FleetEvent) => void> = [];
  return {
    onAny: vi.fn((h: (e: FleetEvent) => void) => {
      handlers.push(h);
      return () => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      };
    }),
    emit(event: FleetEvent) {
      for (const h of [...handlers]) h(event);
    },
  } as unknown as FleetBus;
}

const ev = (type: string, payload: unknown): FleetEvent => ({
  subagentId: 'sub-1',
  ts: 0,
  type,
  payload,
});
describe('AdaptiveConcurrencyController', () => {
  it('applies the initial concurrency + subscribes when enabled', () => {
    const bus = makeFleetBus();
    const setMax = vi.fn();
    const onState = vi.fn();
    new AdaptiveConcurrencyController(
      bus,
      setMax,
      { enabled: true, maxConcurrent: 16, minConcurrent: 1, decreaseFactor: 0.5 },
      onState,
    );
    expect(setMax).toHaveBeenCalledWith(16);
    expect(bus.onAny).toHaveBeenCalledTimes(1);
  });

  it('does NOT apply concurrency or subscribe when disabled', () => {
    const bus = makeFleetBus();
    const setMax = vi.fn();
    new AdaptiveConcurrencyController(bus, setMax, { enabled: false });
    expect(setMax).not.toHaveBeenCalled();
    expect(bus.onAny).not.toHaveBeenCalled();
  });

  it('uses the frozen defaults for every omitted config field', () => {
    const bus = makeFleetBus();
    const c = new AdaptiveConcurrencyController(bus, vi.fn(), {});
    const s = c.getState();
    expect(s.enabled).toBe(false);
    expect(s.min).toBe(1);
    expect(s.max).toBe(16);
    expect(s.current).toBe(16);
  });

  it('ignores fleet events after being runtime-disabled via updateConfig', () => {
    const bus = makeFleetBus();
    const setMax = vi.fn();
    const c = new AdaptiveConcurrencyController(bus, setMax, {
      enabled: true,
      maxConcurrent: 16,
      decreaseFactor: 0.5,
    });
    c.updateConfig({ enabled: false });
    (bus as unknown as { emit: (e: FleetEvent) => void }).emit(ev('error', { status: 429 }));
    // handler returned early (disabled) -> no decrease
    expect(c.getState().current).toBe(16);
    expect(c.getState().totalDecreases).toBe(0);
  });

  it('decreases concurrency by decreaseFactor on a 429 and notifies', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const bus = makeFleetBus();
    const setMax = vi.fn();
    const onState = vi.fn();
    const c = new AdaptiveConcurrencyController(
      bus,
      setMax,
      { enabled: true, maxConcurrent: 16, minConcurrent: 1, decreaseFactor: 0.5 },
      onState,
    );
    bus.emit(ev('error', { status: 429 }));
    expect(c.getState().current).toBe(8);
    expect(c.getState().totalDecreases).toBe(1);
    expect(setMax).toHaveBeenLastCalledWith(8);
    expect(onState).toHaveBeenCalled();
    // also exercises the code + kind payload branches via provider_error
    bus.emit(ev('provider_error', { code: 'rate_limit_error' }));
    expect(c.getState().current).toBe(4);
    bus.emit(ev('error', { kind: 'rate_limit' }));
    expect(c.getState().current).toBe(2);
    logSpy.mockRestore();
  });

  it('only tracks failures (no decrease) once at the minimum', () => {
    const bus = makeFleetBus();
    const setMax = vi.fn();
    const c = new AdaptiveConcurrencyController(bus, setMax, {
      enabled: true,
      maxConcurrent: 2,
      minConcurrent: 1,
      decreaseFactor: 0.5,
    });
    bus.emit(ev('error', { status: 429 })); // 2 -> 1
    expect(c.getState().current).toBe(1);
    expect(c.getState().totalDecreases).toBe(1);
    bus.emit(ev('error', { status: 429 })); // already at min -> track only, no decrease
    expect(c.getState().current).toBe(1);
    expect(c.getState().totalDecreases).toBe(1); // unchanged
    expect(c.getState().consecutiveFailures).toBe(2);
  });

  it('does not decrease when the computed concurrency would not drop (factor>=1)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const bus = makeFleetBus();
    const setMax = vi.fn();
    const c = new AdaptiveConcurrencyController(bus, setMax, {
      enabled: true,
      maxConcurrent: 16,
      minConcurrent: 1,
      decreaseFactor: 1,
    });
    bus.emit(ev('error', { status: 429 }));
    expect(c.getState().current).toBe(16); // unchanged
    expect(c.getState().totalDecreases).toBe(0);
    logSpy.mockRestore();
  });

  it('ignores non-rate-limit errors and non-error events', () => {
    const bus = makeFleetBus();
    const setMax = vi.fn();
    const c = new AdaptiveConcurrencyController(bus, setMax, {
      enabled: true,
      maxConcurrent: 16,
      decreaseFactor: 0.5,
    });
    bus.emit(ev('error', { status: 500 })); // not 429 / rate_limit
    bus.emit(ev('provider_error', {})); // no matching payload key
    bus.emit(ev('tool.executed', { status: 429 })); // wrong type
    bus.emit(ev('error', undefined)); // non-object payload
    expect(c.getState().current).toBe(16);
    expect(c.getState().totalDecreases).toBe(0);
  });

  it('decrease(target) sets an explicit value; decrease() uses the factor; both noop without a drop', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const bus = makeFleetBus();
    const setMax = vi.fn();
    const c = new AdaptiveConcurrencyController(bus, setMax, {
      enabled: true,
      maxConcurrent: 16,
      minConcurrent: 1,
      decreaseFactor: 0.5,
    });
    c.decrease(4); // explicit
    expect(c.getState().current).toBe(4);
    expect(setMax).toHaveBeenLastCalledWith(4);
    c.decrease(); // factor: floor(4*0.5)=2
    expect(c.getState().current).toBe(2);
    expect(setMax).toHaveBeenLastCalledWith(2);
    c.decrease(100); // no drop (100 >= 2) -> noop
    expect(c.getState().current).toBe(2);
    logSpy.mockRestore();
  });

  it('decrease() is a no-op when disabled', () => {
    const bus = makeFleetBus();
    const c = new AdaptiveConcurrencyController(bus, vi.fn(), {
      enabled: false,
      maxConcurrent: 16,
    });
    c.decrease(1);
    expect(c.getState().current).toBe(16);
  });

  it('updateConfig applies each field, clamps current, and notifies', () => {
    const bus = makeFleetBus();
    const onState = vi.fn();
    const c = new AdaptiveConcurrencyController(
      bus,
      vi.fn(),
      {
        enabled: true,
        maxConcurrent: 16,
        minConcurrent: 1,
        decreaseFactor: 0.5,
        successThreshold: 10,
        recoveryIntervalMs: 30_000,
      },
      onState,
    );
    onState.mockClear();
    c.updateConfig({
      enabled: false,
      minConcurrent: 2,
      maxConcurrent: 6,
      decreaseFactor: 0.25,
      successThreshold: 5,
      recoveryIntervalMs: 10_000,
    });
    const s = c.getState();
    expect(s.enabled).toBe(false);
    expect(s.min).toBe(2);
    expect(s.max).toBe(6);
    // current(16) clamped to max(6)
    expect(s.current).toBe(6);
    expect(onState).toHaveBeenCalled();
  });

  it('updateConfig with a partial config only touches the supplied fields', () => {
    const bus = makeFleetBus();
    const c = new AdaptiveConcurrencyController(bus, vi.fn(), {
      enabled: true,
      maxConcurrent: 16,
      minConcurrent: 1,
      decreaseFactor: 0.5,
      successThreshold: 10,
      recoveryIntervalMs: 30_000,
    });
    c.updateConfig({ maxConcurrent: 8 });
    const s = c.getState();
    expect(s.max).toBe(8);
    expect(s.enabled).toBe(true); // untouched
    expect(s.min).toBe(1); // untouched
  });

  it('onStateChange registers + unregisters a handler (idempotent unsubscribe)', () => {
    const bus = makeFleetBus();
    const c = new AdaptiveConcurrencyController(bus, vi.fn(), {
      enabled: true,
      maxConcurrent: 16,
      decreaseFactor: 0.5,
    });
    const handler = vi.fn();
    const off = c.onStateChange(handler);
    c.decrease(8); // triggers notifyStateChange -> handler
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    off(); // second call hits the index===-1 guard
    c.decrease(4);
    expect(handler).toHaveBeenCalledTimes(1); // not called again
  });

  it('dispose detaches fleet listeners and clears handlers', () => {
    const bus = makeFleetBus();
    const setMax = vi.fn();
    const c = new AdaptiveConcurrencyController(bus, setMax, {
      enabled: true,
      maxConcurrent: 16,
      decreaseFactor: 0.5,
    });
    c.dispose();
    // After dispose, a 429 event must not change state (listener detached).
    (bus as unknown as { emit: (e: FleetEvent) => void }).emit(ev('error', { status: 429 }));
    expect(c.getState().current).toBe(16);
    expect(c.getState().totalDecreases).toBe(0);
  });

  it('subscribes and applies initial concurrency when runtime-enabled via updateConfig', () => {
    const bus = makeFleetBus();
    const setMax = vi.fn();
    const c = new AdaptiveConcurrencyController(bus, setMax, {
      enabled: false,
      maxConcurrent: 16,
      minConcurrent: 1,
      decreaseFactor: 0.5,
    });

    expect(setMax).not.toHaveBeenCalled();
    expect(bus.onAny).not.toHaveBeenCalled();

    c.updateConfig({ enabled: true });

    expect(setMax).toHaveBeenCalledWith(16);
    expect(bus.onAny).toHaveBeenCalledTimes(1);

    // Fleet events are now handled
    (bus as unknown as { emit: (e: FleetEvent) => void }).emit(ev('error', { status: 429 }));
    expect(c.getState().current).toBe(8);
    expect(setMax).toHaveBeenLastCalledWith(8);
  });

  it('updates coordinator concurrency when updateConfig clamps current bounds', () => {
    const bus = makeFleetBus();
    const setMax = vi.fn();
    const c = new AdaptiveConcurrencyController(bus, setMax, {
      enabled: true,
      maxConcurrent: 16,
      minConcurrent: 1,
    });
    setMax.mockClear();

    // Clamp current from 16 to 6
    c.updateConfig({ maxConcurrent: 6 });
    expect(c.getState().current).toBe(6);
    expect(setMax).toHaveBeenLastCalledWith(6);

    // Clamp current from 6 to 8
    c.updateConfig({ maxConcurrent: 10, minConcurrent: 8 });
    expect(c.getState().current).toBe(8);
    expect(setMax).toHaveBeenLastCalledWith(8);
  });

  it('clamps explicit decrease(target) to minConcurrent floor (F29)', () => {
    const bus = makeFleetBus();
    const setMax = vi.fn();
    const c = new AdaptiveConcurrencyController(bus, setMax, {
      enabled: true,
      maxConcurrent: 8,
      minConcurrent: 3,
      decreaseFactor: 0.5,
    });
    setMax.mockClear();

    c.decrease(0);
    expect(c.getState().current).toBe(3);
    expect(setMax).toHaveBeenCalledWith(3);

    c.decrease(-5);
    expect(c.getState().current).toBe(3);
    expect(setMax).toHaveBeenCalledTimes(1);
  });

  it('normalizes inverted min/max bounds, invalid decreaseFactor, and fractional or NaN decrease targets (F121)', () => {
    const bus = makeFleetBus();
    const setMax = vi.fn();
    const c = new AdaptiveConcurrencyController(bus, setMax, {
      enabled: true,
      minConcurrent: 2,
      maxConcurrent: 8,
      decreaseFactor: 0.5,
    });
    c.decrease(3.7);
    expect(c.getState().current).toBe(3);
    c.decrease(Number.NaN);
    expect(c.getState().current).toBe(2);

    c.updateConfig({ minConcurrent: 10, maxConcurrent: 4, decreaseFactor: -1 });
    const s = c.getState();
    expect(s.min).toBe(10);
    expect(s.max).toBe(10);
    expect(s.current).toBe(10);
  });
});

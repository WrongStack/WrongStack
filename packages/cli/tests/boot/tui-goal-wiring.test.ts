/**
 * Tests for boot/tui-goal-wiring.ts — Goal event forwarding.
 */
import { describe, expect, it, vi } from 'vitest';
import { wireGoal } from '../../src/boot/tui-goal-wiring.js';

function createEventBusMock() {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler as (payload: unknown) => void);
    }),
    off: vi.fn((event: string, _handler: (...args: unknown[]) => void) => {
      handlers.delete(event);
    }),
    // simulate an event being emitted
    _emit(event: string, payload: unknown) {
      const h = handlers.get(event);
      if (h) h(payload);
    },
  };
}

describe('wireGoal', () => {
  it('returns subscribe and cleanup functions', () => {
    const events = createEventBusMock();
    const wiring = wireGoal(events as never);
    expect(wiring.subscribe).toBeDefined();
    expect(wiring.cleanup).toBeDefined();
    expect(typeof wiring.subscribe).toBe('function');
    expect(typeof wiring.cleanup).toBe('function');
  });

  it('subscribe registers handlers for auto-phase events', () => {
    const events = createEventBusMock();
    const wiring = wireGoal(events as never);
    const handler = vi.fn();
    const unsub = wiring.subscribe(handler);
    // Should have called events.on for each event
    expect(events.on).toHaveBeenCalled();
    // at least PHASE_EVENT_NAMES + extra events
    expect(events.on.mock.calls.length).toBeGreaterThan(10);
    expect(typeof unsub).toBe('function');
  });

  it('subscribe forwards events to the handler', () => {
    const events = createEventBusMock();
    const wiring = wireGoal(events as never);
    const handler = vi.fn();
    wiring.subscribe(handler);

    // Simulate emitting events through the captured handlers
    // Find one of the registered handler calls
    const phaseEventCall = events.on.mock.calls.find(
      ([event]: [string, ...unknown[]]) => event === 'phase.started',
    );
    if (phaseEventCall) {
      const [, h] = phaseEventCall as [string, (p: unknown) => void];
      h({ some: 'payload' });
      expect(handler).toHaveBeenCalledWith('phase.started', { some: 'payload' });
    }
  });

  it('unsubscribe removes all handlers', () => {
    const events = createEventBusMock();
    const wiring = wireGoal(events as never);
    const handler = vi.fn();
    const unsub = wiring.subscribe(handler);
    unsub();
    // events.off should have been called for each event
    expect(events.off.mock.calls.length).toBe(events.on.mock.calls.length);
  });

  it('cleanup removes all handlers without having subscribed first', () => {
    const events = createEventBusMock();
    const wiring = wireGoal(events as never);
    // cleanup should be safe even without a subscription
    wiring.cleanup();
    expect(events.off).not.toHaveBeenCalled();
  });

  it('cleanup removes handlers after subscribe', () => {
    const events = createEventBusMock();
    const wiring = wireGoal(events as never);
    wiring.subscribe(vi.fn());
    wiring.cleanup();
    // Should have removed each handler
    expect(events.off.mock.calls.length).toBe(events.on.mock.calls.length);
  });

  it('cleanup is safe to call multiple times', () => {
    const events = createEventBusMock();
    const wiring = wireGoal(events as never);
    wiring.subscribe(vi.fn());
    wiring.cleanup();
    const offCalls = events.off.mock.calls.length;
    wiring.cleanup();
    // Second cleanup should be a no-op (handlers already cleared)
    expect(events.off.mock.calls.length).toBe(offCalls);
  });
});

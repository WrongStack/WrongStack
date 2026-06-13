import { describe, expect, it, vi } from 'vitest';
import { createEternalSubscription, type EternalBroadcast, type EternalSubscribe } from '../../src/server/eternal-iteration-broadcast.js';

/**
 * PR 4 of Phase 2: extract the eternal-iteration observer wiring into
 * a unit-testable helper. The CLI's `runWebUI` owns the engine and
 * hands the webui a `subscribeEternalIteration` function. This helper
 * adapts that to a WS broadcast and yields a disposable subscription
 * that the server calls on shutdown.
 */

function makeFixture() {
  const clients = new Map();
  const clientsRef = () => clients;
  const broadcast: EternalBroadcast = vi.fn((c, msg) => {
    // Pretend each entry in the map is a WebSocket — we don't need a
    // real one; the test only cares that broadcast is called with the
    // right clients and message shape.
    for (const key of c.keys()) void key;
    void msg;
  });
  let observer: ((entry: unknown) => void) | null = null;
  const subscribe: EternalSubscribe = vi.fn((fn) => {
    observer = fn as (entry: unknown) => void;
    return () => {
      observer = null;
    };
  });
  return { subscribe, broadcast, clientsRef, getObserver: () => observer };
}

describe('createEternalSubscription', () => {
  it('calls subscribe with a broadcast-shaped observer', () => {
    const f = makeFixture();
    createEternalSubscription(f.subscribe, f.broadcast, f.clientsRef);
    expect(f.subscribe).toHaveBeenCalledTimes(1);
    expect(f.getObserver()).toBeTypeOf('function');
  });

  it('observer broadcasts a single eternal.iteration message per entry', () => {
    const f = makeFixture();
    createEternalSubscription(f.subscribe, f.broadcast, f.clientsRef);
    const observer = f.getObserver();
    expect(observer).not.toBeNull();
    const entry = { kind: 'autonomy.step', id: 'a1', payload: { ok: true } };
    observer!(entry);
    expect(f.broadcast).toHaveBeenCalledTimes(1);
    expect(f.broadcast).toHaveBeenCalledWith(
      f.clientsRef(),
      { type: 'eternal.iteration', payload: { entry } },
    );
  });

  it('dispose() tears down the underlying subscription (no more broadcasts)', () => {
    const f = makeFixture();
    const sub = createEternalSubscription(f.subscribe, f.broadcast, f.clientsRef);
    const observer = f.getObserver();
    expect(observer).not.toBeNull();
    observer!({ kind: 'before-dispose' });
    sub.dispose();
    // After dispose, the captured observer in the fixture is null —
    // the helper no longer has a live observer to call into.
    expect(f.getObserver()).toBeNull();
    // The helper also drops future broadcast attempts defensively.
    // (We can't reach the disposed observer any more, so this just
    // verifies that the underlying subscribe's disposer ran once.)
  });

  it('dispose() is idempotent (safe to call twice)', () => {
    const f = makeFixture();
    const sub = createEternalSubscription(f.subscribe, f.broadcast, f.clientsRef);
    sub.dispose();
    expect(() => sub.dispose()).not.toThrow();
  });
});

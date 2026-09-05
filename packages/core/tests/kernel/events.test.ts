import { describe, expect, it, vi } from 'vitest';
import { EventBus, ScopedEventBus } from '../../src/kernel/events.js';

describe('ScopedEventBus', () => {
  it('tracks listener count via scopedListenerCount', () => {
    const bus = new ScopedEventBus();
    expect(bus.scopedListenerCount).toBe(0);
    bus.on('session.started', vi.fn());
    expect(bus.scopedListenerCount).toBe(1);
    bus.on('tool.executed', vi.fn());
    expect(bus.scopedListenerCount).toBe(2);
    bus.off('session.started', vi.fn());
    bus.off('tool.executed', vi.fn());
  });

  it('on() returns unsubscribe that is also tracked', () => {
    const bus = new ScopedEventBus();
    const fn = vi.fn();
    bus.on('session.started', fn);
    expect(bus.scopedListenerCount).toBe(1);
    bus.emit('session.started', { id: '1' });
    expect(fn).toHaveBeenCalled();
  });

  it('once() returns tracked unsubscribe and fully cleans up on fire', () => {
    const bus = new ScopedEventBus();
    const fn = vi.fn();
    const off = bus.once('session.started', fn);
    expect(bus.scopedListenerCount).toBe(1);
    bus.emit('session.started', { id: '1' });
    expect(fn).toHaveBeenCalledTimes(1);
    // After the once-listener fires, BOTH the underlying EventBus listener
    // and the ScopedEventBus tracking entry are removed. scopedListenerCount
    // returns to its pre-call value so the public metric is honest.
    expect(bus.scopedListenerCount).toBe(0);
    // The returned off is now a no-op: the underlying listener is already
    // gone, and the tracking entry was deleted in the wrapper.
    expect(() => off()).not.toThrow();
    expect(bus.scopedListenerCount).toBe(0);
  });

  it('once() tracking entry is removed BEFORE the user fn runs (mid-fire introspection sees the post-state)', () => {
    const bus = new ScopedEventBus();
    let countInsideHandler = -1;
    bus.once('session.started', () => {
      countInsideHandler = bus.scopedListenerCount;
    });
    bus.emit('session.started', { id: '1' });
    expect(countInsideHandler).toBe(0);
  });

  it('once() with explicit off before emit also cleans up the tracking entry', () => {
    const bus = new ScopedEventBus();
    const fn = vi.fn();
    const off = bus.once('session.started', fn);
    expect(bus.scopedListenerCount).toBe(1);
    off();
    expect(bus.scopedListenerCount).toBe(0);
    bus.emit('session.started', { id: '1' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('teardown() removes all tracked listeners', () => {
    const bus = new ScopedEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const _offA = bus.on('session.started', a);
    const _offB = bus.on('tool.executed', b);
    expect(bus.scopedListenerCount).toBe(2);

    bus.teardown();

    expect(bus.scopedListenerCount).toBe(0);
    bus.emit('session.started', { id: '1' });
    bus.emit('tool.executed', { name: 'x', durationMs: 0, ok: true });
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('teardown() is idempotent', () => {
    const bus = new ScopedEventBus();
    bus.on('session.started', vi.fn());
    bus.teardown();
    expect(() => bus.teardown()).not.toThrow();
  });

  it('teardown() also calls clear() on the underlying bus', () => {
    const bus = new ScopedEventBus();
    bus.on('session.started', vi.fn());
    bus.teardown();
    // clear() would have removed all underlying listeners too
    bus.emit('session.started', { id: '1' });
    // if clear() was called, no listeners fire
  });

  it('[Symbol.dispose] aliases teardown()', () => {
    const bus = new ScopedEventBus();
    const fn = vi.fn();
    bus.on('session.started', fn);
    expect(bus.scopedListenerCount).toBe(1);
    bus[Symbol.dispose]();
    expect(bus.scopedListenerCount).toBe(0);
  });

  it('onPattern() registers and can be torn down', () => {
    const bus = new ScopedEventBus();
    const fn = vi.fn();
    bus.onPattern('tool.*', fn);
    expect(bus.scopedListenerCount).toBe(1);
    bus.teardown();
    expect(bus.scopedListenerCount).toBe(0);
  });

  it('onRegex() registers and can be torn down', () => {
    const bus = new ScopedEventBus();
    const fn = vi.fn();
    bus.onRegex(/^session\./, fn);
    expect(bus.scopedListenerCount).toBe(1);
    bus.teardown();
    expect(bus.scopedListenerCount).toBe(0);
  });

  it('onAny() registers and can be torn down', () => {
    const bus = new ScopedEventBus();
    const fn = vi.fn();
    bus.onAny(fn);
    expect(bus.scopedListenerCount).toBe(1);
    bus.teardown();
    expect(bus.scopedListenerCount).toBe(0);
  });

  it('scoped unsubscribe removes from tracking but does not affect other listeners', () => {
    const bus = new ScopedEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.on('session.started', a);
    bus.on('session.started', b);
    expect(bus.scopedListenerCount).toBe(2);

    offA(); // manually unsubscribe a

    expect(bus.scopedListenerCount).toBe(1);
    bus.emit('session.started', { id: '1' });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });
});

describe('EventBus', () => {
  it('emits to subscribers', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('session.started', fn);
    bus.emit('session.started', { id: 'abc' });
    expect(fn).toHaveBeenCalledWith({ id: 'abc' });
  });

  it('resets global regex state between matching emits', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.onRegex(/^session\./g, fn);

    bus.emit('session.started', { id: 'one' });
    bus.emit('session.started', { id: 'two' });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  describe('wildcard owner tags + count accessors', () => {
    it('records an owner tag on onPattern', () => {
      const bus = new EventBus();
      const error = vi.fn();
      bus.setLogger({ error });
      // Register up to the cap (MAX_WILDCARDS = 500), then a tagged one
      // must be REJECTED and the rejection log must name the owner.
      for (let i = 0; i < 500; i++) bus.onPattern(`wild.${i}`, vi.fn());
      bus.onPattern('over.cap', vi.fn(), 'chimera-test');
      const last = error.mock.calls.at(-1)?.[0] as string | undefined;
      expect(last).toContain('rejecting onPattern("over.cap")');
      expect(last).toContain('owner: chimera-test');
    });

    it('records an owner tag on onAny rejection', () => {
      const bus = new EventBus();
      const error = vi.fn();
      bus.setLogger({ error });
      for (let i = 0; i < 500; i++) bus.onPattern(`wild.${i}`, vi.fn());
      // EventBus.onAny forwards to onPattern('*', …) — no separate log.
      bus.onAny(vi.fn(), 'chimera-any');
      const last = error.mock.calls.at(-1)?.[0] as string | undefined;
      expect(last).toContain('rejecting onPattern("*")');
      expect(last).toContain('owner: chimera-any');
    });

    it('wildcardCount tracks registrations and disposals', () => {
      const bus = new EventBus();
      expect(bus.wildcardCount()).toBe(0);
      const offA = bus.onPattern('a.*', vi.fn());
      const offB = bus.onRegex(/^b\./, vi.fn());
      const offC = bus.onAny(vi.fn());
      expect(bus.wildcardCount()).toBe(3);
      offA();
      expect(bus.wildcardCount()).toBe(2);
      offB();
      offC();
      expect(bus.wildcardCount()).toBe(0);
    });
  });

  it('emits to multiple event types', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('session.started', a);
    bus.on('tool.executed', b);
    bus.emit('session.started', { id: '1' });
    bus.emit('tool.executed', { name: 'test', durationMs: 100, ok: true });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers each receive', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('session.started', a);
    bus.on('session.started', b);
    bus.emit('session.started', { id: '1' });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('off unsubscribes', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('session.started', fn);
    bus.off('session.started', fn);
    bus.emit('session.started', { id: '1' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('listener errors are isolated', () => {
    const bus = new EventBus();
    bus.setLogger({ error: () => undefined });
    const good = vi.fn();
    bus.on('session.started', () => {
      throw new Error('bad');
    });
    bus.on('session.started', good);
    bus.emit('session.started', { id: '1' });
    expect(good).toHaveBeenCalled();
  });

  it('unsubscribe returned from on()', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.on('session.started', fn);
    off();
    bus.emit('session.started', { id: '1' });
    expect(fn).not.toHaveBeenCalled();
  });

  describe('once', () => {
    it('fires listener only once', () => {
      const bus = new EventBus();
      const fn = vi.fn();
      bus.once('session.started', fn);
      bus.emit('session.started', { id: '1' });
      bus.emit('session.started', { id: '2' });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith({ id: '1' });
    });

    it('returns unsubscribe that prevents firing', () => {
      const bus = new EventBus();
      const fn = vi.fn();
      const off = bus.once('session.started', fn);
      off();
      bus.emit('session.started', { id: '1' });
      expect(fn).not.toHaveBeenCalled();
    });

    it('unsubscribes after first call even without explicit off', () => {
      const bus = new EventBus();
      const fn = vi.fn();
      bus.once('iteration.completed', fn);
      bus.emit('iteration.completed', { ctx: null as any, index: 1 });
      bus.emit('iteration.completed', { ctx: null as any, index: 2 });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes from correct event only', () => {
      const bus = new EventBus();
      const fn = vi.fn();
      bus.once('session.started', fn);
      bus.emit('session.started', { id: '1' });
      // other event type should not trigger
      bus.emit('tool.executed', { name: 'x', durationMs: 0, ok: true });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('clear', () => {
    it('removes all listeners', () => {
      const bus = new EventBus();
      const a = vi.fn();
      const b = vi.fn();
      bus.on('session.started', a);
      bus.on('tool.executed', b);
      bus.clear();
      bus.emit('session.started', { id: '1' });
      bus.emit('tool.executed', { name: 'x', durationMs: 0, ok: true });
      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    });

    it('clearing empty bus is fine', () => {
      const bus = new EventBus();
      expect(() => bus.clear()).not.toThrow();
    });
  });

  it('does not throw when emitting to empty event', () => {
    const bus = new EventBus();
    expect(() => bus.emit('error', { err: new Error('test'), phase: 'test' })).not.toThrow();
  });

  it('setLogger accepts logger', () => {
    const bus = new EventBus();
    expect(() => bus.setLogger({ error: () => {} })).not.toThrow();
  });

  it('onAny() is an alias for onPattern("*") and receives all events', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.onAny(fn);
    bus.emit('session.started', { id: '1' });
    bus.emit('tool.executed', { name: 'x', durationMs: 0, ok: true });
    bus.emit('error', { err: new Error('boom'), phase: 'test' });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenCalledWith('session.started', { id: '1' });
    expect(fn).toHaveBeenCalledWith('tool.executed', { name: 'x', durationMs: 0, ok: true });
  });

  it('onAny() returns working unsubscribe', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.onAny(fn);
    bus.emit('session.started', { id: '1' });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    bus.emit('session.started', { id: '2' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('emits error event with error and phase', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('error', fn);
    const err = new Error('boom');
    bus.emit('error', { err, phase: 'execution' });
    expect(fn).toHaveBeenCalledWith({ err, phase: 'execution' });
  });

  it('emit() snapshots wildcards so a pattern added mid-emit does not fire on the same emit', () => {
    // Regression guard: ECMA leaves mid-iteration array mutation
    // under-specified, so emit() takes a snapshot to make the behavior
    // engine-portable. The new pattern still fires on the NEXT emit.
    const bus = new EventBus();
    const late = vi.fn();
    bus.onPattern('*', () => {
      bus.onPattern('*', late);
    });
    bus.emit('session.started', { id: '1' });
    expect(late).not.toHaveBeenCalled();
    // The pattern IS now registered — the next emit should fire it.
    bus.emit('session.started', { id: '2' });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('emit() removes a wildcard mid-iteration without skipping the unvisited wildcards', () => {
    // Regression guard: if emit() didn't snapshot, removing an entry
    // mid-iteration could change which subsequent entries get visited.
    // The snapshot guarantees that every wildcard that was registered
    // BEFORE emit() runs gets a chance to fire exactly once.
    const bus = new EventBus();
    const order: string[] = [];
    const offB = bus.onPattern('*', () => {
      order.push('b');
      offB();
    });
    bus.onPattern('*', () => order.push('c'));
    bus.emit('session.started', { id: '1' });
    expect(order).toEqual(['b', 'c']);
  });

  it('off() prunes the empty Set so the internal map does not accumulate dead entries', () => {
    // Hygiene guard: off() must delete the now-empty Set from the listeners
    // map, not leave a dead 0-size entry behind. The map is private, so we
    // reach in to assert the entry is gone (the only observable proof).
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('session.started', fn);
    const internal = (bus as unknown as { listeners: Map<string, Set<unknown>> }).listeners;
    expect(internal.has('session.started')).toBe(true);
    bus.off('session.started', fn);
    expect(internal.has('session.started')).toBe(false);
    // off() on an unknown / already-pruned event must not throw.
    expect(() => bus.off('session.started', fn)).not.toThrow();
    // A surviving sibling listener keeps the entry alive.
    const a = vi.fn();
    const b = vi.fn();
    bus.on('tool.executed', a);
    bus.on('tool.executed', b);
    bus.off('tool.executed', a);
    expect(internal.has('tool.executed')).toBe(true);
    bus.off('tool.executed', b);
    expect(internal.has('tool.executed')).toBe(false);
  });

  it('emit() snapshots named listeners so one added mid-emit does not fire on the same emit', () => {
    // Regression guard: the named-listener loop must snapshot the Set like the
    // wildcard path does, so a listener that subscribes a sibling for the same
    // event mid-emit doesn't observe engine-dependent behavior. The new
    // listener fires on the NEXT emit instead.
    const bus = new EventBus();
    const late = vi.fn();
    bus.on('session.started', () => {
      bus.on('session.started', late);
    });
    bus.emit('session.started', { id: '1' });
    expect(late).not.toHaveBeenCalled();
    bus.emit('session.started', { id: '2' });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('emit() removes a named listener mid-iteration without skipping unvisited siblings', () => {
    // Regression guard: a listener that unsubscribes a sibling (or itself)
    // mid-emit must not change which subsequent named listeners get visited.
    // The snapshot guarantees every listener registered BEFORE emit() runs
    // fires exactly once, deterministically.
    const bus = new EventBus();
    const order: string[] = [];
    const offB = bus.on('session.started', () => {
      order.push('b');
      offB();
    });
    bus.on('session.started', () => order.push('c'));
    bus.emit('session.started', { id: '1' });
    expect(order).toEqual(['b', 'c']);
  });
});

describe('EventBus dispatch-array caching', () => {
  // emit() reuses a cached dispatch array instead of rebuilding one per event
  // (that allocation was per-emit on streaming paths). These pin the
  // invalidation: a stale cache would silently deliver to the wrong set.
  it('sees listeners subscribed after a previous emit', () => {
    const bus = new EventBus();
    const first = vi.fn();
    bus.on('session.started', first);
    bus.emit('session.started', { id: '1' });

    const second = vi.fn();
    bus.on('session.started', second);
    bus.emit('session.started', { id: '2' });

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops delivering to a listener removed after a previous emit', () => {
    const bus = new EventBus();
    const kept = vi.fn();
    const removed = vi.fn();
    bus.on('session.started', kept);
    const off = bus.on('session.started', removed);
    bus.emit('session.started', { id: '1' });

    off();
    bus.emit('session.started', { id: '2' });

    expect(kept).toHaveBeenCalledTimes(2);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('invalidates the wildcard cache on subscribe and unsubscribe', () => {
    const bus = new EventBus();
    const first = vi.fn();
    const off = bus.onAny(first);
    bus.emit('session.started', { id: '1' });

    const second = vi.fn();
    bus.onAny(second);
    bus.emit('session.started', { id: '2' });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);

    off();
    bus.emit('session.started', { id: '3' });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('invalidates both caches on clear()', () => {
    const bus = new EventBus();
    const named = vi.fn();
    const wild = vi.fn();
    bus.on('session.started', named);
    bus.onAny(wild);
    bus.emit('session.started', { id: '1' });

    bus.clear();
    bus.emit('session.started', { id: '2' });

    expect(named).toHaveBeenCalledTimes(1);
    expect(wild).toHaveBeenCalledTimes(1);
  });

  it('keeps snapshot semantics for a listener added during dispatch', () => {
    const bus = new EventBus();
    const late = vi.fn();
    bus.on('session.started', () => {
      bus.on('session.started', late);
    });

    // Added mid-dispatch: must not fire this round...
    bus.emit('session.started', { id: '1' });
    expect(late).not.toHaveBeenCalled();
    // ...but the invalidation must have landed, so it fires on the next.
    bus.emit('session.started', { id: '2' });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('keeps emitCustom wildcard delivery correct across subscription changes', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.onPattern('plugin.*', (event) => seen.push(`a:${event}`));
    bus.emitCustom('plugin.one', {});

    bus.onPattern('plugin.*', (event) => seen.push(`b:${event}`));
    bus.emitCustom('plugin.two', {});

    off();
    bus.emitCustom('plugin.three', {});

    expect(seen).toEqual(['a:plugin.one', 'a:plugin.two', 'b:plugin.two', 'b:plugin.three']);
  });
});

import type { EventName, Listener } from './event-map.js';
import { EventBus } from './event-bus.js';

/**
 * A decorator over `EventBus` that records every listener registration
 * (`.on`, `.once`, `.onPattern`, `.onRegex`) so that `teardown()` can
 * remove all of them at once — preventing the memory leaks that occur
 * when dynamic plugins or long-lived TUI/WebUI interfaces forget to
 * call `.off()` during session termination.
 *
 * Usage:
 * ```ts
 * const bus = new ScopedEventBus();
 * bus.on('tool.executed', handler1);   // tracked
 * bus.on('provider.response', handler2); // tracked
 * bus.onPattern('subagent.*', handler3); // tracked
 * // ... later, when the plugin or session is torn down:
 * bus.teardown(); // removes all three listeners
 * ```
 *
 * Also implements `Disposable` (via `[Symbol.dispose]`) for use with
 * the `using` keyword in Node ≥ 22, or can be used manually with
 * `bus.teardown()`.
 */
export class ScopedEventBus extends EventBus {
  // Track registrations by a unique counter key so that EventBus.once()'s
  // internal listener-removal doesn't affect our tracking (once removes the
  // fn from EventBus but we still need to call our unsub during teardown).
  private readonly registrations = new Map<number, () => void>();
  private nextKey = 0;

  /**
   * Identical to `EventBus.on` but the listener is tracked so that
   * `teardown()` will remove it automatically.
   */
  override on<E extends EventName>(event: E, fn: Listener<E>): () => void {
    const key = this.nextKey++;
    const unsub = super.on(event, fn);
    this.registrations.set(key, unsub);
    return () => {
      this.registrations.delete(key);
      unsub();
    };
  }

  /**
   * Identical to `EventBus.once` but the listener is tracked so that
   * `teardown()` will remove it automatically.
   *
   * Uses EventBus's public API directly to avoid triggering our own `on()`
   * override (which would consume a key slot for the wrapper, then orphan
   * our registration entry under a different key).
   *
   * When the wrapper fires, it cleans up BOTH the underlying EventBus
   * listener AND the tracking entry — so `scopedListenerCount` returns to
   * its pre-`once()` value without requiring the caller to invoke the
   * returned unsubscribe. The returned `unsub` is still safe to call
   * after auto-removal (its delete is a no-op and its off() finds
   * nothing to remove).
   */
  override once<E extends EventName>(event: E, fn: Listener<E>): () => void {
    const key = this.nextKey++;
    const wrapper: Listener<E> = (payload) => {
      // Bypass ScopedEventBus.on() — go straight to EventBus.off() so we
      // don't recurse and don't consume another key.
      EventBus.prototype.off.call(this, event, wrapper as Listener<EventName>);
      // Drop the tracking entry so scopedListenerCount is honest. Done
      // before calling `fn` so a handler that calls scopedListenerCount
      // mid-fire sees the post-removal state.
      this.registrations.delete(key);
      (fn as Listener<E>)(payload);
    };
    // Use the EventBus prototype directly to register without triggering
    // ScopedEventBus.on() which would consume a second key.
    EventBus.prototype.on.call(this, event, wrapper as Listener<EventName>);
    const unsub = () => {
      this.registrations.delete(key);
      EventBus.prototype.off.call(this, event, wrapper as Listener<EventName>);
    };
    this.registrations.set(key, unsub);
    return unsub;
  }

  /**
   * Subscribe to all events. Alias for `onPattern('*')` — the listener is
   * tracked so that `teardown()` will remove it automatically.
   */
  override onAny(fn: (event: string, payload: unknown) => void): () => void {
    const key = this.nextKey++;
    // Call EventBus.onPattern directly so the wrapper-consumption in
    // ScopedEventBus.on() doesn't re-enter and create a second registration slot.
    const unsub = EventBus.prototype.onPattern.call(this, '*', fn);
    this.registrations.set(key, unsub);
    return () => {
      this.registrations.delete(key);
      unsub();
    };
  }

  /**
   * Identical to `EventBus.onPattern` but the listener is tracked so that
   * `teardown()` will remove it automatically.
   */
  override onPattern(pattern: string, fn: (event: string, payload: unknown) => void): () => void {
    const key = this.nextKey++;
    const unsub = super.onPattern(pattern, fn);
    this.registrations.set(key, unsub);
    return () => {
      this.registrations.delete(key);
      unsub();
    };
  }

  /**
   * Identical to `EventBus.onRegex` but the listener is tracked so that
   * `teardown()` will remove it automatically.
   */
  override onRegex(regex: RegExp, fn: (event: string, payload: unknown) => void): () => void {
    const key = this.nextKey++;
    const unsub = super.onRegex(regex, fn);
    this.registrations.set(key, unsub);
    return () => {
      this.registrations.delete(key);
      unsub();
    };
  }

  /**
   * Remove every listener that was registered through this scoped bus.
   * Idempotent — calling it multiple times is safe.
   *
   * Also available as `[Symbol.dispose]` for explicit resource management:
   * ```ts
   * using scope = new ScopedEventBus();
   * scope.on('tool.executed', handler);
   * // automatically teardown()'d when scope exits
   * ```
   */
  teardown(): void {
    for (const unsub of this.registrations.values()) {
      try {
        unsub();
      } catch {
        /* ignore — best effort */
      }
    }
    this.registrations.clear();
    this.clear();
  }

  /** Alias for `teardown()` — enables `using new ScopedEventBus()` in Node ≥ 22. */
  [Symbol.dispose](): void {
    this.teardown();
  }

  /** Number of tracked registrations. */
  get scopedListenerCount(): number {
    return this.registrations.size;
  }
}

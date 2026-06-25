/**
 * EventBus — observe-only typed event bus.
 * Subscribers cannot modify or cancel. Subscriber exceptions are caught.
 */

import type { EventMap, EventName, Listener } from './event-map.js';

export interface EventLogger {
  error(msg: string, ctx?: unknown): void | undefined;
}

export class EventBus {
  private readonly listeners = new Map<EventName, Set<Listener<EventName>>>();
  private readonly wildcards: Array<{
    match: (event: string) => boolean;
    fn: (event: string, payload: unknown) => void;
  }> = [];
  private logger?: EventLogger | undefined;

  setLogger(logger: EventLogger): void {
    this.logger = logger;
  }

  on<E extends EventName>(event: E, fn: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<EventName>);
    return () => this.off(event, fn);
  }

  off<E extends EventName>(event: E, fn: Listener<E>): void {
    this.listeners.get(event)?.delete(fn as Listener<EventName>);
  }

  once<E extends EventName>(event: E, fn: Listener<E>): () => void {
    const wrapper: Listener<E> = (payload) => {
      this.off(event, wrapper as Listener<EventName>);
      (fn as Listener<E>)(payload);
    };
    this.on(event, wrapper as Listener<E>);
    return () => {
      this.off(event, wrapper as Listener<EventName>);
    };
  }

  /**
   * Subscribe to all events, regardless of name. Short-hand for
   * `onPattern('*')`. Use for logging, debugging, or forwarding every
   * event to another bus (as FleetBus does).
   *
   * Returns an unsubscribe function.
   */
  onAny(fn: (event: string, payload: unknown) => void): () => void {
    return this.onPattern('*', fn);
  }

  /**
   * Subscribe to all events whose name matches a glob-style prefix.
   * `'tool.*'` matches `tool.started`, `tool.executed`, `tool.progress`, etc.
   * `'*'` matches every event.
   *
   * The handler receives `(eventName, payload)` with the event name as a
   * string and the payload as `unknown`. Use for logging, debugging, or
   * metrics collection across a family of events.
   *
   * Returns an unsubscribe function.
   */
  onPattern(pattern: string, fn: (event: string, payload: unknown) => void): () => void {
    const match = makePatternMatcher(pattern);
    const entry = { match, fn };
    this.wildcards.push(entry);
    return () => {
      const idx = this.wildcards.indexOf(entry);
      if (idx >= 0) this.wildcards.splice(idx, 1);
    };
  }

  /**
   * Subscribe to all events whose name matches a RegExp.
   * More flexible than `onPattern` — use when you need regex features
   * (alternation, character classes, capture groups).
   *
   * Returns an unsubscribe function.
   */
  onRegex(regex: RegExp, fn: (event: string, payload: unknown) => void): () => void {
    const entry = { match: (e: string) => regex.test(e), fn };
    this.wildcards.push(entry);
    return () => {
      const idx = this.wildcards.indexOf(entry);
      if (idx >= 0) this.wildcards.splice(idx, 1);
    };
  }

  emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of set) {
        try {
          (fn as Listener<E>)(payload);
        } catch (err) {
          this.logger?.error(`EventBus listener for "${event}" threw`, err);
        }
      }
    }
    // Wildcard listeners — snapshot the array first so a listener that
    // subscribes another pattern (via onPattern/onRegex) doesn't see
    // inconsistent behavior across JS engines. ECMA leaves mid-iteration
    // array mutation under-specified; this keeps us engine-portable.
    if (this.wildcards.length > 0) {
      const name = event as string;
      const snapshot = this.wildcards.slice();
      for (const { match, fn } of snapshot) {
        if (!match(name)) continue;
        try {
          fn(name, payload);
        } catch (err) {
          this.logger?.error(`EventBus wildcard listener for "${name}" threw`, err);
        }
      }
    }
  }

  /**
   * Emit a plugin-defined event that is intentionally outside EventMap.
   * Custom events are delivered to wildcard/pattern listeners only; typed
   * listeners remain reserved for core EventMap keys.
   */
  emitCustom(event: string, payload: unknown): void {
    if (this.wildcards.length === 0) return;
    const snapshot = this.wildcards.slice();
    for (const { match, fn } of snapshot) {
      if (!match(event)) continue;
      try {
        fn(event, payload);
      } catch (err) {
        this.logger?.error(`EventBus wildcard listener for "${event}" threw`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
    this.wildcards.length = 0;
  }

  /**
   * V2-D: introspection helper. Pass an `event` to count handlers for a
   * single key, or omit to get the total across every event. Used by the
   * leak-detection smoke test to flag handler accumulation across runs.
   * Does NOT include wildcard listeners.
   */
  listenerCount(event?: EventName): number {
    if (event !== undefined) return this.listeners.get(event)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  /**
   * Number of wildcard listeners currently registered.
   */
  wildcardCount(): number {
    return this.wildcards.length;
  }

  /**
   * True if anything would receive an emit for `event` — a named listener
   * OR a wildcard/regex pattern that matches the event name. Unlike
   * `listenerCount`, this DOES account for wildcards, so callers that gate
   * behavior on "is anyone listening?" (e.g. SubagentBudget deciding whether
   * to negotiate a soft limit vs hard-stop) don't misfire when the only
   * subscriber is a pattern listener like the FleetBus's `onPattern('*')`.
   */
  hasListenerFor(event: string): boolean {
    if ((this.listeners.get(event as EventName)?.size ?? 0) > 0) return true;
    return this.wildcards.some((w) => w.match(event));
  }
}

/**
 * Convert a glob-style pattern to a matcher function.
 * Only supports `*` at the end of a prefix — `'tool.*'` becomes
 * "starts with tool.". `'*'` matches everything.
 */
export function makePatternMatcher(pattern: string): (event: string) => boolean {
  if (pattern === '*') return () => true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return (e: string) => e.startsWith(`${prefix}.`);
  }
  // Exact match fallback
  return (e: string) => e === pattern;
}

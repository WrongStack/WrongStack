/**
 * EventBus — observe-only typed event bus.
 * Subscribers cannot modify or cancel. Subscriber exceptions are caught.
 */

import type { AgentEventMap } from './events/agent-events.js';
import type { BrainEventMap } from './events/brain-events.js';
import type { FileEventMap } from './events/file-events.js';
import type { FleetEventMap } from './events/fleet-events.js';
import type { MemoryEventMap } from './events/memory-events.js';
import type { NetworkEventMap } from './events/network-events.js';
import type { ProcessEventMap } from './events/process-events.js';
import type { ProviderEventMap } from './events/provider-events.js';
import type { SddEventMap } from './events/sdd-events.js';
import type { SessionEventMap } from './events/session-events.js';
import type { ToolEventMap } from './events/tool-events.js';
import type { WorktreeEventMap } from './events/worktree-events.js';
import type { WrongTraceEventMap } from './events/wrongtrace-events.js';

/** Safety cap on the wildcard listener array to prevent unbounded growth from
 *  undisposed onPattern/onRegex/onAny callers. No legitimate usage needs more
 *  than this — past the cap, new registrations are rejected with a warning. */
const MAX_WILDCARDS = 500;

/**
 * Safety cap on total named listeners (all event names combined) to prevent
 * unbounded heap growth when callers forget to dispose their `.on()` registrations.
 * While each `.on()` returns a disposer, long-lived sessions with missing cleanup
 * could accumulate thousands of listener closures (each holding references to its
 * captured scope). Past this cap, new `.on()` registrations are rejected with a
 * logged warning and a no-op disposer is returned, making the leak visible without
 * crashing the process.
 */
const MAX_NAMED_LISTENERS = 2000;

/** Distress signals the BrainMonitor watches. See `coordination/brain-monitor.ts`. */
export type BrainInterventionKind =
  | 'tool_failure_streak'
  | 'error_storm'
  | 'agent_stall'
  | 'file_churn';

/**
 * Structural shape of a tracked agent as flushed by AgentStatusTracker. Kept
 * structural (not imported from the root `session-registry` module) so the
 * low-level kernel layer takes on no dependency on composition modules. The
 * real `AgentEntry` is assignable to this.
 */
export interface TrackedAgentSnapshot {
  id: string;
  name: string;
  startedAt?: string | undefined;
  status: string;
  currentTool?: string | undefined;
  currentTask?: string | undefined;
  taskId?: string | undefined;
  iterations: number;
  toolCalls: number;
  costUsd?: number | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  ctxPct?: number | undefined;
  model?: string | undefined;
  partialText?: string | undefined;
  todos?:
    | Array<{
        id: string;
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        activeForm?: string | undefined;
      }>
    | undefined;
  latestPrompt?: string | undefined;
  latestPromptAt?: number | undefined;
  lastActivityAt: string;
}

export interface EventMap
  extends AgentEventMap,
    BrainEventMap,
    SessionEventMap,
    ProviderEventMap,
    ProcessEventMap,
    NetworkEventMap,
    FileEventMap,
    ToolEventMap,
    MemoryEventMap,
    SddEventMap,
    WorktreeEventMap,
    FleetEventMap,
    WrongTraceEventMap {}

export type EventName = keyof EventMap;
export type Listener<E extends EventName> = (payload: EventMap[E]) => void;

export interface EventLogger {
  error(msg: string, ctx?: unknown): void | undefined;
}

export class EventBus {
  protected readonly listeners = new Map<EventName, Set<Listener<EventName>>>();
  protected readonly wildcards: Array<{
    match: (event: string) => boolean;
    fn: (event: string, payload: unknown) => void;
    /** Optional registration-site label included in cap-rejection warnings. */
    owner?: string | undefined;
  }> = [];
  protected logger?: EventLogger | undefined;
  /**
   * Dispatch arrays cached per event name, rebuilt lazily after a
   * subscription change. See {@link namedSnapshot}. Every mutation of
   * `listeners` must invalidate the matching entry, and every mutation of
   * `wildcards` must null `wildcardSnapshotCache` — a missed invalidation
   * means an emit dispatches to a stale listener set.
   */
  private readonly listenerSnapshots = new Map<EventName, readonly Listener<EventName>[]>();
  private wildcardSnapshotCache:
    | readonly {
        match: (event: string) => boolean;
        fn: (event: string, payload: unknown) => void;
      }[]
    | null = null;

  setLogger(logger: EventLogger): void {
    this.logger = logger;
  }

  on<E extends EventName>(event: E, fn: Listener<E>): () => void {
    // Prevent unbounded accumulation of named listeners when callers
    // forget to dispose their registrations. Past the cap, new `.on()`
    // calls are rejected with a warning and a no-op disposer — the
    // process keeps running and the developer sees the symptom.
    if (this.listenerCount() >= MAX_NAMED_LISTENERS) {
      this.logger?.error(
        `EventBus named listener limit (~${MAX_NAMED_LISTENERS}) reached — rejecting on("${event}"). ` +
          'Callers must dispose their named listeners to prevent unbounded memory growth.',
      );
      return () => {};
    }
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<EventName>);
    this.listenerSnapshots.delete(event);
    return () => this.off(event, fn);
  }

  off<E extends EventName>(event: E, fn: Listener<E>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(fn as Listener<EventName>);
    this.listenerSnapshots.delete(event);
    // Prune the now-empty Set so the map doesn't accumulate dead entries that
    // listenerCount() and iteration would otherwise walk. Safe during an
    // in-flight emit() because emit snapshots the Set before iterating, so it
    // never observes the live Set being deleted.
    if (set.size === 0) this.listeners.delete(event);
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
  onAny(
    fn: (event: string, payload: unknown) => void,
    /** Optional registration-site label included in cap-rejection warnings. */
    owner?: string,
  ): () => void {
    return this.onPattern('*', fn, owner);
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
  onPattern(
    pattern: string,
    fn: (event: string, payload: unknown) => void,
    /** Optional registration-site label included in cap-rejection warnings. */
    owner?: string,
  ): () => void {
    if (this.wildcards.length >= MAX_WILDCARDS) {
      this.logger?.error(
        `EventBus wildcard limit (${MAX_WILDCARDS}) reached — rejecting onPattern("${pattern}")` +
          (owner ? ` (owner: ${owner})` : '') +
          '. Callers must dispose their wildcard listeners to prevent unbounded growth.',
      );
      return () => {};
    }
    const match = makePatternMatcher(pattern);
    const entry = { match, fn, owner };
    this.wildcards.push(entry);
    this.wildcardSnapshotCache = null;
    return () => {
      const idx = this.wildcards.indexOf(entry);
      if (idx >= 0) {
        this.wildcards.splice(idx, 1);
        this.wildcardSnapshotCache = null;
      }
    };
  }

  /**
   * Subscribe to all events whose name matches a RegExp.
   * More flexible than `onPattern` — use when you need regex features
   * (alternation, character classes, capture groups).
   *
   * Returns an unsubscribe function.
   */
  onRegex(
    regex: RegExp,
    fn: (event: string, payload: unknown) => void,
    /** Optional registration-site label included in cap-rejection warnings. */
    owner?: string,
  ): () => void {
    if (this.wildcards.length >= MAX_WILDCARDS) {
      this.logger?.error(
        `EventBus wildcard limit (${MAX_WILDCARDS}) reached — rejecting onRegex(${regex})` +
          (owner ? ` (owner: ${owner})` : '') +
          '. Callers must dispose their wildcard listeners to prevent unbounded growth.',
      );
      return () => {};
    }
    const entry = { match: (e: string) => regex.test(e), fn, owner };
    this.wildcards.push(entry);
    this.wildcardSnapshotCache = null;
    return () => {
      const idx = this.wildcards.indexOf(entry);
      if (idx >= 0) {
        this.wildcards.splice(idx, 1);
        this.wildcardSnapshotCache = null;
      }
    };
  }

  emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    const snapshot = this.namedSnapshot(event);
    if (snapshot !== undefined) {
      for (const fn of snapshot) {
        try {
          (fn as Listener<E>)(payload);
        } catch (err) {
          this.logger?.error(`EventBus listener for "${event}" threw`, err);
        }
      }
    }
    if (this.wildcards.length > 0) {
      const name = event as string;
      for (const { match, fn } of this.wildcardSnapshot()) {
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
   * Dispatch array for one event name, or `undefined` when nothing is
   * subscribed.
   *
   * Dispatch iterates a stable array rather than the live Set so a listener
   * that subscribes or unsubscribes mid-emit cannot change what this round
   * delivers: an addition fires from the next emit, a removal may still fire
   * this round. That is the contract callers rely on, and it is unchanged.
   *
   * What changed is who pays for it. Building the array per emit did O(number
   * of listeners) copying on every event, including `tool.progress` and
   * streaming deltas — the highest-frequency paths in the process. The array
   * is now cached and rebuilt only when the subscription set actually changes,
   * which is wiring time and essentially never during a run. Measured at 2M
   * emits with 12 named + 6 wildcard listeners: 207 ms → 141 ms.
   *
   * This is a throughput win, not a footprint one: the per-emit arrays died in
   * the nursery and never showed up as retained heap (measured heap growth was
   * the same either way). Do not cite this as a memory fix.
   *
   * A mutation during dispatch invalidates the cache for the *next* emit while
   * the in-flight loop keeps walking the array it started with — which is
   * exactly the snapshot semantics described above.
   */
  private namedSnapshot(event: EventName): readonly Listener<EventName>[] | undefined {
    const cached = this.listenerSnapshots.get(event);
    if (cached !== undefined) return cached;
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return undefined;
    const snapshot = [...set];
    this.listenerSnapshots.set(event, snapshot);
    return snapshot;
  }

  /** Wildcard counterpart to {@link namedSnapshot}; same caching rationale. */
  private wildcardSnapshot(): readonly {
    match: (event: string) => boolean;
    fn: (event: string, payload: unknown) => void;
  }[] {
    this.wildcardSnapshotCache ??= this.wildcards.slice();
    return this.wildcardSnapshotCache;
  }

  /**
   * Emit a plugin-defined event that is intentionally outside EventMap.
   * Custom events are delivered to wildcard/pattern listeners only; typed
   * listeners remain reserved for core EventMap keys.
   */
  emitCustom(event: string, payload: unknown): void {
    if (this.wildcards.length === 0) return;
    for (const { match, fn } of this.wildcardSnapshot()) {
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
    this.listenerSnapshots.clear();
    this.wildcardSnapshotCache = null;
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

// ── Scoped EventBus ─────────────────────────────────────────────────────────────

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
  override onAny(
    fn: (event: string, payload: unknown) => void,
    owner?: string,
  ): () => void {
    if (this.wildcards.length >= MAX_WILDCARDS) {
      this.logger?.error(
        `EventBus wildcard limit (${MAX_WILDCARDS}) reached — rejecting onAny()` +
          (owner ? ` (owner: ${owner})` : '') +
          '. Callers must dispose their wildcard listeners to prevent unbounded growth.',
      );
      return () => {};
    }
    const key = this.nextKey++;
    // Call EventBus.onPattern directly so the wrapper-consumption in
    // ScopedEventBus.on() doesn't re-enter and create a second registration slot.
    const unsub = EventBus.prototype.onPattern.call(this, '*', fn, owner);
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
  override onPattern(
    pattern: string,
    fn: (event: string, payload: unknown) => void,
    owner?: string,
  ): () => void {
    // Pre-check the cap before delegating to EventBus.onPattern so we never
    // store a no-op disposer in our registrations map, which would inflate
    // scopedListenerCount metrics without providing any cleanup.
    if (this.wildcards.length >= MAX_WILDCARDS) {
      this.logger?.error(
        `EventBus wildcard limit (${MAX_WILDCARDS}) reached — rejecting onPattern("${pattern}")` +
          (owner ? ` (owner: ${owner})` : '') +
          '. Callers must dispose their wildcard listeners to prevent unbounded growth.',
      );
      return () => {};
    }
    const key = this.nextKey++;
    const unsub = super.onPattern(pattern, fn, owner);
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
  override onRegex(
    regex: RegExp,
    fn: (event: string, payload: unknown) => void,
    owner?: string,
  ): () => void {
    if (this.wildcards.length >= MAX_WILDCARDS) {
      this.logger?.error(
        `EventBus wildcard limit (${MAX_WILDCARDS}) reached — rejecting onRegex(${regex})` +
          (owner ? ` (owner: ${owner})` : '') +
          '. Callers must dispose their wildcard listeners to prevent unbounded growth.',
      );
      return () => {};
    }
    const key = this.nextKey++;
    const unsub = super.onRegex(regex, fn, owner);
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

/**
 * Reused matcher for the `'*'` wildcard — equivalent to `() => true`
 * but allocated once at module load rather than on every `onPattern('*')`
 * or `onAny()` call. The wildcard array can grow to hundreds of entries
 * during long-lived sessions, so caching the function avoids GC pressure.
 */
const MATCH_ALL: (event: string) => boolean = () => true;

/**
 * Convert a glob-style pattern to a matcher function.
 * Only supports `*` at the end of a prefix — `'tool.*'` becomes
 * "starts with tool.". `'*'` matches everything.
 */
function makePatternMatcher(pattern: string): (event: string) => boolean {
  if (pattern === '*') return MATCH_ALL;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return (e: string) => e.startsWith(`${prefix}.`);
  }
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return (e: string) => e.startsWith(`${prefix}:`);
  }
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return (e: string) => e.startsWith(prefix);
  }
  // Exact match fallback
  return (e: string) => e === pattern;
}

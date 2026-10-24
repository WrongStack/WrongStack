/**
 * Shared context for HQ telemetry bridges.
 *
 * Every bridge (`cost-bridge`, `brain-bridge`, `worktree-bridge`,
 * `fleet-bridge`, `tool-bridge`) repeats the same four pieces of
 * boilerplate:
 *
 *  1. Resolve `now` from options or fall back to `new Date().toISOString()`.
 *  2. Conditionally spread `{ sessionId }` into every `publishEvent` call.
 *  3. Wrap every publish in `try / catch` (best-effort) so a transient
 *     publisher failure never breaks the host's event loop.
 *  4. Collect unsubscribe handles and return a single disposer.
 *
 * This module collapses those four into one factory so each bridge shrinks
 * to its event-mapping logic.
 *
 * @module hq/bridge-context
 */

import type { HqPublishEventOptions, HqPublisher } from './publisher.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface BridgeContextOptions {
  /** HQ publisher to forward envelopes to. */
  publisher: HqPublisher;
  /** Override `now()` for deterministic tests. */
  now?: (() => string) | undefined;
  /** Optional sessionId to tag envelopes with when the event has none. */
  sessionId?: string | undefined;
}

export interface BridgeContext {
  /** Resolved timestamp function (never undefined). */
  readonly now: () => string;
  /**
   * Build the `{ sessionId } | {}` spread for a `publishEvent` call.
   * The event-level sessionId (from the event payload) takes precedence
   * over the bridge-level sessionId (from options).
   */
  readonly sessionIdTag: (eventSessionId?: string) => { sessionId?: string };
  /**
   * Wrap a publish in try/catch so a transient publisher failure never
   * breaks the host. Returns the envelope on success, `undefined` on
   * failure.
   */
  readonly safePublish: (options: HqPublishEventOptions) => void;
  /** Track an unsubscribe handle for the disposer. */
  readonly track: (off: () => void) => void;
  /** Call every tracked unsubscribe handle. */
  readonly dispose: () => void;
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a {@link BridgeContext} from the common bridge options.
 *
 * Usage in a bridge:
 *
 * ```ts
 * export function startSomethingBridge(opts: SomethingBridgeOptions): () => void {
 *   const { events, publisher } = opts;
 *   const ctx = createBridgeContext(opts);
 *
 *   ctx.track(events.on('something.happened', (p) => {
 *     ctx.safePublish({
 *       type: 'something.event',
 *       payload: { ... },
 *       ...ctx.sessionIdTag(p.sessionId),
 *       timestamp: ctx.now(),
 *     });
 *   }));
 *
 *   return ctx.dispose;
 * }
 * ```
 */
export function createBridgeContext(options: BridgeContextOptions): BridgeContext {
  const publisher = options.publisher;
  const now = options.now ?? (() => new Date().toISOString());
  const bridgeSessionId = options.sessionId;
  const offs: Array<() => void> = [];

  function sessionIdTag(eventSessionId?: string): { sessionId?: string } {
    const tag = eventSessionId ?? bridgeSessionId;
    return tag !== undefined && tag.length > 0 ? { sessionId: tag } : {};
  }

  function safePublish(publishOptions: HqPublishEventOptions): void {
    try {
      publisher.publishEvent(publishOptions);
    } catch {
      /* best-effort — HQ telemetry must never break the host */
    }
  }

  function track(off: () => void): void {
    offs.push(off);
  }

  function dispose(): void {
    for (const off of offs) {
      try {
        off();
      } catch {
        /* best-effort */
      }
    }
    offs.length = 0;
  }

  return { now, sessionIdTag, safePublish, track, dispose };
}

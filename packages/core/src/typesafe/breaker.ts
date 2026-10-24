/**
 * Stop asking a host that has told us the credential is no good.
 *
 * The client deliberately does not retry a 401/403 — those fail identically on
 * every attempt. But "do not retry" is per-request, and the features here run
 * per turn: a key that was revoked yesterday buys a rejected request, and its
 * latency, on every turn from now on, and nothing says so out loud. The
 * failure is invisible precisely because every consumer is built to degrade
 * silently.
 *
 * This wraps a client and counts CONSECUTIVE authentication rejections. After
 * `threshold` of them it opens for the lifetime of this client and every later
 * call fails immediately without touching the network, having told the host
 * once why.
 *
 * What it deliberately does NOT trip on:
 *
 *   429 / 529   transient by the service's own documentation — the backoff in
 *               the client is the right answer, and disabling a feature over
 *               load would turn a busy minute into a lost session.
 *   network 0   a laptop that closed its lid is not a revoked key.
 *   422         a bad question is our bug, not a credential problem; it
 *               deserves to keep failing loudly rather than silently disable
 *               an unrelated feature.
 *
 * One success resets the count before it opens. After opening, recreate the
 * client after fixing the credential; other clients keep their own counters.
 */

import { FetchError } from '@wrongstack/contracts/types/errors';
import type { SystemOneRequest, SystemOneResult, TypeSafeClient } from './client.js';

/** Statuses that mean "this credential will not work, ever". */
const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);

export interface TypeSafeBreakerOptions {
  /** The client to guard. */
  client: TypeSafeClient;
  /**
   * Consecutive auth rejections that open the breaker. Default 3.
   *
   * Not 1: a single 401 can come from a proxy mid-rotation or a race with a
   * credential reload, and disabling a feature the operator switched on
   * deserves more evidence than one packet.
   */
  threshold?: number | undefined;
  /**
   * Called ONCE, when the breaker opens. This is the only user-visible signal
   * that the feature stopped; hosts render it as a single line.
   */
  onOpen?: ((reason: string) => void) | undefined;
  /** Label used in the message, e.g. `TypeSafe` or `OpenRouter (Decisions)`. */
  label?: string | undefined;
}

export interface TypeSafeBreaker extends TypeSafeClient {
  readonly paymentRequired?: boolean;
  /** True once the breaker has opened. Surfaces read it for status output. */
  readonly open: boolean;
}

/** Error thrown by an open breaker. Distinguishable from a live transport failure. */
export class TypeSafeDisabledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TypeSafeDisabledError';
  }
}

export function createTypeSafeBreaker(opts: TypeSafeBreakerOptions): TypeSafeBreaker {
  const threshold = Math.max(1, opts.threshold ?? 3);
  const label = opts.label ?? 'TypeSafe';
  let consecutive = 0;
  let open = false;
  let reason = '';
  let paymentRequired = false;

  return {
    get paymentRequired() {
      return paymentRequired;
    },
    get open() {
      return open;
    },
    async systemOne(req: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResult> {
      if (open) throw new TypeSafeDisabledError(reason);
      try {
        const result = await opts.client.systemOne(req, signal);
        consecutive = 0;
        return result;
      } catch (err) {
        const status = err instanceof FetchError ? err.status : 0;
        if (status !== 402 && !AUTH_STATUSES.has(status)) {
          // Anything else leaves the count where it was. A rate limit between
          // two 401s must not reset the evidence, and must not add to it.
          throw err;
        }
        consecutive++;
        if (!open && (status === 402 || consecutive >= threshold)) {
          paymentRequired = status === 402;
          open = true;
          reason =
            status === 402
              ? `${label} payment required (HTTP 402); requests stopped for this client. Disable Jev with /jev off, or fix billing and restart the session.`
              : `${label} rejected the credential ${consecutive} times (HTTP ${status}); ` +
                'disabled for this client. Check it with `wstack typesafe test` and restart the session.';
          try {
            opts.onOpen?.(reason);
          } catch {
            // Reporting a failure must not become a second failure.
          }
        }
        throw err;
      }
    },
  };
}

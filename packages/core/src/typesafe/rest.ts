/**
 * Let a busy or unreachable TypeSafe host rest.
 *
 * The auth breaker (`breaker.ts`) answers "will this credential ever work?"
 * and deliberately ignores load: a 429 is not a revoked key. That leaves the
 * other half unanswered. A host that is rate-limiting us, returning 5xx, or
 * not answering at all still gets asked on every turn by every feature — each
 * ask paying the client's retry-with-backoff and its timeout before the caller
 * takes its fallback path. With several judgment features wired to the same
 * account, one bad minute at the provider turns into seconds of added latency
 * on every turn, spent confirming what the previous turn already learned.
 *
 * This gate records transient failures and, once they say the host is not
 * answering, makes every caller skip the network for a cooldown. Callers see
 * {@link TypeSafeRestingError} immediately and take the path they would have
 * taken after a timeout — without the timeout. After the cooldown the next
 * call is let through as a probe: success closes the gate, another failure
 * reopens it for twice as long, capped.
 *
 * ## Shared, not per client
 *
 * Rate limits are per account, and a host that is down is down for everyone.
 * The gate is therefore shared by every client that talks to the same
 * endpoint with the same credential ({@link sharedTypeSafeRestGate}), so the
 * skill suggester learning the host is saturated spares the Brain the same
 * lesson. Tests inject their own gate.
 *
 * ## What counts
 *
 *   status 0     network error / timeout — counts
 *   408, 5xx     counts
 *   429, 529     counts double: the service said "slow down" in so many words
 *   401/403/422  never — those are the credential or our question, and the
 *                auth breaker / the caller own them
 *   abort        never — the caller cancelled, the host did nothing wrong
 */

import { createHash } from 'node:crypto';
import { FetchError } from '@wrongstack/contracts/types/errors';
import type { SystemOneRequest, SystemOneResult, TypeSafeClient } from './client.js';

/** Thrown while the gate is resting. Distinguishable from a live transport failure. */
export class TypeSafeRestingError extends Error {
  constructor(
    readonly until: number,
    reason: string,
  ) {
    super(reason);
    this.name = 'TypeSafeRestingError';
  }
}

export interface TypeSafeRestGateOptions {
  /** Failure weight that opens the gate. Default 2 (one 429, or two timeouts). */
  failureLimit?: number | undefined;
  /** First cooldown. Default 30s. */
  baseCooldownMs?: number | undefined;
  /** Cooldown ceiling after repeated re-opens. Default 10 minutes. */
  maxCooldownMs?: number | undefined;
  /** Clock seam for tests. */
  now?: (() => number) | undefined;
}

export interface TypeSafeRestGate {
  readonly paymentRequired?: boolean | undefined;
  /** True while callers should not touch the network. */
  isResting(): boolean;
  /** Epoch ms the current rest ends, or `undefined` when not resting. */
  restingUntil(): number | undefined;
  /** Human-readable reason for the current or last rest. */
  reason(): string | undefined;
  recordSuccess(): void;
  /** Record a failure; returns true when this failure put the gate to rest. */
  recordFailure(err: unknown): boolean;
}

/** Weight a failure contributes toward resting, 0 for "not the host's fault". */
export function typeSafeFailureWeight(err: unknown): number {
  if (err instanceof TypeSafeRestingError) return 0;
  // The client wraps every fetch rejection — the caller's own abort included —
  // in FetchError(status 0); judge by the wrapped cause, as activity.ts does.
  const cause = err instanceof FetchError && err.cause instanceof Error ? err.cause : undefined;
  if (cause && (cause.name === 'AbortError' || cause.name === 'TimeoutError')) {
    return cause.name === 'TimeoutError' ? 1 : 0;
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    // `AbortSignal.timeout` surfaces as TimeoutError when a caller's own
    // deadline fires before the client wrapped it; a plain AbortError is the
    // caller cancelling. Only the deadline says anything about the host.
    return err.name === 'TimeoutError' ? 1 : 0;
  }
  if (!(err instanceof FetchError)) return 0;
  const status = err.status;
  if (status === 429 || status === 529) return 2;
  if (status === 0 || status === 408 || (status >= 500 && status <= 599)) return 1;
  return 0;
}

export function createTypeSafeRestGate(opts: TypeSafeRestGateOptions = {}): TypeSafeRestGate {
  const failureLimit = Math.max(1, opts.failureLimit ?? 2);
  const baseCooldownMs = Math.max(1, opts.baseCooldownMs ?? 30_000);
  const maxCooldownMs = Math.max(baseCooldownMs, opts.maxCooldownMs ?? 600_000);
  const now = opts.now ?? Date.now;

  let weight = 0;
  let until = 0;
  let nextCooldown = baseCooldownMs;
  let lastReason: string | undefined;
  let paymentRequired = false;
  // Set by a rest, cleared by a success: the first calls after the cooldown are
  // probes, and ANY host failure then reopens the gate (the weight reset at
  // rest would otherwise let a timed-out probe leave it closed).
  let probing = false;

  return {
    get paymentRequired() {
      return paymentRequired;
    },
    isResting: () => paymentRequired || now() < until,
    restingUntil: () =>
      paymentRequired ? Number.POSITIVE_INFINITY : now() < until ? until : undefined,
    reason: () => lastReason,
    recordSuccess() {
      // An in-flight success must not clear a concurrent payment rejection.
      if (paymentRequired) return;
      weight = 0;
      nextCooldown = baseCooldownMs;
      probing = false;
    },
    recordFailure(err) {
      if (paymentRequired) return false;
      if (err instanceof FetchError && err.status === 402) {
        paymentRequired = true;
        lastReason =
          'Jev payment required (HTTP 402); automatic requests stopped for this account until the process restarts or the account changes. Disable Jev with /jev off.';
        return true;
      }
      const w = typeSafeFailureWeight(err);
      if (w === 0) return false;
      // Still resting: a call that was already in flight — same outage signal.
      if (now() < until) return false;
      weight += w;
      if (weight < failureLimit && !probing) return false;
      probing = true;
      until = now() + nextCooldown;
      const status = err instanceof FetchError ? err.status : 0;
      lastReason =
        `TypeSafe is not answering (${status ? `HTTP ${status}` : 'network/timeout'}); ` +
        `resting ${Math.round(nextCooldown / 1000)}s — features use their fallback meanwhile.`;
      nextCooldown = Math.min(maxCooldownMs, nextCooldown * 2);
      weight = 0;
      return true;
    },
  };
}

/** Wrap a client so it skips the network while `gate` rests. */
export function withTypeSafeRest(
  client: TypeSafeClient,
  gate: TypeSafeRestGate,
  onRest?: ((reason: string) => void) | undefined,
): TypeSafeClient {
  return {
    async systemOne(req: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResult> {
      const until = gate.restingUntil();
      if (until !== undefined) {
        throw new TypeSafeRestingError(until, gate.reason() ?? 'TypeSafe is resting');
      }
      try {
        const result = await client.systemOne(req, signal);
        gate.recordSuccess();
        return result;
      } catch (err) {
        if (gate.recordFailure(err)) {
          try {
            onRest?.(gate.reason() ?? 'TypeSafe is resting');
          } catch {
            // Reporting a rest must not become a second failure.
          }
        }
        throw err;
      }
    },
  };
}

const sharedGates = new Map<string, TypeSafeRestGate>();

/**
 * The process-wide gate for one endpoint + credential.
 *
 * Keyed on a hash of the key, never the key itself, so the map cannot become
 * a place a credential is readable from.
 */
export function sharedTypeSafeRestGate(endpoint: string, apiKey: string): TypeSafeRestGate {
  const id = `${endpoint}\0${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
  let gate = sharedGates.get(id);
  if (!gate) {
    gate = createTypeSafeRestGate();
    sharedGates.set(id, gate);
  }
  return gate;
}

/** Test seam. Never call from product code. */
export function resetSharedTypeSafeRestGatesForTests(): void {
  sharedGates.clear();
}

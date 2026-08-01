/**
 * Failed-attempt throttle for mailbox credential verification.
 *
 * WS-025: `credential_verify` takes a `credentialId` and a `secret` and answers
 * whether they match, with no limit on how often it will answer. That is a
 * guessing oracle: any caller that reaches the mailbox — the MCP admin tool,
 * the project IPC daemon, an in-process caller — can grind secrets for a
 * credential id it observed, as fast as the socket allows.
 *
 * The secret is 32 random bytes, so exhaustive search is not the threat.
 * A weak or reused secret, a partially-leaked one, or a future change to how
 * secrets are minted is — and an unbounded oracle also silently turns every
 * such mistake into a remotely exploitable one, and burns CPU while doing it.
 *
 * The limiter lives at the store layer rather than in one adapter so every
 * surface inherits it; a throttle wired into a single caller is a throttle
 * with a documented bypass.
 *
 * In-memory and per-process, which matches the deployment: one mailbox daemon
 * owns a project. A restart clears the counters — acceptable, because
 * restarting the daemon is not something a remote caller can do at will, and
 * persisting failure counts would put an attacker-controlled write on the
 * unauthenticated path.
 *
 * @module coordination/mailbox-credential-throttle
 */

/** Failed attempts allowed per credential id before the cooldown starts. */
export const CREDENTIAL_VERIFY_MAX_FAILURES = 10;

/** Window over which failures accumulate. */
export const CREDENTIAL_VERIFY_WINDOW_MS = 60_000;

/** How long a credential id stays refused once the limit is hit. */
export const CREDENTIAL_VERIFY_COOLDOWN_MS = 60_000;

/**
 * Cap on tracked credential ids. Ids come from the caller, so an attacker who
 * cycles through fabricated ones would otherwise grow this map without bound.
 * Past the cap the oldest entry is evicted — an attacker can churn their own
 * entries out, but only by not making progress on any single one.
 */
const MAX_TRACKED_IDS = 4096;

interface AttemptRecord {
  failures: number;
  /** Epoch ms of the first failure in the current window. */
  windowStartedAt: number;
  /** Epoch ms until which this id is refused outright. */
  blockedUntil: number;
}

export interface ThrottleDecision {
  allowed: boolean;
  /** Milliseconds until the next attempt is permitted; 0 when allowed. */
  retryAfterMs: number;
}

export class CredentialVerifyThrottle {
  private readonly records = new Map<string, AttemptRecord>();

  constructor(
    private readonly maxFailures = CREDENTIAL_VERIFY_MAX_FAILURES,
    private readonly windowMs = CREDENTIAL_VERIFY_WINDOW_MS,
    private readonly cooldownMs = CREDENTIAL_VERIFY_COOLDOWN_MS,
  ) {}

  /** Is this credential id allowed another attempt right now? */
  check(credentialId: string, now = Date.now()): ThrottleDecision {
    const record = this.records.get(credentialId);
    if (record === undefined) return { allowed: true, retryAfterMs: 0 };
    if (record.blockedUntil > now) {
      return { allowed: false, retryAfterMs: record.blockedUntil - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Record a failed verification. Starts the cooldown once the limit is hit. */
  recordFailure(credentialId: string, now = Date.now()): void {
    const record = this.records.get(credentialId);
    if (record === undefined || now - record.windowStartedAt > this.windowMs) {
      this.evictIfFull();
      this.records.set(credentialId, { failures: 1, windowStartedAt: now, blockedUntil: 0 });
      return;
    }
    record.failures += 1;
    if (record.failures >= this.maxFailures) {
      record.blockedUntil = now + this.cooldownMs;
      // Restart the window so the cooldown is not immediately re-armed by the
      // stale failure count once it expires.
      record.failures = 0;
      record.windowStartedAt = now;
    }
  }

  /**
   * Clear the counter after a successful verification. A legitimate holder who
   * fluffed a few attempts is not left in a cooldown they cannot exit.
   */
  recordSuccess(credentialId: string): void {
    this.records.delete(credentialId);
  }

  /** Test seam. */
  reset(): void {
    this.records.clear();
  }

  private evictIfFull(): void {
    if (this.records.size < MAX_TRACKED_IDS) return;
    const oldest = this.records.keys().next();
    if (!oldest.done) this.records.delete(oldest.value);
  }
}

/**
 * Process-wide limiter. One mailbox owns a project inside one process, so a
 * shared instance is the correct scope — and it means a caller cannot dodge
 * the throttle by reaching the same mailbox through a different surface.
 */
export const credentialVerifyThrottle = new CredentialVerifyThrottle();

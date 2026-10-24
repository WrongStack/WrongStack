/**
 * One-time bootstrap code store for HQ browser authentication.
 *
 * Replaces the practice of placing a reusable browser token in the startup
 * URL. Instead, a short-lived, single-use code is minted at startup and
 * carried in the URL fragment (`#bootstrap=…`). The browser SPA extracts
 * it from the fragment (fragments never reach HTTP access logs or Referer
 * headers), POSTs it to `/api/auth/bootstrap`, and receives only an
 * HttpOnly session cookie. The code itself is atomically consumed on
 * first exchange and can never be replayed.
 *
 * Each code carries the ID and capabilities of the originating browser
 * token so the cookie session preserves the token's privilege scope.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Maximum number of un-exchanged codes retained at once (FIFO eviction). */
const MAX_PENDING_CODES = 32;

/** How long a code remains exchangeable after minting. */
const BOOTSTRAP_CODE_TTL_MS = 120_000; // 2 minutes

export interface HqBootstrapEntry {
  /** The opaque code string carried in the URL fragment. */
  readonly code: string;
  /** Epoch-ms deadline after which the code is refused. */
  readonly expiresAt: number;
  /** ID of the browser token this code was derived from. */
  readonly tokenId: string;
  /** Capability scope inherited from the source token (absent = unrestricted). */
  readonly capabilities?: string[] | undefined;
}

/**
 * Bounded, in-memory, single-use bootstrap code store.
 *
 * `issue()` mints a 256-bit code and stores its entry. `consume()` does a
 * constant-time comparison and atomically deletes the entry on match, so a
 * second exchange with the same code always fails. Expired entries are
 * swept on every `issue`/`consume` call, and the store is capped at
 * {@link MAX_PENDING_CODES} entries (oldest evicted first).
 */
export class HqBootstrapCodeStore {
  private readonly entries = new Map<string, HqBootstrapEntry>();

  /** Mint a new one-time bootstrap code for the given token. */
  issue(source: { tokenId: string; capabilities?: string[] }): string {
    this.sweepExpired();
    // Evict oldest if at capacity (Map iteration is insertion-ordered).
    while (this.entries.size >= MAX_PENDING_CODES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const code = randomBytes(32).toString('base64url');
    this.entries.set(code, {
      code,
      expiresAt: Date.now() + BOOTSTRAP_CODE_TTL_MS,
      tokenId: source.tokenId,
      ...(source.capabilities !== undefined ? { capabilities: source.capabilities } : {}),
    });
    return code;
  }

  /**
   * Atomically consume a code. Returns the entry on match (and deletes it
   * so it can never be reused), or `undefined` if the code is unknown,
   * already consumed, or expired.
   */
  consume(supplied: string): HqBootstrapEntry | undefined {
    this.sweepExpired();
    // Constant-time lookup: iterate rather than Map.has to avoid timing
    // leakage of code length/prefix via hash-table probe timing.
    for (const [key, entry] of this.entries) {
      const a = Buffer.from(key);
      const b = Buffer.from(supplied);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        this.entries.delete(key);
        return Date.now() < entry.expiresAt ? entry : undefined;
      }
    }
    return undefined;
  }

  /** Remove all codes (called on server shutdown). */
  clear(): void {
    this.entries.clear();
  }

  /** Current number of pending (not-yet-consumed) codes. */
  get size(): number {
    return this.entries.size;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
  }
}

/**
 * Short-lived, in-memory state the vault's device routes need: outstanding
 * one-time enrollment codes, and the nonces of fetch requests already served.
 *
 * Both stay in memory on purpose. A code is typed on another machine within
 * minutes, and an HQ restart voiding the outstanding ones is the conservative
 * failure. A nonce only matters inside the timestamp window a fetch request
 * must fall in, which a restart outlives anyway.
 */
import { randomBytes } from 'node:crypto';
import { hqVaultRandom } from './crypto.js';

/** Enrollment codes live this long. */
export const HQ_VAULT_ENROLLMENT_TTL_MS = 10 * 60_000;
/** How far a fetch request's timestamp may sit from HQ's clock. */
export const HQ_VAULT_FETCH_SKEW_MS = 5 * 60_000;
const MAX_LIVE_ENROLLMENT_CODES = 32;
const MAX_SEEN_NONCES = 4096;

export interface HqVaultEnrollmentCode {
  codeId: string;
  code: string;
  expiresAt: number;
  autoApprove: boolean;
  label?: string;
}

export class HqVaultEnrollmentCodes {
  private readonly codes = new Map<string, HqVaultEnrollmentCode>();

  constructor(private readonly now: () => number) {}

  /** A fresh code, or `undefined` when too many are outstanding. */
  mint(input: { autoApprove: boolean; label?: string }): HqVaultEnrollmentCode | undefined {
    this.sweep();
    if (this.codes.size >= MAX_LIVE_ENROLLMENT_CODES) return undefined;
    const entry: HqVaultEnrollmentCode = {
      codeId: randomBytes(6).toString('hex'),
      code: hqVaultRandom(32),
      expiresAt: this.now() + HQ_VAULT_ENROLLMENT_TTL_MS,
      autoApprove: input.autoApprove,
      ...(input.label ? { label: input.label } : {}),
    };
    this.codes.set(entry.codeId, entry);
    return entry;
  }

  /** Look a live code up without consuming it. */
  peek(codeId: unknown): HqVaultEnrollmentCode | undefined {
    this.sweep();
    return typeof codeId === 'string' ? this.codes.get(codeId) : undefined;
  }

  consume(codeId: string): void {
    this.codes.delete(codeId);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(id);
  }
}

export class HqVaultNonceCache {
  private readonly seen = new Map<string, number>();

  /** Record `key` seen at `ts`; false when it was already seen inside the window. */
  remember(key: string, ts: number, now: number): boolean {
    for (const [k, at] of this.seen) {
      if (Math.abs(now - at) > HQ_VAULT_FETCH_SKEW_MS) this.seen.delete(k);
    }
    if (this.seen.has(key)) return false;
    // Bounded even under a flood of distinct, validly signed nonces.
    while (this.seen.size >= MAX_SEEN_NONCES) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    this.seen.set(key, ts);
    return true;
  }
}

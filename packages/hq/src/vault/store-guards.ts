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
import { type HqVaultKeyPair, hqVaultRandom, hqVaultVerify } from './crypto.js';
import type { HqVaultDeviceRecord, HqVaultFetchMode, HqVaultFetchRequest } from './protocol.js';
import { signHqVaultRevocation } from './store-bundle.js';
import { HqVaultError } from './store-model.js';

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

/** Shape checks on a device's fetch request (its signature is checked after). */
export function checkHqVaultFetchRequest(request: HqVaultFetchRequest): {
  mode: HqVaultFetchMode;
  features: string[];
} {
  if (request === null || typeof request !== 'object' || request.v !== 2) {
    throw new HqVaultError('VAULT_INVALID', 'Unsupported fetch request; update this machine.');
  }
  const mode: HqVaultFetchMode | undefined =
    request.mode === 'list' ? 'list' : request.mode === 'fetch' ? 'fetch' : undefined;
  if (mode === undefined)
    throw new HqVaultError('VAULT_INVALID', "mode must be 'list' or 'fetch'.");
  const ids = request.profileIds;
  if (
    ids !== undefined &&
    (!Array.isArray(ids) || ids.length > 256 || ids.some((id) => typeof id !== 'string'))
  ) {
    throw new HqVaultError('VAULT_INVALID', 'profileIds must be an array of ids.');
  }
  const features = request.features;
  if (
    features !== undefined &&
    (!Array.isArray(features) ||
      features.length > 16 ||
      features.some((f) => typeof f !== 'string'))
  ) {
    throw new HqVaultError('VAULT_INVALID', 'features must be an array of names.');
  }
  return { mode, features: features ?? [] };
}

/**
 * Authenticate a signed device request (fetch, upload): the device's
 * signature under `purpose`, its status, the timestamp window and the nonce.
 * Returns the approved device it came from.
 */
export function authenticateHqVaultDevice(
  ctx: {
    devices: readonly HqVaultDeviceRecord[];
    identity: HqVaultKeyPair;
    hqId: string;
    nonces: HqVaultNonceCache;
    now: number;
  },
  request: { deviceId?: unknown; ts?: unknown; nonce?: unknown; sig?: unknown },
  purpose: string,
): HqVaultDeviceRecord {
  const device = ctx.devices.find((d) => d.id === request.deviceId);
  const { sig, ...rest } = request;
  // One answer for every authentication failure: an unknown device, a bad
  // signature and a pending device must not be distinguishable to a caller
  // who cannot sign.
  if (!device || !hqVaultVerify({ ...rest, purpose }, sig, device.signPublic)) {
    throw new HqVaultError('VAULT_DENIED', 'Device authentication failed.');
  }
  // Before the clock/replay checks on purpose: the statement is bound to this request's nonce.
  if (device.status === 'revoked') {
    const revocation = signHqVaultRevocation(ctx.identity, {
      hqId: ctx.hqId,
      deviceId: device.id,
      requestNonce: String(request.nonce),
      revokedAt: device.revokedAt ?? new Date(ctx.now).toISOString(),
    });
    throw new HqVaultError('VAULT_DENIED', 'This device was revoked.', { revocation });
  }
  if (device.status !== 'approved') {
    throw new HqVaultError('VAULT_DENIED', 'This device is waiting for approval in HQ.');
  }
  const ts = typeof request.ts === 'string' ? Date.parse(request.ts) : Number.NaN;
  if (!Number.isFinite(ts) || Math.abs(ctx.now - ts) > HQ_VAULT_FETCH_SKEW_MS) {
    throw new HqVaultError(
      'VAULT_DENIED',
      'Request timestamp is outside the accepted window; check the clock.',
    );
  }
  if (
    typeof request.nonce !== 'string' ||
    request.nonce.length < 16 ||
    request.nonce.length > 128
  ) {
    throw new HqVaultError('VAULT_INVALID', 'nonce is malformed.');
  }
  if (!ctx.nonces.remember(`${device.id}:${request.nonce}`, ts, ctx.now)) {
    throw new HqVaultError('VAULT_DENIED', 'Request replayed.');
  }
  return device;
}

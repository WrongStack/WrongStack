/**
 * HQ key vault wire protocol — the shapes a device and HQ exchange over
 * `POST /api/vault/enroll` and `POST /api/vault/fetch`, plus the metadata the
 * dashboard reads.
 *
 * Nothing here travels through the HQ command queue: `commands.jsonl` audits
 * command payloads and acks, and browsers receive them. Vault material moves
 * only on its own routes, sealed to a device and signed by HQ.
 */
import type { HqSealedBox } from './crypto.js';

export const HQ_VAULT_PROTOCOL_VERSION = 1;

/** The only credential kind P0 stores; OAuth leases arrive with central refresh. */
export type HqVaultSecretKind = 'api_key';

/** `local`: the device keeps it in its own vault. `lease`: memory only, until `leaseExpiresAt`. */
export type HqVaultGrantPolicy = 'local' | 'lease';

export type HqVaultDeviceStatus = 'pending' | 'approved' | 'revoked';

/** Secret metadata — never the value. */
export interface HqVaultSecretMeta {
  id: string;
  providerId: string;
  label: string;
  kind: HqVaultSecretKind;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface HqVaultDeviceRecord {
  id: string;
  encPublic: string;
  signPublic: string;
  fingerprint: string;
  hostname: string;
  label?: string;
  status: HqVaultDeviceStatus;
  enrolledAt: string;
  approvedAt?: string;
  revokedAt?: string;
  lastFetchAt?: string;
}

export interface HqVaultGrantRecord {
  id: string;
  secretId: string;
  deviceId: string;
  policy: HqVaultGrantPolicy;
  /** Make this key the provider's active key on import. */
  setActive: boolean;
  /** Lease length for `policy: 'lease'`, seconds. */
  leaseTtlSeconds?: number;
  expiresAt?: string;
  createdAt: string;
}

/** HQ's public identity, pinned by a device at enrollment. */
export interface HqVaultIdentity {
  hqId: string;
  encPublic: string;
  signPublic: string;
  fingerprint: string;
}

// ── Enrollment ──────────────────────────────────────────────────────────────

/** The device half of an enrollment. `mac` covers every other member. */
export interface HqVaultEnrollRequest {
  v: 1;
  codeId: string;
  device: {
    encPublic: string;
    signPublic: string;
    hostname: string;
    label?: string;
  };
  nonce: string;
  mac: string;
}

/** HQ's answer. `mac` (same code) covers every other member, `nonce` echoes the request. */
export interface HqVaultEnrollResponse {
  v: 1;
  deviceId: string;
  status: HqVaultDeviceStatus;
  hq: HqVaultIdentity;
  nonce: string;
  mac: string;
}

// ── Fetch ───────────────────────────────────────────────────────────────────

export type HqVaultFetchMode = 'list' | 'fetch';

/**
 * A device asking for what it was granted. `sig` is the device's Ed25519
 * signature over every other member plus `purpose: HQ_VAULT_FETCH_PURPOSE`.
 */
export interface HqVaultFetchRequest {
  v: 1;
  deviceId: string;
  ts: string;
  nonce: string;
  mode: HqVaultFetchMode;
  secretIds?: string[];
  sig: string;
}

export const HQ_VAULT_FETCH_PURPOSE = 'wstack-hq-vault/v1/fetch';
export const HQ_VAULT_BUNDLE_PURPOSE = 'wstack-hq-vault/v1/bundle';

export interface HqVaultBundleItem {
  secretId: string;
  providerId: string;
  label: string;
  kind: HqVaultSecretKind;
  version: number;
  grantId: string;
  policy: HqVaultGrantPolicy;
  setActive: boolean;
  leaseExpiresAt?: string;
  /** Absent in `list` mode. Opens to JSON `{ "apiKey": string }`. */
  sealed?: HqSealedBox;
}

/** HQ's signed answer. `sig` covers every other member plus `purpose: HQ_VAULT_BUNDLE_PURPOSE`. */
export interface HqVaultBundle {
  v: 1;
  hqId: string;
  deviceId: string;
  issuedAt: string;
  requestNonce: string;
  mode: HqVaultFetchMode;
  items: HqVaultBundleItem[];
  sig: string;
}

/** The associated data a bundle item is sealed under. */
export function hqVaultItemAad(item: {
  deviceId: string;
  secretId: string;
  version: number;
  grantId: string;
}): string {
  return `wstack-hq-vault/v1|${item.deviceId}|${item.secretId}|${item.version}|${item.grantId}`;
}

/**
 * The string an operator carries from the dashboard to the device:
 * `<codeId>.<code>`. The code half is the MAC key and never leaves HQ again.
 */
export function formatHqVaultEnrollmentToken(codeId: string, code: string): string {
  return `${codeId}.${code}`;
}

export function parseHqVaultEnrollmentToken(
  token: string,
): { codeId: string; code: string } | undefined {
  const match = /^([0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(token.trim());
  return match ? { codeId: match[1]!, code: match[2]! } : undefined;
}

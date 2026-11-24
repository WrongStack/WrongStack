/**
 * HQ key vault wire protocol — what a device and HQ exchange over
 * `POST /api/vault/enroll` and `POST /api/vault/fetch`, and the metadata the
 * dashboard reads.
 *
 * The unit HQ manages and grants is a **provider profile** — the same shape a
 * machine's config holds under `providers.<id>`: a type, family, endpoint,
 * model list, its keys (API keys and OAuth sign-ins) and which one is active.
 * A device granted a profile receives all of it.
 *
 * Nothing here travels through the HQ command queue: `commands.jsonl` audits
 * command payloads and acks, and browsers receive them. Vault material moves
 * only on its own routes, sealed to a device and signed by HQ.
 */
import type { HqSealedBox } from './crypto.js';

export const HQ_VAULT_PROTOCOL_VERSION = 2;

export type HqVaultKeyAuthMethod = 'api_key' | 'oauth';

export type HqVaultDeviceStatus = 'pending' | 'approved' | 'revoked';

/** A key's metadata — never the value. */
export interface HqVaultKeyMeta {
  id: string;
  label: string;
  authMethod: HqVaultKeyAuthMethod;
  /** Last characters of the value, for recognising it (e.g. `…f3a9`). Not secret. */
  hint: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** OAuth: when the current access token expires (HQ refreshes before then). */
  expiresAt?: string;
  /** OAuth: account id the provider reported, for display. */
  accountId?: string;
  /** OAuth: the account's own strategy id, as the provider code reads it (`xai`, `kimi`, …). */
  oauthStrategyId?: string;
  /** OAuth: the sign-in HQ ran to make it (`chatgpt`, `copilot`, …); picks HQ's refresher. */
  signIn?: string;
}

/** A provider profile as the dashboard sees it. */
export interface HqVaultProfileMeta {
  id: string;
  /** Catalog provider id (or the id itself for a custom provider). */
  type: string;
  family?: string;
  baseUrl?: string;
  envVars?: string[];
  models?: string[];
  activeKey?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  keys: HqVaultKeyMeta[];
  /** Devices this profile is granted to. */
  deviceIds: string[];
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

/** A profile granted to a device. */
export interface HqVaultGrantRecord {
  id: string;
  profileId: string;
  deviceId: string;
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
  v: 2;
  deviceId: string;
  ts: string;
  nonce: string;
  mode: HqVaultFetchMode;
  /** Only these profiles (default: every granted one). */
  profileIds?: string[];
  sig: string;
}

export const HQ_VAULT_FETCH_PURPOSE = 'wstack-hq-vault/v2/fetch';
export const HQ_VAULT_BUNDLE_PURPOSE = 'wstack-hq-vault/v2/bundle';

/**
 * The secret members of a key, sealed to the device. A device never receives
 * an OAuth refresh token: HQ is the only refresher and the device gets the
 * current access token in `apiKey`.
 */
export interface HqVaultSealedKeyFields {
  apiKey: string;
  tokenType?: string;
  scope?: string;
  project?: string;
}

export interface HqVaultBundleKey {
  id: string;
  label: string;
  authMethod: HqVaultKeyAuthMethod;
  version: number;
  expiresAt?: string;
  accountId?: string;
  oauthStrategyId?: string;
  /** Absent in `list` mode. Opens to JSON {@link HqVaultSealedKeyFields}. */
  sealed?: HqSealedBox;
}

export interface HqVaultBundleProfile {
  id: string;
  type: string;
  family?: string;
  baseUrl?: string;
  envVars?: string[];
  models?: string[];
  activeKey?: string;
  version: number;
  keys: HqVaultBundleKey[];
}

/** HQ's signed answer. `sig` covers every other member plus `purpose: HQ_VAULT_BUNDLE_PURPOSE`. */
export interface HqVaultBundle {
  v: 2;
  hqId: string;
  deviceId: string;
  issuedAt: string;
  requestNonce: string;
  mode: HqVaultFetchMode;
  profiles: HqVaultBundleProfile[];
  sig: string;
}

/** The associated data a bundle key is sealed under. */
export function hqVaultKeyAad(item: {
  deviceId: string;
  profileId: string;
  keyId: string;
  version: number;
}): string {
  return `wstack-hq-vault/v2|${item.deviceId}|${item.profileId}|${item.keyId}|${item.version}`;
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

/**
 * HQ key vault wire protocol — what a device and HQ exchange over
 * `POST /api/vault/enroll`, `/fetch` and `/upload`, and the metadata the
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
  /** Of those, the devices that hold it in memory only (lease grants). */
  leaseDeviceIds?: string[];
  /** Made from this device's upload. */
  origin?: { deviceId: string; uploadId: string };
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
  /**
   * `lease`: the device keeps the keys in memory only — never on disk — and
   * re-fetches them before `leaseTtlSeconds` runs out; without HQ they are
   * gone. Absent: the device stores them encrypted in its config.
   */
  policy?: 'lease';
  leaseTtlSeconds?: number;
}

/** How long a device may hold a leased key without renewing it. */
export const HQ_VAULT_LEASE_TTL_SECONDS = 3600;

/**
 * The feature a device names in its signed fetch request to receive lease
 * grants. A device that does not name it (an older release would write the
 * keys to disk) gets those profiles without secrets.
 */
export const HQ_VAULT_FEATURE_LEASE = 'lease';

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
  /** What this device understands (e.g. {@link HQ_VAULT_FEATURE_LEASE}). */
  features?: string[];
  sig: string;
}

export const HQ_VAULT_FETCH_PURPOSE = 'wstack-hq-vault/v2/fetch';
export const HQ_VAULT_BUNDLE_PURPOSE = 'wstack-hq-vault/v2/bundle';
export const HQ_VAULT_REVOKED_PURPOSE = 'wstack-hq-vault/v2/revoked';

/**
 * HQ's signed word that a device was revoked, answering one fetch request. HQ
 * sends it only after the device's own signature verified, and a device acts
 * on it (removes what HQ gave it) only when it verifies against the pinned HQ
 * identity and names the request's nonce — a forged or replayed 403 never
 * deletes keys. `sig` covers every other member plus `purpose: HQ_VAULT_REVOKED_PURPOSE`.
 */
export interface HqVaultRevocation {
  v: 2;
  hqId: string;
  deviceId: string;
  requestNonce: string;
  revokedAt: string;
  sig: string;
}

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
  /**
   * A lease grant: hold the keys in memory only, for at most `ttlSeconds`.
   * `withheld` when the request did not name the lease feature — the keys
   * then carry no seal and the device must be updated.
   */
  lease?: { ttlSeconds: number; withheld?: true };
  /**
   * The upload this profile was made from, sent only to the device that
   * uploaded it: that machine's own provider becomes this profile instead of
   * getting an `-hq` copy beside it.
   */
  uploadId?: string;
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
  /**
   * HQ's change counter when the bundle was made (it grows with every operator
   * change). A device keeps it, and skips an `hq.vault_changed` notice that
   * names a revision it already has.
   */
  revision?: number;
  sig: string;
}

// ── Upload ──────────────────────────────────────────────────────────────────

export const HQ_VAULT_UPLOAD_PURPOSE = 'wstack-hq-vault/v2/upload';

/**
 * A provider this machine moves into HQ, sealed to HQ's identity key — the
 * endpoint and key labels too, since device routes may run over plain HTTP.
 * API keys only: an OAuth account is signed in on HQ, which then renews it.
 */
export interface HqVaultUploadPayload {
  /** The provider's id in the uploading machine's config. */
  localId: string;
  profile: {
    id: string;
    type: string;
    family?: string;
    baseUrl?: string;
    envVars?: string[];
    models?: string[];
    activeKey?: string;
  };
  keys: { label: string; apiKey: string }[];
}

/**
 * A device's upload. HQ holds it until an operator approves (it then becomes
 * a profile granted back to the device) or rejects it. `uploadId` is the
 * device's own random id, so the device never relies on HQ's unsigned answer
 * to recognise the profile later. `sig` covers every other member plus
 * `purpose: HQ_VAULT_UPLOAD_PURPOSE`; the seal's associated data is
 * {@link hqVaultUploadAad}.
 */
export interface HqVaultUploadRequest {
  v: 2;
  deviceId: string;
  ts: string;
  nonce: string;
  uploadId: string;
  sealed: HqSealedBox;
  sig: string;
}

export interface HqVaultUploadResponse {
  v: 2;
  uploadId: string;
  status: 'pending';
  expiresAt: string;
}

/** A pending upload as the dashboard sees it — the values never, their last characters only. */
export interface HqVaultUploadMeta {
  id: string;
  deviceId: string;
  /** The device's label, or its hostname. */
  device: string;
  receivedAt: string;
  expiresAt: string;
  localId: string;
  profile: HqVaultUploadPayload['profile'];
  keys: { label: string; hint: string }[];
  /** A profile with this id exists already: approve it under another id. */
  conflict: boolean;
}

export function hqVaultUploadAad(item: {
  deviceId: string;
  uploadId: string;
  nonce: string;
}): string {
  return `${HQ_VAULT_UPLOAD_PURPOSE}|${item.deviceId}|${item.uploadId}|${item.nonce}`;
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

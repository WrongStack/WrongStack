/**
 * The HQ key vault (`/api/vault/*`, `auth.admin`): provider profiles — the
 * same shape a machine's config holds under `providers.<id>` — with their
 * keys, the devices they are granted to, and the provider catalog to make
 * them from. Values only ever travel one way, dashboard → HQ; nothing here
 * reads a key back (a key shows only its last four characters).
 */
import type {
  HqVaultAuditEntry,
  HqVaultDeviceRecord,
  HqVaultGrantRecord,
  HqVaultIdentity,
  HqVaultKeyMeta,
  HqVaultProfileMeta,
} from '@wrongstack/hq';
import { fetchJson, postJson, sendJson } from './api.js';

export type {
  HqVaultAuditEntry,
  HqVaultDeviceRecord,
  HqVaultGrantRecord,
  HqVaultIdentity,
  HqVaultKeyMeta,
  HqVaultProfileMeta,
};

export interface VaultStatus {
  /** `unavailable`: no operator password yet, so the vault does not run. */
  state: 'sealed' | 'unsealed' | 'unavailable';
  passwordConfigured: boolean;
  secureChannel: boolean;
  passphraseProtected?: boolean;
  totpEnabled?: boolean;
  identity?: HqVaultIdentity;
  counts?: {
    profiles: number;
    keys: number;
    devices: number;
    pendingDevices: number;
    grants: number;
  };
  elevatedUntil?: string;
}

/** A provider from the models.dev catalog (plus WrongStack's overlay). */
export interface VaultCatalogProvider {
  id: string;
  name: string;
  family: string;
  apiBase?: string;
  envVars: string[];
  doc?: string;
  models: { id: string; name?: string }[];
}

export function fetchVaultStatus(): Promise<VaultStatus> {
  return fetchJson('/api/vault/status');
}

export function elevateVault(input: {
  password: string;
  code?: string;
}): Promise<{ elevatedUntil: string }> {
  return postJson('/api/vault/elevate', input, 'confirming your password');
}

export function unsealVault(passphrase: string): Promise<{ state: 'unsealed' }> {
  return postJson('/api/vault/unseal', { passphrase }, 'unsealing the vault');
}

export function fetchVaultCatalog(): Promise<{ providers: VaultCatalogProvider[] }> {
  return fetchJson('/api/vault/catalog');
}

export function fetchVaultProfiles(): Promise<{ profiles: HqVaultProfileMeta[] }> {
  return fetchJson('/api/vault/profiles');
}

export interface VaultProfileInput {
  id: string;
  type?: string;
  family?: string;
  baseUrl?: string;
  envVars?: string[];
  models?: string[];
  apiKey?: string;
  keyLabel?: string;
}

export function createVaultProfile(
  input: VaultProfileInput,
): Promise<{ profile: HqVaultProfileMeta }> {
  return postJson('/api/vault/profiles', input, 'saving the provider');
}

/** `null` clears a field; an absent field stays as it is. */
export interface VaultProfilePatch {
  family?: string | null;
  baseUrl?: string | null;
  models?: string[] | null;
  activeKey?: string;
}

/**
 * A profile id in a path. HQ matches the id literally against its own grammar
 * (`[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`, `store-profiles.ts`), and every member
 * of it is a legal path character — so `:` stays literal instead of becoming
 * `%3A`, which the route pattern does not accept. Anything outside the grammar
 * is still percent-encoded.
 */
const profilePath = (id: string): string =>
  `/api/vault/profiles/${encodeURIComponent(id).replaceAll('%3A', ':')}`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function updateVaultProfile(
  id: string,
  patch: VaultProfilePatch,
): Promise<{ profile: HqVaultProfileMeta }> {
  return sendJson(profilePath(id), 'updating the provider', {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
}

export function deleteVaultProfile(id: string): Promise<{ deleted: boolean }> {
  return sendJson(profilePath(id), 'removing the provider', { method: 'DELETE' });
}

/** Add a key, or replace the value of the key with this label. */
export function setVaultKey(
  profileId: string,
  input: { label: string; apiKey: string },
): Promise<{ key: HqVaultKeyMeta }> {
  return postJson(`${profilePath(profileId)}/keys`, input, 'saving the key');
}

export function deleteVaultKey(profileId: string, keyId: string): Promise<{ deleted: boolean }> {
  return sendJson(
    `${profilePath(profileId)}/keys/${encodeURIComponent(keyId)}`,
    'deleting the key',
    { method: 'DELETE' },
  );
}

/** `lease`: the device keeps the keys in memory only (omit to leave the policy as it is). */
export function setVaultGrant(
  profileId: string,
  deviceId: string,
  granted: boolean,
  lease?: boolean,
): Promise<{ profile: HqVaultProfileMeta }> {
  return sendJson(
    `${profilePath(profileId)}/devices/${encodeURIComponent(deviceId)}`,
    granted ? 'giving the provider to the device' : 'taking the provider back',
    {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(lease === undefined ? { granted } : { granted, lease }),
    },
  );
}

export function fetchVaultDevices(): Promise<{ devices: HqVaultDeviceRecord[] }> {
  return fetchJson('/api/vault/devices');
}

export function setVaultDeviceStatus(
  id: string,
  action: 'approve' | 'revoke',
): Promise<{ device: HqVaultDeviceRecord }> {
  return postJson(
    `/api/vault/devices/${encodeURIComponent(id)}/${action}`,
    {},
    action === 'approve' ? 'approving the device' : 'revoking the device',
  );
}

export interface VaultEnrollment {
  /** What the operator carries to the device; shown once. */
  enrollmentToken: string;
  expiresAt: string;
  hq: HqVaultIdentity;
}

export function mintVaultEnrollment(input: {
  label?: string;
  autoApprove: boolean;
}): Promise<VaultEnrollment> {
  return postJson('/api/vault/enrollment-codes', input, 'creating the enrollment code');
}

export function fetchVaultAudit(limit = 100): Promise<{ entries: HqVaultAuditEntry[] }> {
  return fetchJson(`/api/vault/audit?limit=${limit}`);
}

/** A provider sign-in HQ can run and keep alive. */
export interface VaultSignInStrategy {
  id: string;
  providerId: string;
  label: string;
  description?: string;
  notes?: readonly string[];
  interactionTypes: readonly ('browser' | 'device_code')[];
}

export interface VaultSignIn {
  attemptId: string;
  strategyId: string;
  providerId: string;
  profileId: string;
  phase: 'awaiting_browser' | 'awaiting_code' | 'exchanging' | 'success' | 'error';
  authorizeUrl?: string;
  /** False: HQ's loopback callback is not listening; paste the redirected URL. */
  bound?: boolean;
  verificationUri?: string;
  userCode?: string;
  message?: string;
  profile?: HqVaultProfileMeta;
}

export function fetchVaultSignInStrategies(): Promise<{ strategies: VaultSignInStrategy[] }> {
  return fetchJson('/api/vault/oauth/strategies');
}

export function startVaultSignIn(input: {
  strategyId: string;
  profileId?: string;
}): Promise<VaultSignIn> {
  return postJson('/api/vault/oauth', input, 'starting the sign-in');
}

export function fetchVaultSignIn(attemptId: string): Promise<VaultSignIn> {
  return fetchJson(`/api/vault/oauth/${encodeURIComponent(attemptId)}`);
}

export function sendVaultSignInCode(attemptId: string, input: string): Promise<VaultSignIn> {
  return postJson(
    `/api/vault/oauth/${encodeURIComponent(attemptId)}/code`,
    { input },
    'finishing the sign-in',
  );
}

export function cancelVaultSignIn(attemptId: string): Promise<VaultSignIn> {
  return sendJson(`/api/vault/oauth/${encodeURIComponent(attemptId)}`, 'cancelling the sign-in', {
    method: 'DELETE',
  });
}

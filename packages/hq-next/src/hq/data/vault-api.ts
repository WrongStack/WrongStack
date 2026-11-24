/**
 * The HQ key vault (`/api/vault/*`, `auth.admin`). Values only ever travel
 * one way — dashboard → HQ, when a key is stored or rotated; nothing here
 * reads a value back.
 */
import type {
  HqVaultAuditEntry,
  HqVaultDeviceRecord,
  HqVaultGrantPolicy,
  HqVaultGrantRecord,
  HqVaultIdentity,
  HqVaultSecretMeta,
} from '@wrongstack/hq';
import { fetchJson, postJson, sendJson } from './api.js';

export type {
  HqVaultAuditEntry,
  HqVaultDeviceRecord,
  HqVaultGrantRecord,
  HqVaultIdentity,
  HqVaultSecretMeta,
};

export interface VaultStatus {
  /** `unavailable`: no operator password yet, so the vault does not run. */
  state: 'sealed' | 'unsealed' | 'unavailable';
  passwordConfigured: boolean;
  secureChannel: boolean;
  passphraseProtected?: boolean;
  totpEnabled?: boolean;
  identity?: HqVaultIdentity;
  counts?: { secrets: number; devices: number; pendingDevices: number; grants: number };
  elevatedUntil?: string;
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

export function fetchVaultSecrets(): Promise<{ secrets: HqVaultSecretMeta[] }> {
  return fetchJson('/api/vault/secrets');
}

export function createVaultSecret(input: {
  providerId: string;
  label: string;
  apiKey: string;
}): Promise<{ secret: HqVaultSecretMeta }> {
  return postJson('/api/vault/secrets', input, 'storing the key');
}

export function rotateVaultSecret(
  id: string,
  apiKey: string,
): Promise<{ secret: HqVaultSecretMeta }> {
  return postJson(
    `/api/vault/secrets/${encodeURIComponent(id)}/rotate`,
    { apiKey },
    'replacing the key',
  );
}

export function deleteVaultSecret(id: string): Promise<{ deleted: boolean }> {
  return sendJson(`/api/vault/secrets/${encodeURIComponent(id)}`, 'deleting the key', {
    method: 'DELETE',
  });
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

export function fetchVaultGrants(): Promise<{ grants: HqVaultGrantRecord[] }> {
  return fetchJson('/api/vault/grants');
}

export function createVaultGrant(input: {
  secretId: string;
  deviceId: string;
  policy: HqVaultGrantPolicy;
  setActive: boolean;
  leaseTtlSeconds?: number;
}): Promise<{ grant: HqVaultGrantRecord }> {
  return postJson('/api/vault/grants', input, 'granting the key');
}

export function revokeVaultGrant(id: string): Promise<{ revoked: boolean }> {
  return sendJson(`/api/vault/grants/${encodeURIComponent(id)}`, 'revoking the grant', {
    method: 'DELETE',
  });
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

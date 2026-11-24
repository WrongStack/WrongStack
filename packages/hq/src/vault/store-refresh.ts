/**
 * Central OAuth renewal: which keys of a device's bundle are about to expire,
 * and turning a renewed credential back into a key input. The renewal itself
 * is a caller-supplied {@link HqVaultRefresher} — provider protocol code lives
 * outside this package — that receives the decrypted secrets, refresh token
 * included, and never sees a device.
 */
import type { HqVaultKeyMeta } from './protocol.js';
import {
  decryptHqVaultSecrets,
  type HqVaultFile,
  type HqVaultKeySecrets,
  type HqVaultStoredKey,
  type HqVaultStoredProfile,
} from './store-model.js';
import type { HqVaultKeyInput } from './store-profiles.js';

/** Renew a key this early before it expires (devices renew ~5 minutes early). */
export const HQ_VAULT_REFRESH_WINDOW_MS = 10 * 60_000;

export interface HqVaultRenewal {
  /** The new secrets; members left out keep their stored value (a refresh token that did not rotate). */
  secrets: Partial<HqVaultKeySecrets> & { apiKey: string };
  expiresAt?: string | undefined;
  accountId?: string | undefined;
}

/**
 * Renew one OAuth key. `undefined` means "cannot renew this one here" (an
 * unknown sign-in); a thrown error is a failed renewal.
 */
export type HqVaultRefresher = (input: {
  profileId: string;
  profileType: string;
  key: HqVaultKeyMeta;
  secrets: HqVaultKeySecrets;
}) => Promise<HqVaultRenewal | undefined>;

/** OAuth keys of profiles granted to `deviceId` that expire within the window. */
export function dueHqVaultKeys(
  file: HqVaultFile,
  deviceId: string,
  profileIds: readonly string[] | undefined,
  now: number,
): { profile: HqVaultStoredProfile; key: HqVaultStoredKey }[] {
  const wanted = profileIds ? new Set(profileIds) : undefined;
  const granted = new Set(
    file.grants.filter((g) => g.deviceId === deviceId).map((g) => g.profileId),
  );
  const out: { profile: HqVaultStoredProfile; key: HqVaultStoredKey }[] = [];
  for (const profile of file.profiles) {
    if (!granted.has(profile.id) || (wanted && !wanted.has(profile.id))) continue;
    for (const key of profile.keys) {
      if (key.authMethod !== 'oauth' || !key.expiresAt) continue;
      const expires = Date.parse(key.expiresAt);
      if (Number.isFinite(expires) && expires - now <= HQ_VAULT_REFRESH_WINDOW_MS) {
        out.push({ profile, key });
      }
    }
  }
  return out;
}

/** Decrypt, renew, and merge into a key input (same label, so it replaces the key). */
export async function renewHqVaultKey(
  master: Buffer,
  profile: HqVaultStoredProfile,
  key: HqVaultStoredKey,
  refresher: HqVaultRefresher,
): Promise<HqVaultKeyInput | undefined> {
  const secrets = decryptHqVaultSecrets(master, key);
  if (!secrets.refreshToken) return undefined;
  const { dek: _dek, payload: _payload, ...meta } = key;
  const renewal = await refresher({
    profileId: profile.id,
    profileType: profile.type,
    key: meta,
    secrets,
  });
  if (!renewal) return undefined;
  const merged: HqVaultKeySecrets = { ...secrets };
  for (const [field, value] of Object.entries(renewal.secrets)) {
    if (typeof value === 'string' && value !== '') {
      merged[field as keyof HqVaultKeySecrets] = value;
    }
  }
  const expiresAt = renewal.expiresAt ?? key.expiresAt;
  const accountId = renewal.accountId ?? key.accountId;
  return {
    label: key.label,
    authMethod: 'oauth',
    secrets: merged,
    ...(expiresAt ? { expiresAt } : {}),
    ...(accountId ? { accountId } : {}),
    ...(key.oauthStrategyId ? { oauthStrategyId: key.oauthStrategyId } : {}),
    ...(key.signIn ? { signIn: key.signIn } : {}),
  };
}

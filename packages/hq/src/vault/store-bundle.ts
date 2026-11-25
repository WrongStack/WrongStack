/**
 * Build the profiles of a device's bundle: every profile granted to it, each
 * key's secrets sealed to that device under associated data that binds the
 * device, profile, key and version. A refresh token or id token never goes
 * into a seal — HQ is the only refresher, devices get the access token.
 */
import { type HqVaultKeyPair, hqVaultSeal, hqVaultSign } from './crypto.js';
import {
  HQ_VAULT_FEATURE_LEASE,
  HQ_VAULT_LEASE_TTL_SECONDS,
  HQ_VAULT_REVOKED_PURPOSE,
  type HqVaultBundleKey,
  type HqVaultBundleProfile,
  type HqVaultDeviceRecord,
  type HqVaultFetchMode,
  type HqVaultRevocation,
  type HqVaultSealedKeyFields,
  hqVaultKeyAad,
} from './protocol.js';
import { decryptHqVaultSecrets, type HqVaultFile } from './store-model.js';

export function buildHqVaultBundleProfiles(
  file: HqVaultFile,
  master: Buffer,
  device: HqVaultDeviceRecord,
  mode: HqVaultFetchMode,
  profileIds: readonly string[] | undefined,
  features: readonly string[] = [],
): HqVaultBundleProfile[] {
  const wanted = profileIds ? new Set(profileIds) : undefined;
  const grants = new Map(
    file.grants.filter((g) => g.deviceId === device.id).map((g) => [g.profileId, g]),
  );
  const out: HqVaultBundleProfile[] = [];
  for (const profile of file.profiles) {
    const grant = grants.get(profile.id);
    if (!grant || (wanted && !wanted.has(profile.id))) continue;
    // A lease grant is sealed only to a device that said it keeps leases off
    // disk; an older one would write the values to its config.
    const lease =
      grant.policy === 'lease'
        ? {
            ttlSeconds: grant.leaseTtlSeconds ?? HQ_VAULT_LEASE_TTL_SECONDS,
            ...(features.includes(HQ_VAULT_FEATURE_LEASE) ? {} : { withheld: true as const }),
          }
        : undefined;
    const keys = profile.keys.map((key): HqVaultBundleKey => {
      const entry: HqVaultBundleKey = {
        id: key.id,
        label: key.label,
        authMethod: key.authMethod,
        version: key.version,
        ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
        ...(key.accountId ? { accountId: key.accountId } : {}),
        ...(key.oauthStrategyId ? { oauthStrategyId: key.oauthStrategyId } : {}),
      };
      if (mode === 'fetch' && !lease?.withheld) {
        const secrets = decryptHqVaultSecrets(master, key);
        const sealed: HqVaultSealedKeyFields = {
          apiKey: secrets.apiKey,
          ...(secrets.tokenType ? { tokenType: secrets.tokenType } : {}),
          ...(secrets.scope ? { scope: secrets.scope } : {}),
          ...(secrets.project ? { project: secrets.project } : {}),
        };
        entry.sealed = hqVaultSeal(
          JSON.stringify(sealed),
          device.encPublic,
          hqVaultKeyAad({
            deviceId: device.id,
            profileId: profile.id,
            keyId: key.id,
            version: key.version,
          }),
        );
      }
      return entry;
    });
    out.push({
      id: profile.id,
      type: profile.type,
      ...(profile.family ? { family: profile.family } : {}),
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
      ...(profile.envVars ? { envVars: [...profile.envVars] } : {}),
      ...(profile.models ? { models: [...profile.models] } : {}),
      ...(profile.activeKey ? { activeKey: profile.activeKey } : {}),
      version: profile.version,
      keys,
      ...(lease ? { lease } : {}),
    });
  }
  return out;
}

/** HQ's signed revocation answer to one fetch request (see {@link HqVaultRevocation}). */
export function signHqVaultRevocation(
  identity: HqVaultKeyPair,
  body: Omit<HqVaultRevocation, 'v' | 'sig'>,
): HqVaultRevocation {
  const signed = { v: 2 as const, ...body };
  return {
    ...signed,
    sig: hqVaultSign({ ...signed, purpose: HQ_VAULT_REVOKED_PURPOSE }, identity),
  };
}

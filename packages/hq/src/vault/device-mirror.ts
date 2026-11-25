/**
 * How an HQ provider profile lands in this machine's config.
 *
 * An HQ profile is HQ-owned: its type, family, endpoint, env vars, model list
 * and its keys are mirrored exactly, and the config entry carries
 * `source: { kind: 'hq', hqId, profileId, version }`. Two rules keep a local
 * setup safe:
 *  - A provider entered on this machine is never overwritten. If its id is
 *    taken by a provider HQ does not own, the HQ profile is stored as
 *    `<id>-hq` (then `<id>-hq-2` …).
 *  - The active key follows HQ only when HQ picks a different one than it
 *    last did (`source.activeKey`); a key refreshed or replaced on HQ never
 *    undoes a switch made here.
 * Keys added on this machine to an HQ profile are kept beside HQ's; one whose
 * label HQ starts using is renamed `<label>-local`, never dropped.
 */

import type { ProviderApiKey, ProviderConfig } from '@wrongstack/contracts/types/config';
import { nowIso } from '@wrongstack/primitives';
import type { HqVaultOpenedKey, HqVaultOpenedProfile } from './client.js';
import { normalizeKeys, writeKeysBack } from './device-keys.js';

const MIRRORED = ['family', 'baseUrl', 'envVars', 'models'] as const;

/**
 * What a memory-only (lease) key stores as its `apiKey`: a marker, never the
 * value. The value lives in each process's lease store; key resolution never
 * returns the marker.
 */
export const HQ_LEASED_KEY_MARKER = 'leased-by-hq:held-in-memory-only';

/** The config id an HQ profile is stored under on this machine. */
export function resolveHqLocalId(
  all: Record<string, ProviderConfig>,
  hqId: string,
  profileId: string,
): string {
  const owned = (p: ProviderConfig | undefined) =>
    p?.source?.kind === 'hq' && p.source.hqId === hqId && p.source.profileId === profileId;
  // Own-key lookups: an id is untrusted input, and `constructor` must not read as taken.
  const taken = (id: string) => Object.hasOwn(all, id);
  for (const [id, provider] of Object.entries(all)) if (owned(provider)) return id;
  if (!taken(profileId)) return profileId;
  let candidate = `${profileId}-hq`;
  for (let n = 2; taken(candidate) && !owned(all[candidate]); n++)
    candidate = `${profileId}-hq-${n}`;
  return candidate;
}

/** One opened bundle key as this machine stores it. Never carries a refresh token. */
export function hqBundleKeyToApiKey(
  key: HqVaultOpenedKey & { secrets: NonNullable<HqVaultOpenedKey['secrets']> },
  hqId: string,
  profileId: string,
  createdAt: string,
  lease = false,
): ProviderApiKey {
  return {
    label: key.label,
    apiKey: lease ? HQ_LEASED_KEY_MARKER : key.secrets.apiKey,
    createdAt,
    authMethod: key.authMethod,
    ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
    ...(key.secrets.tokenType ? { tokenType: key.secrets.tokenType } : {}),
    ...(key.secrets.scope ? { scope: key.secrets.scope } : {}),
    ...(key.secrets.project ? { project: key.secrets.project } : {}),
    ...(key.accountId ? { accountId: key.accountId } : {}),
    ...(key.oauthStrategyId ? { oauthStrategyId: key.oauthStrategyId } : {}),
    source: {
      kind: 'hq',
      hqId,
      keyId: key.id,
      version: key.version,
      profileId,
      ...(lease ? { lease: true as const } : {}),
    },
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function mirrorHqProfile(
  existing: ProviderConfig | undefined,
  profile: HqVaultOpenedProfile,
  hqId: string,
): { provider: ProviderConfig; changed: boolean; renamed: { from: string; to: string }[] } {
  const before = existing ? JSON.stringify(existing) : undefined;
  const provider: ProviderConfig = existing ? { ...existing } : { type: profile.type };
  provider.type = profile.type;
  for (const field of MIRRORED) {
    const value = profile[field];
    if (value === undefined) delete provider[field];
    else
      (provider as unknown as Record<string, unknown>)[field] = Array.isArray(value)
        ? [...value]
        : value;
  }

  const lease = profile.lease !== undefined && !profile.lease.withheld;
  const previous = normalizeKeys(provider);
  const local = previous.filter((k) => k.source?.kind !== 'hq' || k.source.hqId !== hqId);
  const hqKeys: ProviderApiKey[] = [];
  for (const key of profile.keys) {
    if (!key.secrets) continue;
    const prior = previous.find(
      (k) => k.source?.kind === 'hq' && k.source.hqId === hqId && k.source.keyId === key.id,
    );
    hqKeys.push(
      hqBundleKeyToApiKey(
        { ...key, secrets: key.secrets },
        hqId,
        profile.id,
        prior?.createdAt || nowIso(),
        lease,
      ),
    );
  }
  // Labels are a key's address: a local key whose label HQ now uses moves aside.
  const hqLabels = new Set(hqKeys.map((k) => k.label));
  const used = new Set([...hqLabels, ...local.map((k) => k.label)]);
  const renamed: { from: string; to: string }[] = [];
  const kept = local.map((k) => {
    if (!hqLabels.has(k.label)) return k;
    let label = `${k.label}-local`;
    for (let n = 2; used.has(label); n++) label = `${k.label}-local-${n}`;
    used.add(label);
    renamed.push({ from: k.label, to: label });
    if (provider.activeKey === k.label) provider.activeKey = label;
    return { ...k, label };
  });
  const keys = [...hqKeys, ...kept];

  const lastApplied = provider.source?.kind === 'hq' ? provider.source.activeKey : undefined;
  if (profile.activeKey && hqLabels.has(profile.activeKey) && profile.activeKey !== lastApplied) {
    provider.activeKey = profile.activeKey;
  }
  provider.source = {
    kind: 'hq',
    hqId,
    profileId: profile.id,
    version: profile.version,
    ...(profile.activeKey ? { activeKey: profile.activeKey } : {}),
  };
  writeKeysBack(provider, keys);
  return {
    provider,
    changed: before === undefined || !sameJson(JSON.parse(before), provider),
    renamed,
  };
}

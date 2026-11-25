/**
 * Pure profile/key/grant mutations on a draft {@link HqVaultFile}. `store.ts`
 * runs them inside its single-writer queue and audits the result; this module
 * only validates input and edits the draft.
 *
 * A profile's `version` advances on every change a device would mirror (its
 * config or any of its keys), so a device compares one number per profile. A
 * key's `version` advances only when its value changes.
 */
import { randomUUID } from 'node:crypto';
import type { WireFamily } from '@wrongstack/contracts/types/models-registry';
import {
  HQ_VAULT_LEASE_TTL_SECONDS,
  type HqVaultKeyAuthMethod,
  type HqVaultKeyMeta,
  type HqVaultProfileMeta,
} from './protocol.js';
import {
  encryptHqVaultSecrets,
  HqVaultError,
  type HqVaultFile,
  type HqVaultKeySecrets,
  type HqVaultStoredKey,
  type HqVaultStoredProfile,
  hqVaultHint,
  hqVaultText,
} from './store-model.js';

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_SECRET_LENGTH = 16_384;
const MAX_LIST = 256;

export const HQ_VAULT_WIRE_FAMILIES: readonly WireFamily[] = [
  'anthropic',
  'anthropic-oauth',
  'openai',
  'openai-compatible',
  'openai-codex',
  'github-copilot',
  'google',
  'google-antigravity',
];

export interface HqVaultProfileFields {
  type?: string;
  family?: WireFamily;
  baseUrl?: string;
  envVars?: string[];
  models?: string[];
  activeKey?: string;
}

export interface HqVaultKeyInput {
  label: string;
  authMethod: HqVaultKeyAuthMethod;
  secrets: HqVaultKeySecrets;
  expiresAt?: string;
  accountId?: string;
  oauthStrategyId?: string;
  signIn?: string;
}

function invalid(message: string): never {
  throw new HqVaultError('VAULT_INVALID', message);
}

/** Provider ids a machine reserves for itself (`provider-config-state.ts`). */
const RESERVED_IDS = new Set(['acp', 'wrongforge']);

function profileId(value: unknown, field = 'id'): string {
  const id = hqVaultText(value, 64);
  if (id === undefined || !PROFILE_ID.test(id)) {
    invalid(`${field} must be a provider id (letters, digits, . _ : -).`);
  }
  // A device rejects these at boot (reserved system providers, Object members).
  if (
    RESERVED_IDS.has(id.toLowerCase()) ||
    id === 'prototype' ||
    Object.hasOwn(Object.prototype, id)
  ) {
    invalid(`"${id}" is reserved; pick another ${field}.`);
  }
  return id;
}

function stringList(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) invalid(`${field} must be a list.`);
  const out: string[] = [];
  for (const item of value) {
    const text = hqVaultText(item, max);
    if (text === undefined) invalid(`${field} holds an empty or over-long entry.`);
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * Validate the config members of a profile. `null` (or an empty string) in a
 * patch clears a member; `undefined` leaves it alone.
 */
export function parseHqVaultProfileFields(
  input: Record<string, unknown>,
): HqVaultProfileFields & { clear: (keyof HqVaultProfileFields)[] } {
  const out: HqVaultProfileFields & { clear: (keyof HqVaultProfileFields)[] } = { clear: [] };
  const cleared = (v: unknown) => v === null || v === '';
  if (input.type !== undefined) {
    if (cleared(input.type)) out.clear.push('type');
    else out.type = profileId(input.type, 'type');
  }
  if (input.family !== undefined) {
    if (cleared(input.family)) out.clear.push('family');
    else if (!HQ_VAULT_WIRE_FAMILIES.includes(input.family as WireFamily)) {
      invalid(`family must be one of: ${HQ_VAULT_WIRE_FAMILIES.join(', ')}.`);
    } else out.family = input.family as WireFamily;
  }
  if (input.baseUrl !== undefined) {
    if (cleared(input.baseUrl)) out.clear.push('baseUrl');
    else {
      const url = hqVaultText(input.baseUrl, 2048);
      let parsed: URL | undefined;
      try {
        parsed = url ? new URL(url) : undefined;
      } catch {
        parsed = undefined;
      }
      if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
        invalid('baseUrl must be an http(s) URL.');
      }
      out.baseUrl = url!;
    }
  }
  if (input.envVars !== undefined) {
    if (input.envVars === null) out.clear.push('envVars');
    else out.envVars = stringList(input.envVars, 'envVars', 128);
  }
  if (input.models !== undefined) {
    if (input.models === null) out.clear.push('models');
    else out.models = stringList(input.models, 'models', 256);
  }
  if (input.activeKey !== undefined) {
    if (cleared(input.activeKey)) out.clear.push('activeKey');
    else out.activeKey = hqVaultText(input.activeKey, 80) ?? invalid('activeKey is invalid.');
  }
  return out;
}

/** Validate a key as typed in the dashboard (an API key) or produced by a sign-in. */
export function parseHqVaultKeyInput(input: Record<string, unknown>): HqVaultKeyInput {
  const label = hqVaultText(input.label, 80) ?? invalid('Name the key (label).');
  const authMethod: HqVaultKeyAuthMethod = input.authMethod === 'oauth' ? 'oauth' : 'api_key';
  const apiKey = hqVaultText(input.apiKey, MAX_SECRET_LENGTH) ?? invalid('apiKey is required.');
  const secrets: HqVaultKeySecrets = { apiKey };
  for (const field of [
    'refreshToken',
    'idToken',
    'tokenType',
    'scope',
    'project',
    'oauthClientId',
    'oauthSubject',
  ] as const) {
    const value = hqVaultText(input[field], MAX_SECRET_LENGTH);
    if (value !== undefined) secrets[field] = value;
  }
  const out: HqVaultKeyInput = { label, authMethod, secrets };
  if (input.expiresAt !== undefined) {
    const ms = typeof input.expiresAt === 'string' ? Date.parse(input.expiresAt) : Number.NaN;
    if (!Number.isFinite(ms)) invalid('expiresAt must be an ISO date.');
    out.expiresAt = new Date(ms).toISOString();
  }
  const accountId = hqVaultText(input.accountId, 256);
  if (accountId) out.accountId = accountId;
  const strategy = hqVaultText(input.oauthStrategyId, 64);
  if (strategy) out.oauthStrategyId = strategy;
  const signIn = hqVaultText(input.signIn, 64);
  if (signIn) out.signIn = signIn;
  return out;
}

export function findHqVaultProfile(file: HqVaultFile, id: string): HqVaultStoredProfile {
  const profile = file.profiles.find((p) => p.id === id);
  if (!profile) throw new HqVaultError('VAULT_NOT_FOUND', 'No such provider profile.');
  return profile;
}

function applyFields(
  profile: HqVaultStoredProfile,
  fields: ReturnType<typeof parseHqVaultProfileFields>,
): void {
  for (const key of fields.clear) {
    if (key === 'type') profile.type = profile.id;
    else delete profile[key];
  }
  if (fields.type !== undefined) profile.type = fields.type;
  if (fields.family !== undefined) profile.family = fields.family;
  if (fields.baseUrl !== undefined) profile.baseUrl = fields.baseUrl;
  if (fields.envVars !== undefined) profile.envVars = fields.envVars;
  if (fields.models !== undefined) profile.models = fields.models;
  if (fields.activeKey !== undefined) {
    if (!profile.keys.some((k) => k.label === fields.activeKey)) {
      invalid(`No key labelled "${fields.activeKey}" on ${profile.id}.`);
    }
    profile.activeKey = fields.activeKey;
  }
}

export function createHqVaultProfile(
  file: HqVaultFile,
  input: Record<string, unknown>,
  at: string,
): HqVaultStoredProfile {
  const id = profileId(input.id);
  if (file.profiles.some((p) => p.id === id)) {
    throw new HqVaultError('VAULT_CONFLICT', `A provider profile "${id}" already exists.`);
  }
  const fields = parseHqVaultProfileFields({ ...input, activeKey: undefined });
  const profile: HqVaultStoredProfile = {
    id,
    type: id,
    version: 1,
    createdAt: at,
    updatedAt: at,
    keys: [],
  };
  applyFields(profile, fields);
  file.profiles.push(profile);
  return profile;
}

export function updateHqVaultProfile(
  file: HqVaultFile,
  id: string,
  input: Record<string, unknown>,
  at: string,
): HqVaultStoredProfile {
  const profile = findHqVaultProfile(file, id);
  applyFields(profile, parseHqVaultProfileFields(input));
  touch(profile, at);
  return profile;
}

export function deleteHqVaultProfile(file: HqVaultFile, id: string): void {
  findHqVaultProfile(file, id);
  file.profiles = file.profiles.filter((p) => p.id !== id);
  file.grants = file.grants.filter((g) => g.profileId !== id);
}

/**
 * Add a key, or replace the value of the key with the same label (its version
 * advances so devices pick up the new value). The first key of a profile
 * becomes its active key.
 */
export function upsertHqVaultKey(
  file: HqVaultFile,
  master: Buffer,
  id: string,
  input: HqVaultKeyInput,
  at: string,
): { key: HqVaultStoredKey; created: boolean } {
  const profile = findHqVaultProfile(file, id);
  const existing = profile.keys.find((k) => k.label === input.label);
  if (existing?.authMethod === 'oauth' && input.authMethod !== 'oauth') {
    throw new HqVaultError(
      'VAULT_CONFLICT',
      `"${input.label}" is a sign-in; sign in again to renew it, or delete it first.`,
    );
  }
  const keyId = existing?.id ?? randomUUID();
  const version = existing ? existing.version + 1 : 1;
  const key: HqVaultStoredKey = {
    id: keyId,
    label: input.label,
    authMethod: input.authMethod,
    hint: hqVaultHint(input.secrets.apiKey),
    version,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.oauthStrategyId ? { oauthStrategyId: input.oauthStrategyId } : {}),
    ...(input.signIn ? { signIn: input.signIn } : {}),
    ...encryptHqVaultSecrets(master, keyId, version, input.secrets),
  };
  if (existing) profile.keys[profile.keys.indexOf(existing)] = key;
  else profile.keys.push(key);
  if (profile.activeKey === undefined) profile.activeKey = key.label;
  touch(profile, at);
  return { key, created: !existing };
}

export function deleteHqVaultKey(
  file: HqVaultFile,
  id: string,
  keyId: string,
  at: string,
): HqVaultStoredKey {
  const profile = findHqVaultProfile(file, id);
  const key = profile.keys.find((k) => k.id === keyId);
  if (!key) throw new HqVaultError('VAULT_NOT_FOUND', 'No such key.');
  profile.keys = profile.keys.filter((k) => k.id !== keyId);
  if (profile.activeKey === key.label) {
    if (profile.keys[0]) profile.activeKey = profile.keys[0].label;
    else delete profile.activeKey;
  }
  touch(profile, at);
  return key;
}

/** Grant or withdraw a profile for a device. Returns false when nothing changed. */
/**
 * Grant (or withdraw) a profile; `lease` (when given) sets whether the device
 * holds it in memory only. True when anything changed — a lease toggle on an
 * existing grant included.
 */
export function setHqVaultGrant(
  file: HqVaultFile,
  id: string,
  deviceId: unknown,
  granted: boolean,
  at: string,
  lease?: boolean,
): boolean {
  findHqVaultProfile(file, id);
  const device = file.devices.find((d) => d.id === deviceId);
  if (!device || device.status === 'revoked') {
    throw new HqVaultError('VAULT_NOT_FOUND', 'No such device.');
  }
  const existing = file.grants.find((g) => g.profileId === id && g.deviceId === device.id);
  if (!granted) {
    if (!existing) return false;
    file.grants = file.grants.filter((g) => g !== existing);
    return true;
  }
  const grant = existing ?? { id: randomUUID(), profileId: id, deviceId: device.id, createdAt: at };
  const wasLease = grant.policy === 'lease';
  if (lease === true) {
    grant.policy = 'lease';
    grant.leaseTtlSeconds ??= HQ_VAULT_LEASE_TTL_SECONDS;
  } else if (lease === false) {
    delete grant.policy;
    delete grant.leaseTtlSeconds;
  }
  if (!existing) file.grants.push(grant);
  return !existing || wasLease !== (grant.policy === 'lease');
}

function touch(profile: HqVaultStoredProfile, at: string): void {
  profile.version += 1;
  profile.updatedAt = at;
}

export function hqVaultKeyMeta(key: HqVaultStoredKey): HqVaultKeyMeta {
  const { dek: _dek, payload: _payload, ...meta } = key;
  return meta;
}

export function hqVaultProfileMeta(
  file: HqVaultFile,
  profile: HqVaultStoredProfile,
): HqVaultProfileMeta {
  const { keys, ...rest } = profile;
  return {
    ...structuredClone(rest),
    keys: keys.map(hqVaultKeyMeta),
    deviceIds: file.grants.filter((g) => g.profileId === profile.id).map((g) => g.deviceId),
    leaseDeviceIds: file.grants
      .filter((g) => g.profileId === profile.id && g.policy === 'lease')
      .map((g) => g.deviceId),
  };
}

/** What a provider sign-in produced (`ProviderAuthOutcome`), as HQ stores it. */
export interface HqVaultSignInResult {
  providerId: string;
  family: string;
  baseUrl?: string | undefined;
  models: readonly string[];
  credential: Record<string, unknown>;
}

/**
 * Store a sign-in on a profile — creating it from the outcome (type, family,
 * endpoint, models) when it does not exist — as an OAuth key that becomes the
 * active one. Every token, the refresh token included, stays encrypted here.
 */
export function applyHqVaultSignIn(
  file: HqVaultFile,
  master: Buffer,
  input: { profileId?: string | undefined; strategyId: string; result: HqVaultSignInResult },
  at: string,
): { profile: HqVaultStoredProfile; key: HqVaultStoredKey } {
  const { result } = input;
  const id = profileId(input.profileId ?? result.providerId);
  const type = profileId(result.providerId, 'providerId');
  const models = result.models.length > 0 ? stringList(result.models, 'models', 256) : undefined;
  let profile = file.profiles.find((p) => p.id === id);
  if (profile && profile.type !== type) {
    throw new HqVaultError(
      'VAULT_CONFLICT',
      `"${id}" belongs to ${profile.type}; sign in under another alias.`,
    );
  }
  if (!profile) {
    profile = createHqVaultProfile(file, { id, type, family: result.family }, at);
  }
  const fields = parseHqVaultProfileFields({
    family: result.family,
    ...(result.baseUrl && !profile.baseUrl ? { baseUrl: result.baseUrl } : {}),
    ...(models ? { models } : {}),
  });
  applyFields(profile, fields);
  const key = parseHqVaultKeyInput({
    ...result.credential,
    label: result.credential.label ?? 'default',
    authMethod: 'oauth',
    signIn: input.strategyId,
  });
  const stored = upsertHqVaultKey(file, master, id, key, at).key;
  profile.activeKey = stored.label;
  return { profile, key: stored };
}

/**
 * The Providers screen's decisions, kept out of the components so they can be
 * tested without a DOM: what the operator may do right now, how the catalog
 * is searched and grouped, which alias a new profile gets, form checks, and
 * the audit trail in words.
 */
import type {
  HqVaultAuditEntry,
  HqVaultDeviceRecord,
  HqVaultProfileMeta,
  VaultCatalogProvider,
  VaultStatus,
} from '@hq/data/vault-api';

/** Mirrors the server's profile id rule (`store-profiles.ts`). */
export const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** The wire families a custom provider can speak (`store-profiles.ts`). */
export const WIRE_FAMILIES = [
  { id: 'openai-compatible', label: 'OpenAI-compatible (most gateways, vLLM, LiteLLM)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'google', label: 'Google Gemini' },
] as const;

export type VaultGateKind = 'unavailable' | 'sealed' | 'insecure' | 'locked' | 'ready';

export interface VaultGate {
  kind: VaultGateKind;
  /** Whether lists can be shown. */
  canRead: boolean;
  /** Whether add / replace / grant controls are live. */
  canWrite: boolean;
  title: string;
  detail: string;
}

/**
 * The one thing standing between the operator and a change, in the order the
 * server checks it: a password must exist, the vault must be unsealed, the
 * channel must keep a pasted key off the wire, and the operator must have
 * confirmed their password recently.
 */
export function vaultGate(status: VaultStatus, now: number): VaultGate {
  if (status.state === 'unavailable' || !status.passwordConfigured) {
    return {
      kind: 'unavailable',
      canRead: false,
      canWrite: false,
      title: 'Set an HQ password first',
      detail:
        'HQ confirms every key change with your password, so provider management stays off until one exists. Set it under System → Security.',
    };
  }
  if (status.state === 'sealed') {
    return {
      kind: 'sealed',
      canRead: true,
      canWrite: false,
      title: 'The vault is sealed',
      detail:
        'HQ restarted and its master key is protected by a passphrase. Enter it to change or deliver keys again; until then devices get nothing.',
    };
  }
  if (!status.secureChannel) {
    return {
      kind: 'insecure',
      canRead: true,
      canWrite: false,
      title: 'Read-only over this connection',
      detail:
        'This page reached HQ over plain HTTP from another machine, so a key typed here would cross the network in the clear. Open HQ on its own machine, start it with --tls-cert/--tls-key, or reach it through Tailscale serve or a local reverse proxy.',
    };
  }
  const until = status.elevatedUntil !== undefined ? Date.parse(status.elevatedUntil) : Number.NaN;
  if (!Number.isFinite(until) || until <= now) {
    return {
      kind: 'locked',
      canRead: true,
      canWrite: false,
      title: 'Locked',
      detail: status.totpEnabled
        ? 'Unlock with your HQ password and an authenticator code to make changes; it stays unlocked for 10 minutes.'
        : 'Unlock with your HQ password to make changes; it stays unlocked for 10 minutes.',
    };
  }
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  return {
    kind: 'ready',
    canRead: true,
    canWrite: true,
    title: 'Unlocked',
    detail: `${minutes} more minute${minutes === 1 ? '' : 's'}`,
  };
}

/** Family groups in the catalog, in the order an operator looks for them. */
const FAMILY_ORDER = ['anthropic', 'openai', 'google', 'openai-compatible'];
const FAMILY_TITLE: Record<string, string> = {
  anthropic: 'Anthropic',
  'anthropic-oauth': 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI',
  google: 'Google',
  'google-antigravity': 'Google',
  'github-copilot': 'GitHub Copilot',
  'openai-compatible': 'OpenAI-compatible',
};

export function familyTitle(family: string | undefined): string {
  return (
    (family && Object.hasOwn(FAMILY_TITLE, family) ? FAMILY_TITLE[family] : undefined) ?? 'Other'
  );
}

export interface CatalogGroup {
  title: string;
  providers: VaultCatalogProvider[];
}

/**
 * Wire families whose credential comes only from a sign-in (a subscription
 * account), never from a pasted key. A pasted value would make a profile that
 * cannot work, so the catalog offers no key form for them.
 */
const SIGN_IN_FAMILIES = new Set([
  'openai-codex',
  'github-copilot',
  'google-antigravity',
  'anthropic-oauth',
]);

export function isSignInOnly(provider: { family: string }): boolean {
  return SIGN_IN_FAMILIES.has(provider.family);
}

/** Shown first, in this order, when the catalog has them. */
export const POPULAR_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'mistral',
  'deepseek',
  'xai',
  'groq',
  'together',
  'fireworks',
  'cerebras',
] as const;

/**
 * Search (name, id, family, endpoint host) and group. With a query, one flat
 * "Matches" group in the catalog's own order. Without one, "Popular" first,
 * then the rest by wire family.
 */
export function catalogGroups(
  providers: readonly VaultCatalogProvider[],
  query: string,
): CatalogGroup[] {
  const q = query.trim().toLowerCase();
  if (q !== '') {
    const hit = providers.filter((p) =>
      [p.id, p.name, p.family, p.apiBase ?? ''].some((v) => v.toLowerCase().includes(q)),
    );
    return hit.length > 0 ? [{ title: 'Matches', providers: hit }] : [];
  }
  const byId = new Map(providers.map((p) => [p.id, p]));
  const popular = POPULAR_PROVIDERS.flatMap((id) => byId.get(id) ?? []);
  const popularIds = new Set(popular.map((p) => p.id));
  const groups = new Map<string, VaultCatalogProvider[]>();
  for (const provider of providers) {
    if (popularIds.has(provider.id)) continue;
    const title = familyTitle(provider.family);
    groups.set(title, [...(groups.get(title) ?? []), provider]);
  }
  const rank = (title: string): number => {
    const index = FAMILY_ORDER.findIndex((f) => familyTitle(f) === title);
    return index === -1 ? FAMILY_ORDER.length : index;
  };
  const rest = [...groups.entries()]
    .map(([title, list]) => ({ title, providers: list }))
    .sort((a, b) => rank(a.title) - rank(b.title) || a.title.localeCompare(b.title));
  return popular.length > 0 ? [{ title: 'Popular', providers: popular }, ...rest] : rest;
}

/** The family chip of a saved profile: its own family, else its catalog type's; none if unknown. */
export function profileFamilyLabel(profile: { family?: string; type: string }): string | null {
  if (profile.family) return familyTitle(profile.family);
  return Object.hasOwn(FAMILY_TITLE, profile.type) ? FAMILY_TITLE[profile.type]! : null;
}

/** The id a new profile of `type` gets: the type itself, then `type-2`, `type-3` … */
export function nextProfileId(type: string, profiles: readonly HqVaultProfileMeta[]): string {
  const taken = new Set(profiles.map((p) => p.id));
  if (!taken.has(type)) return type;
  for (let n = 2; ; n++) if (!taken.has(`${type}-${n}`)) return `${type}-${n}`;
}

/** How many saved profiles were made from each catalog provider. */
export function configuredCounts(profiles: readonly HqVaultProfileMeta[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of profiles) counts.set(p.type, (counts.get(p.type) ?? 0) + 1);
  return counts;
}

/** A key as it can be recognised without showing it. */
export function maskedKey(hint: string): string {
  return hint ? `••••${hint}` : '••••';
}

export function profileIdError(id: string, profiles: readonly HqVaultProfileMeta[]): string | null {
  const value = id.trim();
  if (!PROFILE_ID_PATTERN.test(value)) {
    return 'Alias: letters, digits and . _ : - (for example openai or team-proxy).';
  }
  if (profiles.some((p) => p.id === value))
    return `"${value}" is already saved; pick another alias.`;
  return null;
}

export function keyFormError(input: { label: string; apiKey: string }): string | null {
  if (input.label.trim() === '') return 'Name the key.';
  if (input.label.trim().length > 80) return 'Keep the name under 80 characters.';
  if (input.apiKey.trim() === '') return 'Paste the key.';
  return null;
}

export function baseUrlError(value: string, required: boolean): string | null {
  const url = value.trim();
  if (url === '') return required ? 'A custom provider needs its endpoint URL.' : null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return null;
  } catch {
    // falls through
  }
  return 'Endpoint: an http(s) URL such as https://llm.example.com/v1.';
}

/** Comma or newline separated model ids, de-duplicated, empty → undefined. */
export function parseModelList(text: string): string[] | undefined {
  const models = [
    ...new Set(
      text
        .split(/[\n,]+/)
        .map((m) => m.trim())
        .filter(Boolean),
    ),
  ];
  return models.length > 0 ? models : undefined;
}

export function deviceName(device: HqVaultDeviceRecord): string {
  return device.label ?? device.hostname;
}

function deviceLabel(
  id: string | undefined,
  devices: ReadonlyMap<string, HqVaultDeviceRecord>,
): string {
  if (id === undefined) return 'a device';
  const device = devices.get(id);
  return device ? deviceName(device) : `device ${id.slice(0, 8)}`;
}

/** One audit entry as a sentence. Never shows a value — the log holds none. */
export function auditSentence(
  entry: HqVaultAuditEntry,
  devices: ReadonlyMap<string, HqVaultDeviceRecord>,
): string {
  const profile = entry.profileId ?? 'a provider';
  const key = entry.keyLabel ? `${profile}/${entry.keyLabel}` : `a ${profile} key`;
  const device = deviceLabel(entry.deviceId, devices);
  switch (entry.kind) {
    case 'unseal':
      return 'Vault unsealed';
    case 'profile.create':
      return `Added ${profile}`;
    case 'profile.update':
      return `Changed ${profile}`;
    case 'profile.delete':
      return `Removed ${profile}`;
    case 'key.set':
      return entry.version !== undefined && entry.version > 1
        ? `Replaced ${key} (version ${entry.version})`
        : `Saved ${key}`;
    case 'key.delete':
      return `Deleted ${key}`;
    case 'key.refresh':
      return `Refreshed ${key}`;
    case 'oauth.signin':
      return `Signed in ${key}`;
    case 'device.enroll':
      return `${device} enrolled`;
    case 'device.approve':
      return `Approved ${device}`;
    case 'device.revoke':
      return `Revoked ${device}`;
    case 'grant.create':
      return `Gave ${profile} to ${device}`;
    case 'grant.revoke':
      return `Took ${profile} back from ${device}`;
    case 'enrollment.mint':
      return 'Created an enrollment code';
    case 'fetch': {
      const count = entry.profileIds?.length ?? 0;
      return `${device} fetched ${count} provider${count === 1 ? '' : 's'}`;
    }
    case 'upload.receive':
      return `${device} uploaded ${profile}`;
    case 'upload.approve':
      return `Approved the upload of ${profile} from ${device}`;
    case 'upload.reject':
      return `Rejected an upload from ${device}`;
    default:
      return entry.kind;
  }
}

/** Who did it, readably: the dashboard session, a token, or a device. */
export function auditActor(
  actor: string,
  devices: ReadonlyMap<string, HqVaultDeviceRecord>,
): string {
  if (actor.startsWith('device:')) return deviceLabel(actor.slice('device:'.length), devices);
  if (actor.startsWith('hq-dashboard:token:')) return `token ${actor.slice(19, 27)}`;
  if (actor.startsWith('hq-dashboard:session')) return 'dashboard sign-in';
  return actor;
}

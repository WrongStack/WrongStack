/**
 * The key vault screen's decisions, kept out of the components so they can be
 * tested without a DOM: what the operator is allowed to do right now, the
 * key × device grant matrix, and the audit trail in words.
 */
import type {
  HqVaultAuditEntry,
  HqVaultDeviceRecord,
  HqVaultGrantRecord,
  HqVaultSecretMeta,
  VaultStatus,
} from '@hq/data/vault-api';

/** Mirrors the server's provider id rule (`store.ts`). */
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export type VaultGateKind = 'unavailable' | 'sealed' | 'insecure' | 'locked' | 'ready';

export interface VaultGate {
  kind: VaultGateKind;
  /** Whether lists can be shown. */
  canRead: boolean;
  /** Whether store / grant / revoke controls are live. */
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
        'The key vault confirms every change with your HQ password, so it stays off until one exists. Set it under System → Security.',
    };
  }
  if (status.state === 'sealed') {
    return {
      kind: 'sealed',
      canRead: true,
      canWrite: false,
      title: 'The vault is sealed',
      detail:
        'HQ restarted and its master key is protected by a passphrase. Enter it to store or deliver keys again; until then devices get nothing.',
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
      title: 'Confirm your password to make changes',
      detail: status.totpEnabled
        ? 'Changes need your HQ password and an authenticator code; the confirmation lasts 10 minutes.'
        : 'Changes need your HQ password; the confirmation lasts 10 minutes.',
    };
  }
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  return {
    kind: 'ready',
    canRead: true,
    canWrite: true,
    title: 'Unlocked for changes',
    detail: `Your confirmation is good for ${minutes} more minute${minutes === 1 ? '' : 's'}.`,
  };
}

export interface GrantCell {
  deviceId: string;
  grant: HqVaultGrantRecord | null;
}

export interface GrantRow {
  secret: HqVaultSecretMeta;
  cells: GrantCell[];
}

/**
 * One row per key, one column per device that can still receive keys
 * (revoked devices have no grants and take no new ones). Devices sort
 * approved first, then by name; keys by provider, then label.
 */
export function grantMatrix(
  secrets: readonly HqVaultSecretMeta[],
  devices: readonly HqVaultDeviceRecord[],
  grants: readonly HqVaultGrantRecord[],
): { devices: HqVaultDeviceRecord[]; rows: GrantRow[] } {
  const columns = devices
    .filter((d) => d.status !== 'revoked')
    .sort(
      (a, b) =>
        Number(b.status === 'approved') - Number(a.status === 'approved') ||
        deviceName(a).localeCompare(deviceName(b)),
    );
  const byPair = new Map(grants.map((g) => [`${g.secretId}\0${g.deviceId}`, g]));
  const rows = [...secrets]
    .sort((a, b) => a.providerId.localeCompare(b.providerId) || a.label.localeCompare(b.label))
    .map((secret) => ({
      secret,
      cells: columns.map((device) => ({
        deviceId: device.id,
        grant: byPair.get(`${secret.id}\0${device.id}`) ?? null,
      })),
    }));
  return { devices: columns, rows };
}

export function deviceName(device: HqVaultDeviceRecord): string {
  return device.label ?? device.hostname;
}

function secretName(
  id: string | undefined,
  secrets: ReadonlyMap<string, HqVaultSecretMeta>,
): string {
  if (id === undefined) return 'a key';
  const secret = secrets.get(id);
  return secret ? `${secret.label} (${secret.providerId})` : 'a deleted key';
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
  secrets: ReadonlyMap<string, HqVaultSecretMeta>,
  devices: ReadonlyMap<string, HqVaultDeviceRecord>,
): string {
  const key = secretName(entry.secretId, secrets);
  const device = deviceLabel(entry.deviceId, devices);
  switch (entry.kind) {
    case 'unseal':
      return 'Vault unsealed';
    case 'secret.create':
      return `Stored ${key}`;
    case 'secret.rotate':
      return `Replaced ${key} (version ${entry.version ?? '?'})`;
    case 'secret.delete':
      return `Deleted ${entry.providerId ? `a ${entry.providerId} key` : 'a key'}`;
    case 'device.enroll':
      return `${device} enrolled`;
    case 'device.approve':
      return `Approved ${device}`;
    case 'device.revoke':
      return `Revoked ${device}`;
    case 'grant.create':
      return `Gave ${key} to ${device}`;
    case 'grant.revoke':
      return `Took ${key} back from ${device}`;
    case 'enrollment.mint':
      return 'Created an enrollment code';
    case 'fetch': {
      const count = entry.secretIds?.length ?? 0;
      return `${device} fetched ${count} key${count === 1 ? '' : 's'}`;
    }
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

export interface SecretFormInput {
  providerId: string;
  label: string;
  apiKey: string;
}

/** The first problem with a new-key form, or null when it can be sent. */
export function secretFormError(input: SecretFormInput): string | null {
  if (!PROVIDER_ID_PATTERN.test(input.providerId.trim())) {
    return 'Provider id: letters, digits and . _ : - (for example openai or anthropic).';
  }
  if (input.label.trim() === '') return 'Name the key.';
  if (input.label.trim().length > 80) return 'Keep the name under 80 characters.';
  if (input.apiKey.trim() === '') return 'Paste the key.';
  return null;
}

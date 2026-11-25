/**
 * The HQ key vault's on-disk model and persistence: the shape of
 * `<dataDir>/hq-vault.json`, its atomic owner-only writer, and the append-only
 * audit log `<dataDir>/hq-vault-audit.jsonl`. `store.ts` owns the behaviour;
 * this module owns the bytes.
 *
 * Version 2 holds provider profiles (the `providers.<id>` shape a machine's
 * config uses), each with its keys; version 1 (one flat secret per key,
 * granted per key) is migrated on read.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { restrictDirPermissions, restrictFilePermissions } from '@wrongstack/core/security';
import { atomicWrite } from '@wrongstack/core/utils';
import {
  type HqSealedBox,
  type HqVaultCipherText,
  hqVaultDecrypt,
  hqVaultEncrypt,
} from './crypto.js';
import type {
  HqVaultDeviceRecord,
  HqVaultGrantRecord,
  HqVaultIdentity,
  HqVaultKeyMeta,
} from './protocol.js';

export const HQ_VAULT_FILE = 'hq-vault.json';
export const HQ_VAULT_AUDIT_FILE = 'hq-vault-audit.jsonl';

/**
 * Every secret member of a key, encrypted at rest. `refreshToken` and
 * `idToken` never leave HQ; the rest is sealed to devices.
 */
export interface HqVaultKeySecrets {
  apiKey: string;
  refreshToken?: string;
  idToken?: string;
  tokenType?: string;
  scope?: string;
  project?: string;
  oauthClientId?: string;
  oauthSubject?: string;
}

export interface HqVaultStoredKey extends HqVaultKeyMeta {
  dek: HqVaultCipherText;
  payload: HqVaultCipherText;
}

export interface HqVaultStoredProfile {
  id: string;
  type: string;
  family?: string;
  baseUrl?: string;
  envVars?: string[];
  models?: string[];
  activeKey?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  keys: HqVaultStoredKey[];
  /** Made from a device's upload: that device takes it back in place of its own provider. */
  origin?: { deviceId: string; uploadId: string };
}

/** A device's upload awaiting an operator, still sealed to HQ's identity key. */
export interface HqVaultStoredUpload {
  id: string;
  deviceId: string;
  nonce: string;
  receivedAt: string;
  expiresAt: string;
  sealed: HqSealedBox;
}

export interface HqVaultStoredIdentity {
  hqId: string;
  encPublic: string;
  signPublic: string;
  /** JSON `{ encPrivate, signPrivate }` under the master key. */
  privateKeys: HqVaultCipherText;
  createdAt: string;
}

export interface HqVaultFile {
  version: 2;
  identity?: HqVaultStoredIdentity;
  profiles: HqVaultStoredProfile[];
  devices: HqVaultDeviceRecord[];
  grants: HqVaultGrantRecord[];
  /** Grows with every operator change devices should hear about (see `HqVaultBundle.revision`). */
  revision?: number;
  uploads?: HqVaultStoredUpload[];
}

export type HqVaultState = 'sealed' | 'unsealed';

export interface HqVaultStatus {
  state: HqVaultState;
  /** True when the master key is passphrase-wrapped. */
  passphraseProtected: boolean;
  identity?: HqVaultIdentity;
  counts: {
    profiles: number;
    keys: number;
    devices: number;
    pendingDevices: number;
    grants: number;
    pendingUploads: number;
  };
}

export type HqVaultAuditKind =
  | 'unseal'
  | 'profile.create'
  | 'profile.update'
  | 'profile.delete'
  | 'key.set'
  | 'key.delete'
  | 'key.refresh'
  | 'oauth.signin'
  | 'device.enroll'
  | 'device.approve'
  | 'device.revoke'
  | 'grant.create'
  | 'grant.revoke'
  | 'enrollment.mint'
  | 'fetch'
  | 'upload.receive'
  | 'upload.approve'
  | 'upload.reject';

export interface HqVaultAuditEntry {
  at: string;
  kind: HqVaultAuditKind;
  actor: string;
  profileId?: string;
  keyLabel?: string;
  version?: number;
  deviceId?: string;
  profileIds?: string[];
  detail?: string;
}

export class HqVaultError extends Error {
  constructor(
    readonly code:
      | 'VAULT_SEALED'
      | 'VAULT_NOT_FOUND'
      | 'VAULT_INVALID'
      | 'VAULT_CONFLICT'
      | 'VAULT_DENIED',
    message: string,
    /** Extra members of the error answer (a device's signed revocation). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HqVaultError';
  }
}

export function emptyHqVaultFile(): HqVaultFile {
  return { version: 2, profiles: [], devices: [], grants: [] };
}

/** A trimmed, non-empty string of at most `max` characters, else undefined. */
export function hqVaultText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

/** The last characters of a value, for recognising it. Never more than 4. */
export function hqVaultHint(value: string): string {
  return value.length <= 8 ? '' : value.slice(-4);
}

function keyAad(kind: 'dek' | 'secret', id: string, version: number): string {
  return `${kind}|${id}|${version}`;
}

/**
 * Envelope-encrypt one key's secrets: a fresh data key encrypts them, the
 * master key wraps the data key. Both bind the key id and version, so a
 * ciphertext cannot be moved to another key or replayed as another version.
 */
export function encryptHqVaultSecrets(
  master: Buffer,
  id: string,
  version: number,
  secrets: HqVaultKeySecrets,
): { dek: HqVaultCipherText; payload: HqVaultCipherText } {
  const dek = randomBytes(32);
  return {
    dek: hqVaultEncrypt(master, dek, keyAad('dek', id, version)),
    payload: hqVaultEncrypt(
      dek,
      Buffer.from(JSON.stringify(secrets), 'utf8'),
      keyAad('secret', id, version),
    ),
  };
}

export function decryptHqVaultSecrets(
  master: Buffer,
  key: Pick<HqVaultStoredKey, 'id' | 'version' | 'dek' | 'payload'>,
): HqVaultKeySecrets {
  const dek = hqVaultDecrypt(master, key.dek, keyAad('dek', key.id, key.version));
  const raw = hqVaultDecrypt(dek, key.payload, keyAad('secret', key.id, key.version)).toString(
    'utf8',
  );
  // Version-1 payloads were the bare API key; version 2 is JSON.
  if (!raw.startsWith('{')) return { apiKey: raw };
  return JSON.parse(raw) as HqVaultKeySecrets;
}

interface V1Secret {
  id: string;
  providerId: string;
  label: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  dek: HqVaultCipherText;
  payload: HqVaultCipherText;
}

interface V1Grant {
  id: string;
  secretId: string;
  deviceId: string;
  createdAt: string;
}

/**
 * Version 1 → 2: one profile per distinct provider id holding its keys (the
 * ciphertexts move unchanged — they are bound to the key id and version,
 * which stay), and a key grant becomes a grant of the key's profile. Hints are
 * unknown without decrypting and stay empty until the key is next replaced.
 */
export function migrateHqVaultFileV1(v1: {
  identity?: HqVaultStoredIdentity;
  secrets?: V1Secret[];
  devices?: HqVaultDeviceRecord[];
  grants?: V1Grant[];
}): HqVaultFile {
  const profiles = new Map<string, HqVaultStoredProfile>();
  const profileOfSecret = new Map<string, string>();
  for (const secret of v1.secrets ?? []) {
    let profile = profiles.get(secret.providerId);
    if (!profile) {
      profile = {
        id: secret.providerId,
        type: secret.providerId,
        version: 1,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
        keys: [],
        activeKey: secret.label,
      };
      profiles.set(secret.providerId, profile);
    }
    profile.keys.push({
      id: secret.id,
      label: secret.label,
      authMethod: 'api_key',
      hint: '',
      version: secret.version,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
      dek: secret.dek,
      payload: secret.payload,
    });
    profileOfSecret.set(secret.id, secret.providerId);
  }
  const grants: HqVaultGrantRecord[] = [];
  const seen = new Set<string>();
  for (const grant of v1.grants ?? []) {
    const profileId = profileOfSecret.get(grant.secretId);
    if (!profileId || seen.has(`${profileId}\0${grant.deviceId}`)) continue;
    seen.add(`${profileId}\0${grant.deviceId}`);
    grants.push({ id: grant.id, profileId, deviceId: grant.deviceId, createdAt: grant.createdAt });
  }
  return {
    version: 2,
    ...(v1.identity ? { identity: v1.identity } : {}),
    profiles: [...profiles.values()],
    devices: v1.devices ?? [],
    grants,
  };
}

/** Reads and writes `hq-vault.json` and appends to the audit log. */
export class HqVaultFileIO {
  readonly filePath: string;
  private readonly auditPath: string;
  private hardened = false;

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, HQ_VAULT_FILE);
    this.auditPath = path.join(dataDir, HQ_VAULT_AUDIT_FILE);
  }

  /** The stored file, or `undefined` when the vault was never written. */
  async read(): Promise<HqVaultFile | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const stored = JSON.parse(raw) as { version?: unknown };
    if (stored.version === 1) {
      return migrateHqVaultFileV1(stored as Parameters<typeof migrateHqVaultFileV1>[0]);
    }
    const parsed = stored as Partial<HqVaultFile>;
    if (parsed.version !== 2) {
      throw new HqVaultError('VAULT_INVALID', `${HQ_VAULT_FILE} has an unsupported version.`);
    }
    return {
      version: 2,
      ...(parsed.identity ? { identity: parsed.identity } : {}),
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      grants: Array.isArray(parsed.grants) ? parsed.grants : [],
      ...(Number.isSafeInteger(parsed.revision) ? { revision: parsed.revision } : {}),
      ...(Array.isArray(parsed.uploads) ? { uploads: parsed.uploads } : {}),
    };
  }

  async write(file: HqVaultFile): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    if (!this.hardened) await restrictDirPermissions(this.dataDir, { label: 'hq-vault-dir' });
    await atomicWrite(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    if (!this.hardened) await restrictFilePermissions(this.filePath, { label: 'hq-vault' });
    // Once per process: on Windows each hardening call spawns icacls (about a
    // second), and every later write replaces the file inside the owner-only
    // directory, so it inherits that ACL; on POSIX `mode` covers it.
    this.hardened = true;
  }

  /** Best effort: an audit write failure must not fail the operation it records. */
  async audit(entry: HqVaultAuditEntry): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.appendFile(this.auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // Recorded nowhere else on purpose: the log never carries values anyway.
    }
  }

  /**
   * The newest `limit` audit entries, newest first. Reads only the file's tail
   * so a long-lived log never loads whole; unparseable lines are skipped.
   */
  async readAudit(limit: number): Promise<HqVaultAuditEntry[]> {
    const tailBytes = Math.min(4 * 1024 * 1024, Math.max(64 * 1024, limit * 512));
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.auditPath, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - tailBytes);
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift(); // a partial first line
      const out: HqVaultAuditEntry[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i]!.trim();
        if (line === '') continue;
        try {
          const entry = JSON.parse(line) as HqVaultAuditEntry;
          if (typeof entry.at === 'string' && typeof entry.kind === 'string') out.push(entry);
        } catch {
          // A torn write; skip it.
        }
      }
      return out;
    } finally {
      await handle.close();
    }
  }
}

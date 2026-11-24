/**
 * The HQ key vault's on-disk model and persistence: the shape of
 * `<dataDir>/hq-vault.json`, its atomic owner-only writer, and the append-only
 * audit log `<dataDir>/hq-vault-audit.jsonl`. `store.ts` owns the behaviour;
 * this module owns the bytes.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { restrictDirPermissions, restrictFilePermissions } from '@wrongstack/core/security';
import { atomicWrite } from '@wrongstack/core/utils';
import { type HqVaultCipherText, hqVaultDecrypt, hqVaultEncrypt } from './crypto.js';
import type {
  HqVaultDeviceRecord,
  HqVaultGrantRecord,
  HqVaultIdentity,
  HqVaultSecretMeta,
} from './protocol.js';

export const HQ_VAULT_FILE = 'hq-vault.json';
export const HQ_VAULT_AUDIT_FILE = 'hq-vault-audit.jsonl';

export interface HqVaultStoredSecret extends HqVaultSecretMeta {
  dek: HqVaultCipherText;
  payload: HqVaultCipherText;
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
  version: 1;
  identity?: HqVaultStoredIdentity;
  secrets: HqVaultStoredSecret[];
  devices: HqVaultDeviceRecord[];
  grants: HqVaultGrantRecord[];
}

export type HqVaultState = 'sealed' | 'unsealed';

export interface HqVaultStatus {
  state: HqVaultState;
  /** True when the master key is passphrase-wrapped. */
  passphraseProtected: boolean;
  identity?: HqVaultIdentity;
  counts: { secrets: number; devices: number; pendingDevices: number; grants: number };
}

export type HqVaultAuditKind =
  | 'unseal'
  | 'secret.create'
  | 'secret.rotate'
  | 'secret.delete'
  | 'device.enroll'
  | 'device.approve'
  | 'device.revoke'
  | 'grant.create'
  | 'grant.revoke'
  | 'enrollment.mint'
  | 'fetch';

export interface HqVaultAuditEntry {
  at: string;
  kind: HqVaultAuditKind;
  actor: string;
  secretId?: string;
  providerId?: string;
  version?: number;
  deviceId?: string;
  grantId?: string;
  secretIds?: string[];
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
  ) {
    super(message);
    this.name = 'HqVaultError';
  }
}

export function emptyHqVaultFile(): HqVaultFile {
  return { version: 1, secrets: [], devices: [], grants: [] };
}

/** A trimmed, non-empty string of at most `max` characters, else undefined. */
export function hqVaultText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

/**
 * Envelope-encrypt one secret value: a fresh data key encrypts the value, the
 * master key wraps the data key. Both bind the secret id and version, so a
 * ciphertext cannot be moved to another secret or replayed as another version.
 */
export function encryptHqVaultValue(
  master: Buffer,
  id: string,
  version: number,
  value: string,
): { dek: HqVaultCipherText; payload: HqVaultCipherText } {
  const dek = randomBytes(32);
  return {
    dek: hqVaultEncrypt(master, dek, `dek|${id}|${version}`),
    payload: hqVaultEncrypt(dek, Buffer.from(value, 'utf8'), `secret|${id}|${version}`),
  };
}

export function decryptHqVaultValue(master: Buffer, secret: HqVaultStoredSecret): string {
  const dek = hqVaultDecrypt(master, secret.dek, `dek|${secret.id}|${secret.version}`);
  return hqVaultDecrypt(dek, secret.payload, `secret|${secret.id}|${secret.version}`).toString(
    'utf8',
  );
}

/** Reads and writes `hq-vault.json` and appends to the audit log. */
export class HqVaultFileIO {
  readonly filePath: string;
  private readonly auditPath: string;

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
    const parsed = JSON.parse(raw) as Partial<HqVaultFile>;
    if (parsed.version !== 1) {
      throw new HqVaultError('VAULT_INVALID', `${HQ_VAULT_FILE} has an unsupported version.`);
    }
    return {
      version: 1,
      ...(parsed.identity ? { identity: parsed.identity } : {}),
      secrets: Array.isArray(parsed.secrets) ? parsed.secrets : [],
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      grants: Array.isArray(parsed.grants) ? parsed.grants : [],
    };
  }

  async write(file: HqVaultFile): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await restrictDirPermissions(this.dataDir, { label: 'hq-vault-dir' });
    await atomicWrite(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await restrictFilePermissions(this.filePath, { label: 'hq-vault' });
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

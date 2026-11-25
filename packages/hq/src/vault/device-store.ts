/**
 * This machine's HQ key-vault identity: `<WRONGSTACK_HOME>/hq-device.json`.
 *
 * Holds the device's X25519 + Ed25519 key pairs, the HQ it enrolled with and
 * that HQ's pinned public identity. The private keys are encrypted with the
 * local SecretVault (`~/.wrongstack/.key`, optionally passphrase-wrapped) —
 * their field names do not match the config secret walker, so they are
 * encrypted here explicitly. The file is owner-only and is protected agent
 * state (`agent-state-sensitivity.ts`): the agent's own file tools cannot read
 * it.
 *
 * One device identity per machine (global root), shared by every profile: a
 * device is a machine HQ trusts, not an account.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretVault } from '@wrongstack/contracts/types/secret-vault';
import { restrictFilePermissions } from '@wrongstack/core/security';
import { atomicWrite } from '@wrongstack/core/utils';
import {
  type HqVaultKeyPair,
  hqVaultFingerprint,
  hqVaultKeyId,
  isHqVaultKeyString,
} from './crypto.js';
import type { HqVaultDeviceStatus, HqVaultIdentity } from './protocol.js';

const HQ_DEVICE_FILE = 'hq-device.json';

/** A provider this machine uploaded to HQ, waiting for an operator (`device-upload.ts`). */
export interface HqPendingUpload {
  uploadId: string;
  /** The provider's id in this machine's config. */
  localId: string;
  /** SHA-256 of each uploaded key value, to recognise those keys when HQ's copies arrive. */
  keyHashes: string[];
  uploadedAt: string;
  /** HQ drops an upload nobody approved by then; so does this machine. */
  expiresAt: string;
}

function isPendingUpload(value: unknown): value is HqPendingUpload {
  const u = value as HqPendingUpload | null;
  return (
    typeof u?.uploadId === 'string' &&
    typeof u.localId === 'string' &&
    Array.isArray(u.keyHashes) &&
    u.keyHashes.every((h) => typeof h === 'string') &&
    typeof u.uploadedAt === 'string' &&
    typeof u.expiresAt === 'string'
  );
}

export interface HqDeviceRecord {
  /** The HQ origin the device talks to, e.g. `https://hq.example.com:3499`. */
  hqUrl: string;
  /** HQ's identity, pinned at enrollment; every bundle must verify against it. */
  hq: HqVaultIdentity;
  deviceId: string;
  /** Status HQ last reported (enrollment answer); `approved` once fetches succeed. */
  status: HqVaultDeviceStatus;
  enrolledAt: string;
  keys: HqVaultKeyPair;
  /** HQ's change counter at the last successful sync (see `HqVaultBundle.revision`). */
  syncedRevision?: number;
  /** When HQ's signed revocation arrived (status is then `revoked`). */
  revokedAt?: string;
  /** HQ profiles this machine holds as memory-only leases (each process fetches them at start). */
  leaseProfileIds?: string[];
  pendingUploads?: HqPendingUpload[];
}

interface HqDeviceFile {
  version: 1;
  hqUrl: string;
  hq: HqVaultIdentity;
  deviceId: string;
  status: HqVaultDeviceStatus;
  enrolledAt: string;
  encPublic: string;
  signPublic: string;
  /** SecretVault ciphertext (`enc:v<N>:…`). */
  encPrivateSealed: string;
  signPrivateSealed: string;
  syncedRevision?: number;
  revokedAt?: string;
  leaseProfileIds?: string[];
  pendingUploads?: HqPendingUpload[];
}

export function hqDeviceFilePath(globalRoot: string): string {
  return path.join(globalRoot, HQ_DEVICE_FILE);
}

export async function readHqDevice(
  globalRoot: string,
  vault: SecretVault,
): Promise<HqDeviceRecord | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(hqDeviceFilePath(globalRoot), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const file = JSON.parse(raw) as Partial<HqDeviceFile>;
  if (
    file.version !== 1 ||
    typeof file.hqUrl !== 'string' ||
    !file.hq ||
    !isHqVaultKeyString(file.encPublic) ||
    !isHqVaultKeyString(file.signPublic) ||
    typeof file.encPrivateSealed !== 'string' ||
    typeof file.signPrivateSealed !== 'string'
  ) {
    throw new Error(`${HQ_DEVICE_FILE} is damaged; run \`wstack hq unenroll\` and enroll again.`);
  }
  const keys: HqVaultKeyPair = {
    encPublic: file.encPublic,
    signPublic: file.signPublic,
    encPrivate: vault.decrypt(file.encPrivateSealed),
    signPrivate: vault.decrypt(file.signPrivateSealed),
  };
  if (!isHqVaultKeyString(keys.encPrivate) || !isHqVaultKeyString(keys.signPrivate)) {
    throw new Error(
      `${HQ_DEVICE_FILE} private keys did not decrypt — the local vault key (~/.wrongstack/.key) changed. Enroll again.`,
    );
  }
  if (hqVaultKeyId(keys) !== file.deviceId) {
    throw new Error(`${HQ_DEVICE_FILE} keys do not match its device id; enroll again.`);
  }
  return {
    hqUrl: file.hqUrl,
    hq: file.hq,
    deviceId: file.deviceId ?? hqVaultKeyId(keys),
    status: file.status ?? 'pending',
    enrolledAt: file.enrolledAt ?? '',
    keys,
    ...(Number.isSafeInteger(file.syncedRevision) ? { syncedRevision: file.syncedRevision } : {}),
    ...(typeof file.revokedAt === 'string' ? { revokedAt: file.revokedAt } : {}),
    ...(Array.isArray(file.leaseProfileIds)
      ? { leaseProfileIds: file.leaseProfileIds.filter((id) => typeof id === 'string') }
      : {}),
    ...(Array.isArray(file.pendingUploads)
      ? { pendingUploads: file.pendingUploads.filter(isPendingUpload) }
      : {}),
  };
}

export async function writeHqDevice(
  globalRoot: string,
  vault: SecretVault,
  record: HqDeviceRecord,
): Promise<void> {
  const file: HqDeviceFile = {
    version: 1,
    hqUrl: record.hqUrl,
    hq: record.hq,
    deviceId: record.deviceId,
    status: record.status,
    enrolledAt: record.enrolledAt,
    encPublic: record.keys.encPublic,
    signPublic: record.keys.signPublic,
    encPrivateSealed: vault.encrypt(record.keys.encPrivate),
    signPrivateSealed: vault.encrypt(record.keys.signPrivate),
    ...(record.syncedRevision !== undefined ? { syncedRevision: record.syncedRevision } : {}),
    ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
    ...(record.leaseProfileIds?.length ? { leaseProfileIds: record.leaseProfileIds } : {}),
    ...(record.pendingUploads?.length ? { pendingUploads: record.pendingUploads } : {}),
  };
  await fs.mkdir(globalRoot, { recursive: true });
  const target = hqDeviceFilePath(globalRoot);
  await atomicWrite(target, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await restrictFilePermissions(target, { label: 'hq-device' });
  await vault.flushHardening?.();
}

export async function removeHqDevice(globalRoot: string): Promise<boolean> {
  try {
    await fs.rm(hqDeviceFilePath(globalRoot));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** The device's own fingerprint, to compare with the one HQ shows. */
export function hqDeviceFingerprint(record: HqDeviceRecord): string {
  return hqVaultFingerprint(record.keys);
}

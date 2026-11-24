/**
 * The HQ key vault's master key: the key-encryption key every stored secret's
 * data key is wrapped under.
 *
 * File `<dataDir>/hq-vault-master.key`, owner-only. Two formats:
 *   raw     'WHVK' | version(1) | key(32)                              = 37 bytes
 *   wrapped 'WHVW' | version(1) | log2N(1) | salt(16) | iv(12) | tag(16) | ct(32) = 82 bytes
 *
 * Wrapped is used when `WRONGSTACK_HQ_VAULT_PASSPHRASE` is set at creation: the
 * key is encrypted under an scrypt-derived key, so a copy of the HQ data
 * directory (a backup, a stolen disk) does not open the vault. Without the
 * passphrase at start-up the vault stays SEALED until an operator unseals it.
 *
 * The scrypt cost travels in the file (one byte, log2 N) rather than as a
 * module constant, so raising it later does not lock existing vaults out —
 * the lesson of `hq-password-kdf-is-versioned`. The parsed value is bounded:
 * the file is not a trustworthy source for an allocation size.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { restrictDirPermissions, restrictFilePermissions } from '@wrongstack/core/security';
import { atomicWrite } from '@wrongstack/core/utils';
import { HqVaultCryptoError, hqVaultDecrypt, hqVaultEncrypt } from './crypto.js';
import { HqVaultError } from './store-model.js';

export const HQ_VAULT_MASTER_KEY_FILE = 'hq-vault-master.key';
export const HQ_VAULT_PASSPHRASE_ENV = 'WRONGSTACK_HQ_VAULT_PASSPHRASE';

const RAW_MAGIC = Buffer.from('WHVK', 'ascii');
const WRAP_MAGIC = Buffer.from('WHVW', 'ascii');
const FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const RAW_SIZE = 4 + 1 + KEY_BYTES;
const WRAP_HEADER = 4 + 1 + 1 + SALT_BYTES;
const DEFAULT_LOG2_N = 16;
const MIN_LOG2_N = 14;
const MAX_LOG2_N = 20;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export type HqVaultMasterKeyState =
  | { state: 'unsealed'; key: Buffer; wrapped: boolean }
  | { state: 'sealed' };

export function hqVaultMasterKeyPath(dataDir: string): string {
  return path.join(dataDir, HQ_VAULT_MASTER_KEY_FILE);
}

/** The passphrase from the environment; empty means unset. */
export function hqVaultPassphraseFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[HQ_VAULT_PASSPHRASE_ENV];
  return value && value.length > 0 ? value : undefined;
}

function deriveWrapKey(passphrase: string, salt: Buffer, log2N: number): Buffer {
  const N = 2 ** log2N;
  return scryptSync(passphrase, salt, KEY_BYTES, {
    N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * N * SCRYPT_R * 2,
  });
}

function wrapAad(log2N: number): string {
  return `wstack-hq-vault/v1/master|${FORMAT_VERSION}|${log2N}`;
}

/** Serialize `key` under `passphrase`, or raw when no passphrase. */
export function encodeHqVaultMasterKey(
  key: Buffer,
  passphrase: string | undefined,
  log2N = DEFAULT_LOG2_N,
): Buffer {
  if (key.length !== KEY_BYTES) throw new HqVaultCryptoError('master key must be 32 bytes');
  if (passphrase === undefined) {
    return Buffer.concat([RAW_MAGIC, Buffer.from([FORMAT_VERSION]), key]);
  }
  const salt = randomBytes(SALT_BYTES);
  const box = hqVaultEncrypt(deriveWrapKey(passphrase, salt, log2N), key, wrapAad(log2N));
  return Buffer.concat([
    WRAP_MAGIC,
    Buffer.from([FORMAT_VERSION, log2N]),
    salt,
    Buffer.from(box.iv, 'base64url'),
    Buffer.from(box.tag, 'base64url'),
    Buffer.from(box.ct, 'base64url'),
  ]);
}

/** True when the file content is the passphrase-wrapped format. */
export function isWrappedHqVaultMasterKey(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(WRAP_MAGIC);
}

/**
 * Decode a master key file. A wrapped file needs `passphrase`; without one it
 * reports `sealed`. A wrong passphrase or a damaged file throws.
 */
export function decodeHqVaultMasterKey(
  buf: Buffer,
  passphrase: string | undefined,
): HqVaultMasterKeyState {
  if (buf.length === RAW_SIZE && buf.subarray(0, 4).equals(RAW_MAGIC)) {
    if (buf[4] !== FORMAT_VERSION) throw new HqVaultCryptoError('unsupported master key version');
    return { state: 'unsealed', key: Buffer.from(buf.subarray(5)), wrapped: false };
  }
  if (!isWrappedHqVaultMasterKey(buf) || buf.length !== WRAP_HEADER + 12 + 16 + KEY_BYTES) {
    throw new HqVaultCryptoError('master key file is not a recognised format');
  }
  if (buf[4] !== FORMAT_VERSION) throw new HqVaultCryptoError('unsupported master key version');
  const log2N = buf[5]!;
  if (log2N < MIN_LOG2_N || log2N > MAX_LOG2_N) {
    throw new HqVaultCryptoError('master key file carries an out-of-range scrypt cost');
  }
  if (passphrase === undefined) return { state: 'sealed' };
  const salt = buf.subarray(6, 6 + SALT_BYTES);
  let off = WRAP_HEADER;
  const iv = buf.subarray(off, off + 12);
  off += 12;
  const tag = buf.subarray(off, off + 16);
  off += 16;
  const ct = buf.subarray(off, off + KEY_BYTES);
  try {
    const key = hqVaultDecrypt(
      deriveWrapKey(passphrase, salt, log2N),
      {
        iv: iv.toString('base64url'),
        tag: tag.toString('base64url'),
        ct: ct.toString('base64url'),
      },
      wrapAad(log2N),
    );
    return { state: 'unsealed', key, wrapped: true };
  } catch {
    throw new HqVaultCryptoError('wrong vault passphrase');
  }
}

async function writeMasterKeyFile(dataDir: string, content: Buffer): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await restrictDirPermissions(dataDir, { label: 'hq-vault-dir' });
  const target = hqVaultMasterKeyPath(dataDir);
  await atomicWrite(target, content, { mode: 0o600 });
  await restrictFilePermissions(target, { label: 'hq-vault-master' });
}

/**
 * Load the master key, creating it on first use. A new key is wrapped when a
 * passphrase is supplied. An existing raw key is returned even when a
 * passphrase is set — wrapping an existing key is an explicit operation, not a
 * side effect of setting an environment variable.
 */
export async function loadOrCreateHqVaultMasterKey(
  dataDir: string,
  passphrase: string | undefined,
  options: { create?: boolean } = {},
): Promise<HqVaultMasterKeyState> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(hqVaultMasterKeyPath(dataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // The caller already holds data encrypted under a key: a fresh key could
    // never open it, so report the loss instead of papering over it.
    if (options.create === false) {
      throw new HqVaultError(
        'VAULT_INVALID',
        'hq-vault-master.key is missing but hq-vault.json exists; restore the key file from the same backup.',
      );
    }
    const key = randomBytes(KEY_BYTES);
    await writeMasterKeyFile(dataDir, encodeHqVaultMasterKey(key, passphrase));
    return { state: 'unsealed', key, wrapped: passphrase !== undefined };
  }
  return decodeHqVaultMasterKey(buf, passphrase);
}

/** Re-wrap the existing master key under a new passphrase (or none). */
export async function rewrapHqVaultMasterKey(
  dataDir: string,
  key: Buffer,
  passphrase: string | undefined,
): Promise<void> {
  await writeMasterKeyFile(dataDir, encodeHqVaultMasterKey(key, passphrase));
}

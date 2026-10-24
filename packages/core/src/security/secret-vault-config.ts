import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { RotatableSecretVault, SecretVault } from '@wrongstack/contracts/types/secret-vault';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { deepMerge } from '../utils/deep-merge.js';
import { encryptConfigSecrets, isSecretField } from './config-secrets.js';
import { restrictFilePermissions as restrictPermissions } from './file-permissions.js';

// Profile-file operations depend only on the vault interface. Keep key-file
// creation and AES-GCM in secret-vault.ts; this module never imports that class.

/**
 * Re-write a profile config (or any path) with all secret-bearing
 * fields encrypted. Used by the `wstack auth` subcommand.
 */
export async function rewriteConfigEncrypted(
  configPath: string,
  vault: SecretVault,
  patch?: Record<string, unknown>,
): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const raw = await fsp.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Existing config must be a JSON object');
    }
    current = parsed as Record<string, unknown>;
  } catch (error) {
    // A genuinely missing config starts empty. Read failures and malformed
    // JSON must remain visible: treating either as empty would replace the
    // operator's existing config with only the credential patch below.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const merged = deepMerge(current, patch ?? {});
  const encrypted = encryptConfigSecrets(merged, vault);
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  // atomicWrite: torn write here would erase every saved encrypted API key.
  await atomicWrite(configPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  await restrictFilePermissions(configPath);
  // Flush any pending key-file hardening so a short-lived CLI caller does
  // not process.exit() before icacls completes (WS-088 / TOCTOU fix).
  await vault.flushHardening?.();
}

/**
 * Scan a config file on disk for plaintext secret-bearing fields and
 * rewrite the file with them encrypted in place. Returns a count of how
 * many fields were migrated. Idempotent — calling on a fully-encrypted
 * file is a no-op and writes nothing. Used by the CLI on every boot so
 * users who had plaintext keys before the vault landed are upgraded
 * transparently.
 */
export async function migratePlaintextSecrets(
  configPath: string,
  vault: SecretVault,
  logger?: Pick<Logger, 'warn'>,
): Promise<{ migrated: number; file: string }> {
  let raw: string;
  try {
    raw = await fsp.readFile(configPath, 'utf8');
  } catch {
    return { migrated: 0, file: configPath };
  }
  let parsed: unknown;
  try {
    // A UTF-8 BOM (as the loader accepts) was skipped here, keeping its keys in plaintext.
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return { migrated: 0, file: configPath };
  }
  const probe = { n: 0 };
  walkCount(parsed, vault, probe);
  if (probe.n === 0) return { migrated: 0, file: configPath };
  // Work to do: redo read → encrypt → write under the config lock every other
  // config writer holds, or a locked update landing in between is overwritten.
  // (Only now: an unconditional lock would create a missing config's dir.)
  const counter = { n: 0 };
  await withFileLock(configPath, async () => {
    const fresh = (await fsp.readFile(configPath, 'utf8')).replace(/^﻿/, '');
    const migrated = walkCount(JSON.parse(fresh), vault, counter);
    if (counter.n === 0) return;
    // atomicWrite: runs on every boot for legacy users — torn write = wipe.
    await atomicWrite(configPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
  });
  if (counter.n === 0) return { migrated: 0, file: configPath };
  await restrictFilePermissions(
    configPath,
    logger ? { warn: (msg) => logger.warn(msg) } : undefined,
  );
  await vault.flushHardening?.();
  return { migrated: counter.n, file: configPath };
}

/**
 * Rotate the vault's encryption key and re-encrypt all secret-bearing
 * fields in a config file. This is the atomic key rotation operation:
 *
 * 1. Read the config file
 * 2. Decrypt all encrypted values with the old key
 * 3. Generate a new key (vault.rotateKey())
 * 4. Re-encrypt all values with the new key (new version prefix)
 * 5. Write the config file atomically
 *
 * Returns the number of fields re-encrypted and the version transition.
 * If the config file doesn't exist or has no encrypted fields, returns
 * { rotated: 0 } without modifying the key.
 */
export async function rotateConfigKeys(
  configPath: string,
  vault: RotatableSecretVault,
  logger?: Pick<Logger, 'warn' | 'info'>,
): Promise<{ rotated: number; oldVersion: number; newVersion: number; file: string }> {
  const log = logger?.info ?? (() => {});
  const warn = logger?.warn ?? ((msg: string) => console.warn(msg));

  // Read the config file
  let raw: string;
  try {
    raw = await fsp.readFile(configPath, 'utf8');
  } catch {
    // No config file — just rotate the key without re-encrypting anything
    const { oldVersion, newVersion } = vault.rotateKey();
    log(
      `[secret-vault] Key rotated (v${oldVersion} → v${newVersion}) — no config file to re-encrypt`,
    );
    await vault.flushHardening?.();
    return { rotated: 0, oldVersion, newVersion, file: configPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`[secret-vault] Config file ${configPath} is not valid JSON — skipping rotation`);
    return {
      rotated: 0,
      oldVersion: vault.keyVersion,
      newVersion: vault.keyVersion,
      file: configPath,
    };
  }

  // Count encrypted fields and decrypt them
  const counter = { n: 0, failed: [] as string[], decryptedPaths: new Set<string>() };
  const decrypted = walkDecryptCount(parsed, vault, counter);

  // Abort BEFORE rotating if any encrypted field could not be decrypted with
  // the current key. Rotation would discard the old key while these fields
  // still hold old-key ciphertext, and walkReencrypt skips already-encrypted
  // values — so they would become permanently undecryptable. Surface the
  // corruption and leave the key intact for the operator to investigate.
  if (counter.failed.length > 0) {
    throw new Error(
      `[secret-vault] Aborting key rotation: ${counter.failed.length} field(s) could not be decrypted ` +
        `with the current key and would be permanently lost on rotation: ${counter.failed.join(', ')}. ` +
        `Restore or remove these fields before rotating.`,
    );
  }

  if (counter.n === 0) {
    // No encrypted fields — just rotate the key
    const { oldVersion, newVersion } = vault.rotateKey();
    log(
      `[secret-vault] Key rotated (v${oldVersion} → v${newVersion}) — no encrypted fields to re-encrypt`,
    );
    await vault.flushHardening?.();
    return { rotated: 0, oldVersion, newVersion, file: configPath };
  }

  // Rotate the key (generates new key, increments version)
  const { oldVersion, newVersion } = vault.rotateKey();

  // Re-encrypt all secret fields with the new key
  const reencrypted = walkReencrypt(decrypted, vault, counter.decryptedPaths);

  // Write the config file atomically
  await atomicWrite(configPath, JSON.stringify(reencrypted, null, 2), { mode: 0o600 });
  await restrictFilePermissions(configPath, { warn });

  log(
    `[secret-vault] Key rotated (v${oldVersion} → v${newVersion}) — re-encrypted ${counter.n} field(s)`,
  );
  await vault.flushHardening?.();
  return { rotated: counter.n, oldVersion, newVersion, file: configPath };
}

/**
 * Walk a config object, decrypt all encrypted values, and count them.
 * Returns a new object with decrypted values.
 *
 * `counter.failed` collects the key paths of any field that is encrypted but
 * could NOT be decrypted with the current key. These are left as-is (old
 * ciphertext). The caller MUST treat a non-empty `failed` list as a hard stop
 * before rotating: rotation discards the old key, and `walkReencrypt` skips
 * already-encrypted values, so a retained old-key ciphertext would become
 * permanently undecryptable. Surfacing it is strictly safer than entombing it.
 */
function walkDecryptCount<T>(
  node: T,
  vault: SecretVault,
  counter: { n: number; failed: string[]; decryptedPaths: Set<string> },
  pathPrefix = '',
): T {
  if (node === null || node === undefined) return node;
  // String nodes are not objects. An encrypted string nested in an array
  // used to return here unchanged, then survive rotation under the old key.
  if (typeof node === 'string') {
    if (!vault.isEncrypted(node)) return node;
    try {
      const plain = vault.decrypt(node) as T;
      counter.n++;
      counter.decryptedPaths.add(pathPrefix);
      return plain;
    } catch {
      counter.failed.push(pathPrefix.length > 0 ? pathPrefix : '(root)');
      return node;
    }
  }
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item, i) =>
      walkDecryptCount(item, vault, counter, `${pathPrefix}[${i}]`),
    ) as never as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const keyPath = pathPrefix ? `${pathPrefix}.${k}` : k;
    if (typeof v === 'string' || (typeof v === 'object' && v !== null)) {
      out[k] = walkDecryptCount(v, vault, counter, keyPath);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** Last object-key segment of a walk path. Indexed array slots have no field name. */
function secretFieldNameAt(pathPrefix: string): string | undefined {
  if (pathPrefix.length === 0 || pathPrefix.endsWith(']')) return undefined;
  const parts = pathPrefix.split('.');
  return parts[parts.length - 1];
}

/**
 * Re-encrypt every string walkDecryptCount decrypted, including values whose
 * field name is not a secret key and encrypted strings that lived in arrays.
 * Also encrypt a still-plaintext secret field, which is the previous behavior.
 */
function walkReencrypt<T>(
  node: T,
  vault: SecretVault,
  decryptedPaths: ReadonlySet<string>,
  pathPrefix = '',
): T {
  if (node === null || node === undefined) return node;
  if (typeof node === 'string') {
    if (vault.isEncrypted(node)) return node;
    const fieldName = secretFieldNameAt(pathPrefix);
    const plaintextSecret = node.length > 0 && fieldName !== undefined && isSecretField(fieldName);
    if (decryptedPaths.has(pathPrefix) || plaintextSecret) {
      return vault.encrypt(node) as T;
    }
    return node;
  }
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item, i) =>
      walkReencrypt(item, vault, decryptedPaths, `${pathPrefix}[${i}]`),
    ) as never as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const keyPath = pathPrefix ? `${pathPrefix}.${k}` : k;
    if (typeof v === 'string' || (typeof v === 'object' && v !== null)) {
      out[k] = walkReencrypt(v, vault, decryptedPaths, keyPath);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * WS-045: the implementation moved to `security/file-permissions.ts` so the HQ
 * auth store and runtime file — which hold bearer tokens — can reach the same
 * Windows-aware hardening instead of a chmod that Windows ignores. This thin
 * wrapper keeps the `[secret-vault]` prefix on warnings operators already grep.
 */
async function restrictFilePermissions(
  filePath: string,
  opts?: { warn?: (msg: string) => void },
): Promise<void> {
  await restrictPermissions(filePath, { label: 'secret-vault', warn: opts?.warn });
}

function walkCount<T>(node: T, vault: SecretVault, counter: { n: number }): T {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item) => walkCount(item, vault, counter)) as never as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string' && isSecretField(k) && !vault.isEncrypted(v) && v.length > 0) {
      out[k] = vault.encrypt(v);
      counter.n++;
    } else if (typeof v === 'object' && v !== null) {
      out[k] = walkCount(v, vault, counter);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

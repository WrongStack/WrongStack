import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import * as fs from 'node:fs';
import { ConfigError, ERROR_CODES } from '@wrongstack/contracts/types/errors';

export const KEY_BYTES = 32;

export const IV_BYTES = 12;

export const TAG_BYTES = 16;

export const ALGO = 'aes-256-gcm';

// Desired file mode for the key file on POSIX systems.
export const KEY_FILE_MODE = 0o600;
// 37 bytes

// ── WS-03: opt-in passphrase-wrapped key file (KEK) ─────────────────────────
//
// When WRONGSTACK_VAULT_PASSPHRASE is set, the data key is NOT stored in the
// clear. Instead the key file holds the data key encrypted (AES-256-GCM) under
// a key-encryption-key (KEK) derived from the passphrase with scrypt. This adds
// at-rest protection beyond the file's 0o600 perms: an attacker who copies
// ~/.wrongstack/.key + config.json off the disk still cannot decrypt without the
// passphrase. When the env var is unset, behavior is byte-for-byte identical to
// before (legacy raw / versioned formats) — this is purely additive and opt-in.
//
// Wrapped format v3: magic 'WSKW' (4) + keyVersion (1) + salt (16) + iv (12) +
//                    tag (16) + ciphertext (32) = 81 bytes.
export const KEK_MAGIC = Buffer.from('WSKW', 'ascii');

export const KEK_SALT_BYTES = 16;

export const WRAPPED_KEY_FILE_SIZE =
  KEK_MAGIC.length + 1 + KEK_SALT_BYTES + IV_BYTES + TAG_BYTES + KEY_BYTES;
// 81 bytes
// scrypt cost parameters. N=2^15 keeps derivation ~50-100ms — strong against
// offline brute force while imperceptible for a one-time-per-process unlock.
export const SCRYPT_N = 1 << 15;

export const SCRYPT_R = 8;

export const SCRYPT_P = 1;

export const SCRYPT_MAXMEM = 64 * 1024 * 1024;
// headroom above N*r*128 so derivation never throws

/** Read the optional vault passphrase from the environment. Empty = unset. */
export function getVaultPassphrase(): string | undefined {
  const v = process.env['WRONGSTACK_VAULT_PASSPHRASE'];
  return v && v.length > 0 ? v : undefined;
}

/** True if `buf` is a passphrase-wrapped (v3) key file. */
export function isWrappedKeyFile(buf: Buffer): boolean {
  return (
    buf.length === WRAPPED_KEY_FILE_SIZE && buf.subarray(0, KEK_MAGIC.length).equals(KEK_MAGIC)
  );
}

/** Derive the 32-byte KEK from a passphrase + salt via scrypt. */
export function deriveKEK(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** Serialize a data key into the wrapped (v3) on-disk format under `passphrase`. */
export function wrapDataKey(dataKey: Buffer, keyVersion: number, passphrase: string): Buffer {
  const salt = randomBytes(KEK_SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const kek = deriveKEK(passphrase, salt);
  const cipher = createCipheriv(ALGO, kek, iv);
  const ct = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.alloc(WRAPPED_KEY_FILE_SIZE);
  let off = 0;
  KEK_MAGIC.copy(out, off);
  off += KEK_MAGIC.length;
  out[off] = keyVersion & 0xff;
  off += 1;
  salt.copy(out, off);
  off += KEK_SALT_BYTES;
  iv.copy(out, off);
  off += IV_BYTES;
  tag.copy(out, off);
  off += TAG_BYTES;
  ct.copy(out, off);
  return out;
}

/**
 * Parse a wrapped (v3) key file and return the data key + version. Throws a
 * clear ConfigError when the passphrase is missing or wrong (GCM auth failure).
 */
export function unwrapDataKey(buf: Buffer, keyFile: string): { key: Buffer; version: number } {
  const passphrase = getVaultPassphrase();
  if (!passphrase) {
    throw new ConfigError({
      message:
        `SecretVault: key file ${keyFile} is passphrase-protected — set the ` +
        `WRONGSTACK_VAULT_PASSPHRASE environment variable to unlock it.`,
      code: ERROR_CODES.CONFIG_INVALID,
      context: { keyFile },
    });
  }
  let off = KEK_MAGIC.length;
  const version = buf[off]!;
  off += 1;
  const salt = buf.subarray(off, off + KEK_SALT_BYTES);
  off += KEK_SALT_BYTES;
  const iv = buf.subarray(off, off + IV_BYTES);
  off += IV_BYTES;
  const tag = buf.subarray(off, off + TAG_BYTES);
  off += TAG_BYTES;
  const ct = buf.subarray(off, off + KEY_BYTES);
  const kek = deriveKEK(passphrase, salt);
  const decipher = createDecipheriv(ALGO, kek, iv);
  decipher.setAuthTag(tag);
  try {
    const key = Buffer.concat([decipher.update(ct), decipher.final()]);
    return { key: Buffer.from(key), version };
  } catch {
    throw new ConfigError({
      message:
        `SecretVault: failed to unlock key file ${keyFile} — wrong ` +
        `WRONGSTACK_VAULT_PASSPHRASE (key unwrap authentication failed).`,
      code: ERROR_CODES.CONFIG_INVALID,
      context: { keyFile },
    });
  }
}

/**
 * Check and warn if the key file has incorrect permissions on POSIX.
 * On Windows the mode bits are irrelevant — what matters is the inherited
 * ACL, which `restrictFilePermissions` re-applies via `icacls` regardless
 * of what mode bits say. The previous "no-op on Windows" returned `false`
 * and so never re-hardened pre-existing keys, leaving every `~/.wrongstack/.key`
 * and `profiles/default/config.json` readable by other local accounts
 * (`CodexSandboxUsers` etc.) — the H-7 condition. We now always schedule
 * a hardening pass; `restrictFilePermissions` is idempotent (it
 * re-applies the owning-user-only ACL on every call, and a no-op for
 * the user is acceptable boot-time cost).
 */
export function keyFileNeedsHardening(
  keyFile: string,
  opts?: { warn?: (msg: string) => void } | undefined,
): boolean {
  const warn = opts?.warn ?? ((msg: string) => console.warn(msg));
  if (process.platform === 'win32') {
    // Always re-apply the owning-user-only ACL on Windows. The previous
    // early-return made every pre-existing key file un-hardened forever.
    return true;
  }
  try {
    const stat = fs.statSync(keyFile);
    const actualMode = stat.mode & 0o777;
    if (actualMode !== KEY_FILE_MODE) {
      warn(
        `Key file ${keyFile} has mode ${actualMode.toString(8)} — expected ${KEY_FILE_MODE.toString(8)}. Hardening…`,
      );
      return true;
    }
  } catch {
    // stat can fail for reasons other than the file not existing;
    // if it does, the ENOENT path handles it.
  }
  return false;
}

/**
 * Crash-atomic synchronous key-file write: temp (0o600) + fsync + rename.
 *
 * A plain writeFileSync torn by a crash would leave a corrupt key file — and a
 * corrupt key file means every secret in the vault is unrecoverable. Sync
 * because the vault's rotate/migrate paths are synchronous; these run rarely
 * (rotation, at-rest upgrade), never on a hot path.
 *
 * The `0o600` on `openSync` below is the whole ACL story on POSIX, but on
 * Windows `chmod`-style modes only move the read-only bit: the renamed file
 * picks up the parent directory's inherited ACEs and stays readable by every
 * other account on the machine. `restrictFilePermissions` exists precisely for
 * that — its own module docstring names the vault `.key` as a motivating case.
 *
 * Hardening is NOT fired here — the caller must call `scheduleKeyHardening()`
 * after the rename so the hardening promise is tracked and flushable via
 * `flushHardening()`. This avoids both the detached-promise silent-loss-on-exit
 * problem and the TOCTOU gap where the key file sits with inherited ACLs until
 * the event loop ticks.
 */
/**
 * Create the directory holding the vault key file, owner-only.
 *
 * `mkdirSync(..., { recursive: true })` applies the default mode, so on POSIX
 * the directory holding the key-encryption key landed at `0755` — world-
 * readable. The key FILE is created `0o600`, so the key itself was never
 * exposed, but a readable parent directory lets another local account enumerate
 * it and, worse, means any file written there by a path that does not set its
 * own mode inherits a permissive default. `restrictDirPermissions` was written
 * for exactly this and had no production call site (audit 2026-08-20).
 *
 * Sync because both callers sit on the vault's synchronous key-load path.
 * Best-effort: a failure here must never stop the agent from booting.
 */
export function mkdirSecretDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  try {
    // `mode` on mkdir is masked by the process umask, so set it explicitly.
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort — an unwritable mode is not a reason to fail boot.
  }
}

export function writeKeyFileAtomicSync(keyFile: string, content: Buffer): void {
  const tmp = `${keyFile}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, content);
    try {
      fs.fsyncSync(fd);
    } catch {
      // Best-effort fsync — matches the async atomicWrite primitive.
    }
  } finally {
    fs.closeSync(fd);
  }
  try {
    renameWithRetrySync(tmp, keyFile);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * `renameSync` over an existing destination, retried briefly on Windows.
 *
 * Every key write schedules an async `icacls` hardening pass on the key file
 * (see `scheduleKeyHardening`). Back-to-back writes — a rotation loop is the
 * reproducer — can fire the next rename while the previous `icacls` still holds
 * a handle on the destination, and Windows reports that sharing violation as
 * `EPERM`. Antivirus and the search indexer open the file the same way. The
 * holder is always short-lived, so a bounded busy-wait is the right shape: a
 * handful of sub-millisecond retries, then surface the original error.
 *
 * POSIX renames are atomic against open handles, so this is a no-op there.
 */
export function renameWithRetrySync(tmp: string, dest: string): void {
  if (process.platform !== 'win32') {
    fs.renameSync(tmp, dest);
    return;
  }
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || Date.now() >= deadline) {
        throw err;
      }
      // Sync path: no event loop to yield to, so spin briefly.
      const until = Date.now() + 10;
      while (Date.now() < until) {
        /* busy-wait */
      }
    }
  }
}

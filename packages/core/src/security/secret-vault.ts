import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigError, ERROR_CODES } from '../types/errors.js';
import type { Logger } from '../types/logger.js';
import type { RotatableSecretVault, SecretVault } from '../types/secret-vault.js';
import { ENCRYPTED_PREFIX_PATTERN, encryptedPrefixForVersion } from '../types/secret-vault.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { encryptConfigSecrets, isSecretField } from './config-secrets.js';
import { restrictFilePermissions as restrictPermissions } from './file-permissions.js';

export interface SecretVaultOptions {
  /** Absolute path to the key file. Created with mode 0o600 if missing. */
  keyFile: string;
  /** Logger for structured warnings. Falls back to console.warn when omitted. */
  logger?: Logger | undefined;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGO = 'aes-256-gcm';
// Desired file mode for the key file on POSIX systems.
const KEY_FILE_MODE = 0o600;

/**
 * Key file format v2+: 4-byte magic + 1-byte version + 32-byte key = 37 bytes.
 * The magic header distinguishes versioned key files from legacy 32-byte raw keys.
 */
const KEY_FILE_MAGIC = Buffer.from('WSKV', 'ascii');
const VERSIONED_KEY_FILE_SIZE = KEY_FILE_MAGIC.length + 1 + KEY_BYTES; // 37 bytes

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
const KEK_MAGIC = Buffer.from('WSKW', 'ascii');
const KEK_SALT_BYTES = 16;
const WRAPPED_KEY_FILE_SIZE =
  KEK_MAGIC.length + 1 + KEK_SALT_BYTES + IV_BYTES + TAG_BYTES + KEY_BYTES; // 81 bytes
// scrypt cost parameters. N=2^15 keeps derivation ~50-100ms — strong against
// offline brute force while imperceptible for a one-time-per-process unlock.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // headroom above N*r*128 so derivation never throws

/** Read the optional vault passphrase from the environment. Empty = unset. */
function getVaultPassphrase(): string | undefined {
  const v = process.env['WRONGSTACK_VAULT_PASSPHRASE'];
  return v && v.length > 0 ? v : undefined;
}

/** True if `buf` is a passphrase-wrapped (v3) key file. */
function isWrappedKeyFile(buf: Buffer): boolean {
  return (
    buf.length === WRAPPED_KEY_FILE_SIZE && buf.subarray(0, KEK_MAGIC.length).equals(KEK_MAGIC)
  );
}

/** Derive the 32-byte KEK from a passphrase + salt via scrypt. */
function deriveKEK(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** Serialize a data key into the wrapped (v3) on-disk format under `passphrase`. */
function wrapDataKey(dataKey: Buffer, keyVersion: number, passphrase: string): Buffer {
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
function unwrapDataKey(buf: Buffer, keyFile: string): { key: Buffer; version: number } {
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
 * On Windows this is a no-op (mode bits don't apply).
 */
function keyFileNeedsHardening(
  keyFile: string,
  opts?: { warn?: (msg: string) => void } | undefined,
): boolean {
  if (process.platform === 'win32') return false; // No mode bits on Windows
  const warn = opts?.warn ?? ((msg: string) => console.warn(msg));
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
function mkdirSecretDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  try {
    // `mode` on mkdir is masked by the process umask, so set it explicitly.
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort — an unwritable mode is not a reason to fail boot.
  }
}

function writeKeyFileAtomicSync(keyFile: string, content: Buffer): void {
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
    fs.renameSync(tmp, keyFile);
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
 * Default vault: AES-256-GCM with a key stored at `keyFile` (mode 0o600).
 * The key is loaded lazily on first encrypt/decrypt; if it does not exist,
 * a fresh one is generated. Decryption of plaintext values is a no-op so
 * legacy configs continue to work.
 *
 * Key file format:
 *   - Legacy (v1): exactly 32 raw bytes
 *   - Versioned (v2+): 4-byte magic `WSKV` + 1-byte version + 32-byte key (37 bytes)
 *
 * Encrypted value format: `enc:v<N>:<iv>:<tag>:<ciphertext>` where N is the
 * key version. After rotation, encrypt() emits the new version prefix.
 */
export class DefaultSecretVault implements RotatableSecretVault {
  private readonly keyFile: string;
  private readonly logger: Logger | undefined;
  private key?: Buffer | undefined;
  private _keyVersion: number = 1;
  /**
   * Pending key-file hardening promises (Windows ACL restrictions via icacls).
   * Tracked so async callers can `flushHardening()` before returning, ensuring
   * a short-lived CLI process does not exit before the hardening resolves.
   * Sync-only callers (encrypt/decrypt lazy-load) leave these pending —
   * hardening remains best-effort in that case.
   */
  private pendingHardening: Promise<void>[] = [];

  constructor(opts: SecretVaultOptions) {
    this.keyFile = opts.keyFile;
    this.logger = opts.logger;
  }

  /**
   * Emit a structured warning. Uses the configured Logger when available;
   * falls back to console.warn(JSON) so warnings are never silently dropped
   * during early boot.
   */
  private logWarn(msg: string, ctx?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger.warn(msg, ctx);
    } else {
      console.warn(JSON.stringify({ ...ctx, message: msg, timestamp: new Date().toISOString() }));
    }
  }

  /**
   * Schedule best-effort key-file hardening and track the promise so async
   * callers can await it via `flushHardening()` before returning. Rejections
   * are swallowed here (the helper already warns on failure) so a rejection
   * can never become an unhandled one.
   */
  private scheduleKeyHardening(): void {
    const p = restrictPermissions(this.keyFile, {
      label: 'secret-vault-key',
      warn: (msg) => this.logWarn(msg),
    }).catch(() => undefined);
    this.pendingHardening.push(p);
  }

  /** Detect and schedule repair of a pre-existing POSIX key with loose mode bits. */
  private checkKeyFilePermissions(): void {
    if (
      keyFileNeedsHardening(this.keyFile, {
        warn: (msg) => this.logWarn(msg),
      })
    ) {
      this.scheduleKeyHardening();
    }
  }

  /** Flush all pending key-file hardening promises. */
  flushHardening(): Promise<void> {
    if (this.pendingHardening.length === 0) return Promise.resolve();
    const all = Promise.all(this.pendingHardening).then(() => undefined);
    this.pendingHardening = [];
    return all;
  }

  /** Current key version. Starts at 1; incremented by rotateKey(). */
  get keyVersion(): number {
    // Ensure key is loaded so version is accurate
    if (!this.key) this.loadOrCreateKey();
    return this._keyVersion;
  }

  isEncrypted(value: string): boolean {
    return typeof value === 'string' && ENCRYPTED_PREFIX_PATTERN.test(value);
  }

  encrypt(plaintext: string): string {
    if (this.isEncrypted(plaintext)) return plaintext;
    const key = this.loadOrCreateKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const prefix = encryptedPrefixForVersion(this._keyVersion);
    return `${prefix}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(value: string): string {
    if (!this.isEncrypted(value)) return value;
    // Strip the versioned prefix (enc:v1:, enc:v2:, etc.)
    const prefixMatch = value.match(ENCRYPTED_PREFIX_PATTERN);
    if (!prefixMatch) {
      throw new ConfigError({
        message: 'SecretVault: malformed encrypted value',
        code: ERROR_CODES.CONFIG_PARSE_FAILED,
        context: { field: 'encrypted_value' },
      });
    }
    const rest = value.slice(prefixMatch[0].length);
    const parts = rest.split(':');
    if (parts.length !== 3) {
      throw new ConfigError({
        message: 'SecretVault: malformed encrypted value',
        code: ERROR_CODES.CONFIG_PARSE_FAILED,
        context: { field: 'encrypted_value' },
      });
    }
    const [ivB64, tagB64, ctB64] = parts as [string, string, string];
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    if (iv.length !== IV_BYTES)
      throw new ConfigError({
        message: 'SecretVault: bad IV length',
        code: ERROR_CODES.CONFIG_PARSE_FAILED,
        context: { expected: IV_BYTES, actual: iv.length },
      });
    if (tag.length !== TAG_BYTES)
      throw new ConfigError({
        message: 'SecretVault: bad tag length',
        code: ERROR_CODES.CONFIG_PARSE_FAILED,
        context: { expected: TAG_BYTES, actual: tag.length },
      });
    const key = this.loadOrCreateKey();
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }

  /**
   * Generate a new encryption key, write it to disk, and increment the key version.
   * After rotation, encrypt() emits the new version prefix (e.g. enc:v2:).
   * The caller must re-encrypt existing config values (see rotateConfigKeys()).
   */
  rotateKey(): { oldVersion: number; newVersion: number } {
    const oldVersion = this._keyVersion;
    const newKey = randomBytes(KEY_BYTES);
    const newVersion = oldVersion + 1;

    mkdirSecretDirSync(path.dirname(this.keyFile));
    const passphrase = getVaultPassphrase();
    if (passphrase) {
      // Keep the rotated key passphrase-wrapped (v3) so rotation never
      // downgrades a protected key file to plaintext.
      writeKeyFileAtomicSync(this.keyFile, wrapDataKey(newKey, newVersion, passphrase));
    } else {
      // Write versioned key file: WSKV + version byte + key
      const keyFileBuf = Buffer.alloc(VERSIONED_KEY_FILE_SIZE);
      KEY_FILE_MAGIC.copy(keyFileBuf, 0);
      keyFileBuf[KEY_FILE_MAGIC.length] = newVersion;
      newKey.copy(keyFileBuf, KEY_FILE_MAGIC.length + 1);
      writeKeyFileAtomicSync(this.keyFile, keyFileBuf);
    }
    this.scheduleKeyHardening();
    this.checkKeyFilePermissions();

    this.key = newKey;
    this._keyVersion = newVersion;
    return { oldVersion, newVersion };
  }

  /**
   * If WRONGSTACK_VAULT_PASSPHRASE is set but the key on disk is still stored
   * unwrapped (legacy v1 / versioned v2), re-write it in passphrase-wrapped (v3)
   * form. The data key is preserved, so all existing ciphertext keeps
   * decrypting. Best-effort: a write failure leaves the working unwrapped file
   * in place and is not fatal to load.
   */
  private migrateToWrappedIfPassphrase(): void {
    const passphrase = getVaultPassphrase();
    if (!passphrase || !this.key) return;
    try {
      writeKeyFileAtomicSync(this.keyFile, wrapDataKey(this.key, this._keyVersion, passphrase));
      this.scheduleKeyHardening();
      this.checkKeyFilePermissions();
    } catch {
      // Non-fatal: the at-rest upgrade failed, but the loaded key is valid.
    }
  }

  private loadOrCreateKey(): Buffer {
    // readFileSync blocks the event loop, but this is a one-time cost per
    // process: the key is cached after the first load and reused for every
    // subsequent encrypt/decrypt. For CLI usage (single run → exit) this is
    // negligible. For server contexts (eternal autonomy, MCP server mode),
    // the first encrypt/decrypt call causes a brief (<1ms) event loop stall.
    // Prefer calling vault.encrypt('') during boot to warm the cache if this
    // is a concern in your deployment.
    if (this.key) return this.key;
    try {
      const buf = fs.readFileSync(this.keyFile);

      // Passphrase-wrapped (v3): unwrap with WRONGSTACK_VAULT_PASSPHRASE.
      // Checked first because its size/magic are distinct from the others.
      if (isWrappedKeyFile(buf)) {
        const { key, version } = unwrapDataKey(buf, this.keyFile);
        this.key = key;
        this._keyVersion = version;
        this.checkKeyFilePermissions();
        return this.key;
      }

      // Detect key file format:
      if (buf.length === KEY_BYTES) {
        // Legacy v1: raw 32-byte key
        this.key = buf;
        this._keyVersion = 1;
        this.checkKeyFilePermissions();
        // Upgrade to passphrase-wrapped at rest if a passphrase is configured.
        this.migrateToWrappedIfPassphrase();
        return this.key;
      }

      if (buf.length === VERSIONED_KEY_FILE_SIZE) {
        // Versioned v2+: WSKV magic + version byte + 32-byte key
        const magic = buf.subarray(0, KEY_FILE_MAGIC.length);
        if (!magic.equals(KEY_FILE_MAGIC)) {
          throw new ConfigError({
            message: `SecretVault: key file ${this.keyFile} has invalid magic header`,
            code: ERROR_CODES.CONFIG_INVALID,
            context: { keyFile: this.keyFile },
          });
        }
        const version = buf[KEY_FILE_MAGIC.length]!;
        const key = buf.subarray(KEY_FILE_MAGIC.length + 1);
        if (key.length !== KEY_BYTES) {
          throw new ConfigError({
            message: `SecretVault: key file ${this.keyFile} has wrong key size (${key.length} bytes, expected ${KEY_BYTES})`,
            code: ERROR_CODES.CONFIG_INVALID,
            context: { keyFile: this.keyFile, expectedBytes: KEY_BYTES, actualBytes: key.length },
          });
        }
        this.key = Buffer.from(key);
        this._keyVersion = version;
        this.checkKeyFilePermissions();
        // Upgrade to passphrase-wrapped at rest if a passphrase is configured.
        this.migrateToWrappedIfPassphrase();
        return this.key;
      }

      // Wrong size — neither legacy nor versioned format
      throw new ConfigError({
        message:
          `SecretVault: key file ${this.keyFile} is ${buf.length} bytes ` +
          `(expected ${KEY_BYTES} for v1 or ${VERSIONED_KEY_FILE_SIZE} for v2+). ` +
          `Remove it manually to generate a new key.`,
        code: ERROR_CODES.CONFIG_INVALID,
        context: { keyFile: this.keyFile, expectedBytes: KEY_BYTES, actualBytes: buf.length },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // Create a fresh key. Use sync APIs so the constructor-free getter
    // remains synchronous from the caller's perspective.
    mkdirSecretDirSync(path.dirname(this.keyFile));
    const key = randomBytes(KEY_BYTES);
    // When a passphrase is configured, a brand-new key is written wrapped (v3)
    // from the start; otherwise the legacy raw-32-byte format is preserved.
    const passphrase = getVaultPassphrase();
    const initialBytes = passphrase ? wrapDataKey(key, 1, passphrase) : key;
    // Use exclusive-create flag 'wx' to prevent races: if two processes race
    // to create the key file, only one succeeds and the loser gets EEXIST.
    try {
      fs.writeFileSync(this.keyFile, initialBytes, { mode: 0o600, flag: 'wx' });
      // WS-088: Harden file permissions after the write. On POSIX, `0o600`
      // in the open flags already sets the correct mode. On Windows, those
      // flags only flip the read-only bit — the file inherits the parent
      // directory's ACEs and stays readable by other accounts.
      // `restrictFilePermissions` closes that gap by shelling out to icacls.
      this.scheduleKeyHardening();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Another process won the race — re-read what they wrote.
      // Harden defensively: the winner may have been an older build
      // that didn't call restrictPermissions (WS-088).
      this.scheduleKeyHardening();
      const buf = fs.readFileSync(this.keyFile);
      if (isWrappedKeyFile(buf)) {
        const { key: winnerKey, version } = unwrapDataKey(buf, this.keyFile);
        this.key = winnerKey;
        this._keyVersion = version;
        this.checkKeyFilePermissions();
        return this.key;
      }
      if (buf.length === KEY_BYTES) {
        // Legacy v1 format
        this.key = buf;
        this._keyVersion = 1;
        this.checkKeyFilePermissions();
        return this.key;
      }
      if (buf.length === VERSIONED_KEY_FILE_SIZE) {
        // Versioned format
        const magic = buf.subarray(0, KEY_FILE_MAGIC.length);
        if (!magic.equals(KEY_FILE_MAGIC)) {
          throw new ConfigError({
            message: `SecretVault: key file ${this.keyFile} has invalid magic header`,
            code: ERROR_CODES.CONFIG_INVALID,
            context: { keyFile: this.keyFile },
          });
        }
        const version = buf[KEY_FILE_MAGIC.length]!;
        const winnerKey = buf.subarray(KEY_FILE_MAGIC.length + 1);
        this.key = Buffer.from(winnerKey);
        this._keyVersion = version;
        this.checkKeyFilePermissions();
        return this.key;
      }
      throw new ConfigError({
        message:
          `SecretVault: key file ${this.keyFile} is ${buf.length} bytes ` +
          `(expected ${KEY_BYTES} for v1 or ${VERSIONED_KEY_FILE_SIZE} for v2+). ` +
          `Remove it manually to generate a new key.`,
        code: ERROR_CODES.CONFIG_INVALID,
        context: { keyFile: this.keyFile, expectedBytes: KEY_BYTES, actualBytes: buf.length },
      });
    }
    this.key = key;
    this._keyVersion = 1;
    return key;
  }
}

// The config-walking helpers (decryptConfigSecrets, encryptConfigSecrets,
// isSecretField) live in config-secrets.ts — a crypto-free module — so that
// chunks which only walk configs don't bundle the AES-GCM vault. Re-exported
// here to keep this module's historical public API intact.
export { decryptConfigSecrets, encryptConfigSecrets, isSecretField } from './config-secrets.js';

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
    current = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // start from empty
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
    parsed = JSON.parse(raw);
  } catch {
    return { migrated: 0, file: configPath };
  }
  const counter = { n: 0 };
  const migrated = walkCount(parsed, vault, counter);
  if (counter.n === 0) return { migrated: 0, file: configPath };
  // atomicWrite: runs on every boot for legacy users — torn write = wipe.
  await atomicWrite(configPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
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
  const counter = { n: 0, failed: [] as string[] };
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
  const reencrypted = walkReencrypt(decrypted, vault);

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
  counter: { n: number; failed: string[] },
  pathPrefix = '',
): T {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item, i) =>
      walkDecryptCount(item, vault, counter, `${pathPrefix}[${i}]`),
    ) as never as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const keyPath = pathPrefix ? `${pathPrefix}.${k}` : k;
    if (typeof v === 'string' && vault.isEncrypted(v)) {
      try {
        out[k] = vault.decrypt(v);
        counter.n++;
      } catch {
        // Decryption failed — record the path and keep the old ciphertext.
        // The caller aborts rotation when counter.failed is non-empty, so
        // the old key is never discarded while this value still depends on it.
        counter.failed.push(keyPath);
        out[k] = v;
      }
    } else if (typeof v === 'object' && v !== null) {
      out[k] = walkDecryptCount(v, vault, counter, keyPath);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Walk a config object and re-encrypt all secret-bearing fields.
 * Unlike encryptConfigSecrets, this encrypts ALL string values that
 * were previously decrypted (they're now plaintext), not just those
 * matching the secret field pattern. This ensures we re-encrypt values
 * that were successfully decrypted in walkDecryptCount.
 */
function walkReencrypt<T>(node: T, vault: SecretVault): T {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item) => walkReencrypt(item, vault)) as never as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string' && isSecretField(k) && v.length > 0 && !vault.isEncrypted(v)) {
      // This was a decrypted secret — re-encrypt it
      out[k] = vault.encrypt(v);
    } else if (typeof v === 'object' && v !== null) {
      out[k] = walkReencrypt(v, vault);
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

/** Keys that, when written into a plain object, can poison the prototype
 *  chain. We never want user config to carry these. */
import { deepMerge } from '../utils/deep-merge.js';

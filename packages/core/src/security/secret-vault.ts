import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigError, ERROR_CODES } from '@wrongstack/contracts/types/errors';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { RotatableSecretVault } from '@wrongstack/contracts/types/secret-vault';
import {
  ENCRYPTED_PREFIX_PATTERN,
  encryptedPrefixForVersion,
} from '@wrongstack/contracts/types/secret-vault';
import { restrictFilePermissions as restrictPermissions } from './file-permissions.js';
import {
  ALGO,
  getVaultPassphrase,
  IV_BYTES,
  isWrappedKeyFile,
  KEY_BYTES,
  keyFileNeedsHardening,
  mkdirSecretDirSync,
  TAG_BYTES,
  unwrapDataKey,
  wrapDataKey,
  writeKeyFileAtomicSync,
} from './secret-vault-key-file.js';

export { keyFileNeedsHardening } from './secret-vault-key-file.js';

export interface SecretVaultOptions {
  /** Absolute path to the key file. Created with mode 0o600 if missing. */
  keyFile: string;
  /** Logger for structured warnings. Falls back to console.warn when omitted. */
  logger?: Logger | undefined;
}

/**
 * Key file format v2+: 4-byte magic + 1-byte version + 32-byte key = 37 bytes.
 * The magic header distinguishes versioned key files from legacy 32-byte raw keys.
 */
const KEY_FILE_MAGIC = Buffer.from('WSKV', 'ascii');
const VERSIONED_KEY_FILE_SIZE = KEY_FILE_MAGIC.length + 1 + KEY_BYTES;

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
    const newVersion = oldVersion + 1;
    // The versioned key file stores the version in a single byte. Writing
    // 256 truncates to 0 and replaces the version-255 key, so a reload
    // reports a different version and can no longer decrypt the previous
    // ciphertext. Refuse before any key material is generated or written.
    if (newVersion > 0xff) {
      throw new ConfigError({
        message:
          `SecretVault: key version ${oldVersion} cannot rotate; ` +
          `the on-disk version field is one byte (max 255)`,
        code: ERROR_CODES.CONFIG_INVALID,
        context: { keyFile: this.keyFile, keyVersion: oldVersion, maxVersion: 0xff },
      });
    }
    const newKey = randomBytes(KEY_BYTES);

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
export {
  migratePlaintextSecrets,
  rewriteConfigEncrypted,
  rotateConfigKeys,
} from './secret-vault-config.js';

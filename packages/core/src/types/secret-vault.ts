/**
 * SecretVault encrypts secrets-at-rest in config files. The wire format is
 * `enc:v<N>:<base64-iv>:<base64-tag>:<base64-ciphertext>` where `<N>` is the
 * key version used for encryption. Plaintext strings (those that do not match
 * this prefix) are passed through unchanged so that existing configs and
 * env-var-derived values keep working.
 *
 * Key rotation produces a new key and re-encrypts all secrets under it.
 * After rotation, `encrypt()` emits the new version prefix (e.g. `enc:v2:`)
 * and `decrypt()` accepts any version prefix — it uses the current key
 * regardless, since rotation re-encrypts every value atomically.
 *
 * The vault is intentionally NOT designed to defeat a determined local
 * attacker who can read both the config file and the key file — that level
 * of secrecy needs the OS keychain. The goal is to keep keys from being
 * visible in screen shares, accidental log captures, and `cat config.json`
 * over someone's shoulder.
 */
export interface SecretVault {
  encrypt(plaintext: string): string;
  decrypt(value: string): string;
  isEncrypted(value: string): boolean;
  /** Current key version. Starts at 1; incremented by `rotateKey()`. */
  readonly keyVersion: number;
  /**
   * Flush any pending asynchronous key-file hardening (e.g. Windows ACL
   * restrictions via icacls). Callers in async contexts should await this
   * before returning so a short-lived process does not exit before the
   * hardening promise resolves. Sync-only callers may skip it — the
   * hardening remains best-effort in that case.
   */
  flushHardening?(): Promise<void>;
}

/**
 * RotatableSecretVault extends SecretVault with key rotation support.
 * `rotateKey()` generates a fresh key, writes it to disk, and increments
 * the key version. All subsequent `encrypt()` calls use the new version
 * prefix. The caller is responsible for re-encrypting existing config
 * values (see `rotateConfigKeys()`).
 */
export interface RotatableSecretVault extends SecretVault {
  rotateKey(): { oldVersion: number; newVersion: number };
}

/** Legacy v1 prefix — values encrypted before key rotation was introduced. */
export const ENCRYPTED_PREFIX = 'enc:v1:';

/**
 * Match any versioned encrypted value prefix: `enc:v1:`, `enc:v2:`, etc.
 * Used by `isEncrypted()` and `decrypt()` to handle all versions uniformly.
 */
export const ENCRYPTED_PREFIX_PATTERN = /^enc:v(\d+):/;

/**
 * Return the encrypted prefix for a given key version.
 * @example encryptedPrefixForVersion(1) // 'enc:v1:'
 * @example encryptedPrefixForVersion(2) // 'enc:v2:'
 */
export function encryptedPrefixForVersion(version: number): string {
  return `enc:v${version}:`;
}

/**
 * Parse the key version from an encrypted value string.
 * Returns undefined if the string is not an encrypted value.
 */
export function parseEncryptedVersion(value: string): number | undefined {
  const match = value.match(ENCRYPTED_PREFIX_PATTERN);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

/**
 * No-op SecretVault that passes values through unchanged.
 * Used in contexts where encryption is not needed — e.g. reading/writing
 * config sections that contain no secret fields (models, settings, etc.).
 */
export const noOpVault: SecretVault = {
  encrypt: (v) => v,
  decrypt: (v) => v,
  isEncrypted: () => false,
  keyVersion: 1,
};

import type { SecretVault } from '../types/secret-vault.js';

/**
 * Config-walking secret helpers, split out of secret-vault.ts so that
 * consumers which only need the walk logic (config loader, provider-config
 * watcher) don't pull the AES-GCM vault implementation — and its node:crypto
 * imports — into their bundle chunk. Everything here operates purely through
 * the `SecretVault` interface.
 */

/**
 * Walk a Config-shaped object and decrypt any apiKey-like fields in place,
 * returning a new object. Used by the config loader so the rest of the
 * system never has to know about the wire format.
 *
 * @param warn — callback for decryption warnings. Defaults to `console.warn`
 *   for backward compatibility; pass `logger.warn` when a structured logger
 *   is available (preferred in long-running/server contexts).
 */
export function decryptConfigSecrets<T>(
  cfg: T,
  vault: SecretVault,
  opts?: { warn?: (msg: string) => void },
): T {
  const warn = opts?.warn ?? ((msg: string) => console.warn(msg));
  // A single corrupted/malformed encrypted field should not kill the entire
  // config load. Swallow per-field decrypt errors (zero the field so callers
  // see "missing key" instead of holding ciphertext) and surface a warning.
  return walk(cfg, vault, (v, key) => {
    try {
      return vault.decrypt(v);
    } catch (err) {
      warn(
        `[secret-vault] Failed to decrypt "${key}": ${err instanceof Error ? err.message : err}`,
      );
      return '';
    }
  });
}

export function encryptConfigSecrets<T>(
  cfg: T,
  vault: SecretVault,
  _opts?: { warn?: (msg: string) => void },
): T {
  return walk(cfg, vault, (v) => vault.encrypt(v));
}

function walk<T>(node: T, vault: SecretVault, transform: (s: string, key: string) => string): T {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item) => walk(item, vault, transform)) as never as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string' && isSecretField(k)) {
      out[k] = transform(v, k);
    } else if (typeof v === 'object' && v !== null) {
      out[k] = walk(v, vault, transform);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * A key is treated as secret-bearing if its name (case-insensitive) contains
 * one of these tokens. Captures common variants like `apiKey`, `authToken`,
 * `refreshToken`, `sessionKey`, `password`, `client_secret`, `bearer`, etc.
 * Use a named field with `isSecret: false` annotation if you must opt out —
 * see `NON_SECRET_OVERRIDES` below.
 */
/*
 * Hyphenated spellings are included deliberately. `apiKey` and `api_key` were
 * recognized but `api-key` was not — which is exactly the HTTP header spelling,
 * and `ProviderConfig.headers` / `MCPServerConfig.headers` are a documented,
 * first-class place to put credentials (`Authorization: Bearer <token>`). The
 * config walker recurses into `headers` and copied non-matching keys through
 * verbatim, so a file could show `apiKey: "enc:v1:…"` beside a plaintext
 * `Authorization` header. The danger is not the file mode — it is that the
 * config *looks* encrypted and is therefore treated as safe to back up, paste
 * or sync. `cloud-config-sync/sanitize.ts` already documents that `headers`
 * carries values; this predicate had not caught up.
 */
const SECRET_KEY_PATTERN =
  /(?:api[-_]?key|auth[-_]?token|authorization|proxy-authorization|cookie|bearer|secret|password|passwd|pwd|refresh[-_]?token|session[-_]?key|access[_-]?token|private[_-]?key|token\b)/i;

// Field names that contain the literal substring "key" but are not secrets.
// Keep this list short; the substring rule itself is intentionally narrow.
const NON_SECRET_OVERRIDES = new Set(['publickey', 'public_key']);

export function isSecretField(name: string): boolean {
  const lc = name.toLowerCase();
  if (NON_SECRET_OVERRIDES.has(lc)) return false;
  return SECRET_KEY_PATTERN.test(lc);
}

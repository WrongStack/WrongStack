import { createHash } from 'node:crypto';
import type { HqAlertRuleConfig } from './alerts.js';
import type { HqRedactionPolicy } from './protocol.js';

/** Current auth-file schema version. Bump on breaking shape changes. */
export const HQ_AUTH_FILE_VERSION = 1 as const;

/**
 * A generic HQ-issued token. Used for both browser tokens (validated on
 * `/ws/browser`) and client tokens (validated on `/ws/client`). The two
 * are stored in separate lists so a browser-only token cannot be replayed
 * against the client channel and vice versa.
 *
 * `capabilities` scopes what a token may do. When absent the token is
 * unrestricted (backward-compat with tokens minted before Phase 3). Known
 * capability strings:
 *   - `control.enqueue` — browser token may enqueue commands to clients
 *   - `control.approve` — browser token may answer a client's permission
 *     prompts (`approve`). Deliberately separate from `control.enqueue`:
 *     `always`/`deny` write persistent trust policy and `yes` can release a
 *     destructive call, so a steer-only credential must not carry it. Not
 *     granted to the first-run token; the operator mints it explicitly.
 *   - `control.execute` — client token may execute `run-command` commands
 *   - `telemetry.publish` — client token may publish telemetry
 */
export interface HqToken {
  id: string;
  token: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
  /**
   * Optional capability scope. When absent, the token is unrestricted
   * (backward-compat). When present, only the listed capabilities are
   * granted.
   */
  capabilities?: string[];
  /**
   * Optional ISO timestamp after which the token is refused. When absent
   * (the pre-TTL default), the token never expires. The HQ server rejects
   * an expired token at both the HTTP and the WS-upgrade auth boundary,
   * so TTL rotation is enforced even for long-lived browser sessions.
   *
   * The timestamp is wall-clock (`new Date().toISOString()`). Clock skew
   * between the issuing HQ and the client is handled by passing a
   * `clockSkewMs` tolerance to {@link isTokenExpired} and
   * {@link tokenHasCapability} — callers that fetch tokens from a remote
   * HQ should use the server's clock (e.g. `Date.parse(expiresAt)`)
   * rather than the local wall clock.
   */
  expiresAt?: string;
  /**
   * `sha256(secret)`, hex. WS-044: browser tokens used to sit in `auth.json`
   * in cleartext, directly beside a correctly scrypt-hashed password — so a
   * copy of the file (a home-directory backup, a synced folder, a support
   * bundle) handed over working bearer credentials. Browser tokens are now
   * persisted as a verifier only, and `token` is blanked on write.
   *
   * Client tokens deliberately keep their cleartext `token`: a local agent
   * process reads it back out of `auth.json` to attach itself as an HQ client
   * (`hq/factory.ts readFirstClientTokenFromAuthFile`). Hashing them would
   * only move the secret to another file on the same disk. Their control is
   * the owner-only file mode (WS-045), not a one-way hash.
   */
  verifier?: string;
}

export interface HqAuthFile {
  version: typeof HQ_AUTH_FILE_VERSION;
  updatedAt: string;
  /**
   * Operator-configured redaction policy override. When present, the HQ
   * server applies these settings AFTER any publisher-declared policy —
   * i.e. the operator can always tighten, never loosen.
   */
  redactionPolicy?: Partial<HqRedactionPolicy>;
  /** Browser tokens — validated on `/ws/browser` upgrades (Phase 3). */
  browserTokens?: HqToken[];
  /** Client tokens — validated on `/ws/client` upgrades (Phase 4). */
  clientTokens?: HqToken[];
  /** scrypt hash of the optional browser password login. */
  passwordHash?: string;
  /** Secret used to sign browser session cookies. */
  cookieSecret?: string;
  /**
   * Base32-encoded TOTP secret (RFC 6238) for HQ 2FA — ACTIVE. Login checks
   * this field, not `totpPendingSecret`, so an unconfirmed setup cannot lock
   * the operator out. Only set after `/api/auth/totp/enable` confirms a
   * valid code.
   */
  totpSecret?: string;
  /**
   * Base32-encoded TOTP secret written by `/api/auth/totp/setup` but NOT
   * yet confirmed. Promoted to `totpSecret` (active) only after
   * `/api/auth/totp/enable` verifies a code. If the operator abandons
   * enrollment (restarts, logs out), the pending secret is inert — login
   * never checks this field.
   */
  totpPendingSecret?: string;
  /**
   * SHA-256 hashes of single-use recovery codes. Like token verifiers
   * (WS-044), only the hash is persisted so a leaked `auth.json` cannot
   * reveal unused codes. Each code is consumed on first successful use.
   */
  totpRecoveryCodes?: string[];
  /**
   * Highest TOTP time-step counter already consumed by a successful 2FA
   * verification (SEC-002: persisted to prevent replay after restart).
   * Written by the 2FA verification route (`totp-routes.ts`) — not the
   * initial password check — and read there to reject any counter <= this
   * value, so an observed code cannot be replayed within its validity
   * window even across a server restart.
   */
  totpLastUsedCounter?: number;
  /**
   * Operator-configured alert-rule thresholds. When present, these override
   * the built-in defaults for the alert engine (cost ceiling, stale-machine
   * window, concurrency limit). Live-reloaded with the rest of the file.
   */
  alertRules?: HqAlertRuleConfig;
}

/**
 * Sentinel value `hqAuthContentHash` substitutes for every raw secret
 * (`HqToken.token`, `HqAuthFile.passwordHash`, `HqAuthFile.cookieSecret`)
 * before hashing. Exported so downstream consumers of the audit log can
 * recognize the redaction shape without hardcoding the literal — e.g. a
 * forensic tool that re-derives a `contentHash` from a known on-disk
 * `auth.json` can substitute this same sentinel and compare.
 */
export const HQ_AUTH_CONTENT_HASH_REDACTED = '<redacted>';

/**
 * Compute a SHA-256 content hash over a *redacted* projection of an
 * `HqAuthFile`. The projection replaces every raw token string, the
 * `passwordHash`, and the `cookieSecret` with constant sentinels, so:
 *
 *   - the audit log never holds derivable token material (a hash of a
 *     redacted projection can't be reversed to recover the originals),
 *   - two files that differ only in their secrets hash identically
 *     (reissuing a token without changing its id/label/expiry does not
 *     change the hash), and
 *   - the hash still flips whenever the structural state the operator
 *     cares about (version, token ids/labels/capabilities/expiries,
 *     alert rules, redaction policy) changes.
 *
 * Returns `undefined` when hashing or serialization throws (e.g. a
 * future schema addition that isn't JSON-serializable) — callers
 * should pass that through as an absent `contentHash` field rather
 * than failing the audit append, matching the audit module's
 * best-effort contract.
 *
 * W1 #11 (architecture overview): the auth file is re-read on every WS
 * upgrade and on every auth-watcher tick, and `hqAuthContentHash` was
 * paying the full SHA-256 cost each time. For a file with hundreds of
 * browser tokens, that was the dominant cost of the per-connection auth
 * path. The canonical projection string is used as the cache key — so an
 * unchanged file returns the cached hash in O(1), and only a real
 * structural change re-derives it.
 *
 * The cache is process-local. The auth-file watcher invalidates by
 * passing a fresh file reference (the watcher always re-reads on
 * change), and in-memory token mutations always pass the updated file,
 * so no explicit `invalidate()` call is needed. Worst-case staleness:
 * one process lifetime per unique serialized projection.
 */
export const _hqAuthHashCache = new Map<string, string>();

export const _HQ_AUTH_HASH_CACHE_MAX = 256;

export function hqAuthContentHash(file: HqAuthFile): string | undefined {
  const REDACTED = HQ_AUTH_CONTENT_HASH_REDACTED;
  const redactToken = (t: HqToken): HqToken => ({ ...t, token: REDACTED });
  let projection: HqAuthFile;
  try {
    // `exactOptionalPropertyTypes: true` means optional fields can't be
    // assigned `undefined` explicitly — preserve absence via conditional
    // spreads so the projection stays a valid `HqAuthFile`.
    projection = {
      version: file.version,
      updatedAt: file.updatedAt,
      ...(file.redactionPolicy !== undefined ? { redactionPolicy: file.redactionPolicy } : {}),
      ...(file.browserTokens !== undefined
        ? { browserTokens: file.browserTokens.map(redactToken) }
        : {}),
      ...(file.clientTokens !== undefined
        ? { clientTokens: file.clientTokens.map(redactToken) }
        : {}),
      ...(file.passwordHash !== undefined ? { passwordHash: REDACTED } : {}),
      ...(file.cookieSecret !== undefined ? { cookieSecret: REDACTED } : {}),
      ...(file.totpSecret !== undefined ? { totpSecret: REDACTED } : {}),
      ...(file.totpPendingSecret !== undefined ? { totpPendingSecret: REDACTED } : {}),
      ...(file.totpRecoveryCodes !== undefined
        ? { totpRecoveryCodes: file.totpRecoveryCodes.map(() => REDACTED) }
        : {}),
      ...(file.totpLastUsedCounter !== undefined
        ? { totpLastUsedCounter: file.totpLastUsedCounter }
        : {}),
      ...(file.alertRules !== undefined ? { alertRules: file.alertRules } : {}),
    };
  } catch {
    return undefined;
  }
  return hqAuthContentHashCached(projection);
}

/**
 * Inner hash function with memoization. Public callers should use
 * {@link hqAuthContentHash} — this is exported for tests that need to
 * assert the cache behavior directly.
 *
 * The cache key is the canonical JSON serialization of the projection
 * (stable key order, since the projection above has fixed key ordering).
 * Two structurally-identical files share a hash entry; any change to the
 * projection — which is the only thing that should change the hash —
 * produces a different key and a fresh computation.
 *
 * Cache size is bounded by `_HQ_AUTH_HASH_CACHE_MAX` entries. An entry is
 * a few hundred bytes (the JSON projection), so 256 entries is ~64 KiB
 * worst-case — negligible next to the auth file itself, and prevents an
 * adversarial or pathological sequence of unique projections from growing
 * the map without bound.
 */
export function hqAuthContentHashCached(projection: HqAuthFile): string | undefined {
  let payload: string;
  try {
    // Stable key ordering — the projection above has a fixed key order, so
    // the serialized form is deterministic across runs for the same
    // structural state.
    payload = JSON.stringify(projection);
  } catch {
    return undefined;
  }
  const cached = _hqAuthHashCache.get(payload);
  if (cached !== undefined) return cached;
  const hash = createHash('sha256').update(payload).digest('hex');
  if (_hqAuthHashCache.size >= _HQ_AUTH_HASH_CACHE_MAX) {
    const oldest = _hqAuthHashCache.keys().next().value;
    if (oldest !== undefined) _hqAuthHashCache.delete(oldest);
  }
  _hqAuthHashCache.set(payload, hash);
  return hash;
}

/**
 * Test-only: drop all memoized auth-file hashes. Production code never
 * needs to invalidate — the watcher always re-reads, producing a fresh
 * projection whose canonical serialization is a different cache key.
 */
export function _resetHqAuthHashCacheForTests(): void {
  _hqAuthHashCache.clear();
}

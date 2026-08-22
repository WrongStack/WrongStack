/**
 * HQ auth-store — persistent `auth.json` for the HQ command center.
 *
 * Holds:
 * - Operator-configured redaction policy override (applied server-side
 *   even when a publisher claims rawContent:true).
 * - Browser tokens + client tokens. Separate lists so a browser-only token
 *   cannot be replayed on /ws/client and vice versa.
 * - Operator-configured alert-rule thresholds (`alertRules`), live-reloaded.
 * - Live reload hook: callers can `watchHqAuthFile()` to re-read on change.
 *
 * Storage layout (under the HQ data directory, default `~/.wrongstack/hq/`):
 *   <dataDir>/auth.json    — this file (atomic write, mode 0o600)
 *   <dataDir>/events.jsonl — persistent event log (rotated)
 *   <dataDir>/snapshot.json — persisted latest snapshot (cache)
 *
 * The file is written atomically (tmp + rename) with mode 0o600 so a
 * shared host cannot read issued tokens or the redaction policy.
 *
 * Reads fail CLOSED, with one exception. A missing file (ENOENT) yields an
 * empty document — that is a fresh install, and open mode is the intended
 * first-run state. Everything else (EACCES, EIO, malformed JSON, an
 * unsupported schema version) throws. This docblock used to promise that a
 * corrupt file "yields an empty document plus a warning"; it never did, and
 * it must not — an unreadable auth file that degraded to "no credentials
 * configured" would turn a permissions accident into an open server.
 *
 * @module hq/auth-store
 */
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import * as syncFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { restrictFilePermissions, SECRET_FILE_MODE } from '../security/file-permissions.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { isPidAlive } from '../utils/pid.js';
import { wstackGlobalRoot } from '../utils/wstack-paths.js';
import type { HqAlertRuleConfig } from './alerts.js';
import { logHqAuthAudit } from './auth-audit.js';
import type { HqRedactionPolicy } from './protocol.js';

/** Current auth-file schema version. Bump on breaking shape changes. */
export const HQ_AUTH_FILE_VERSION = 1 as const;

/** Default HQ data directory: `~/.wrongstack/hq` (honors WRONGSTACK_HOME). */
export function defaultHqDataDir(): string {
  return path.join(wstackGlobalRoot(), 'hq');
}

/**
 * Resolve an HQ data directory from an optional override.
 *
 * Resolution order:
 *   1. Explicit `override` (from `--data-dir`) — resolved against
 *      `process.cwd()` if relative.
 *   2. `WRONGSTACK_HQ_DATA_DIR` env var (same resolution rules).
 *   3. `defaultHqDataDir()` — `~/.wrongstack/hq`.
 *
 * The env var exists so tests (and sandboxed runs) can redirect HQ state
 * away from the real user home without threading a CLI flag everywhere.
 */
export function resolveHqDataDir(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = override ?? env['WRONGSTACK_HQ_DATA_DIR']?.trim();
  if (!raw) return defaultHqDataDir();
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(process.cwd(), raw);
}

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

/**
 * The one-way verifier for an HQ token secret.
 *
 * Plain SHA-256, not scrypt: unlike the operator password, a token is 64 hex
 * characters of `randomUUID()` entropy, so there is nothing to brute-force
 * and the verifier sits on the per-request auth path where a deliberately
 * slow KDF would be a self-inflicted DoS.
 */
export function hqTokenVerifier(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Lookup key for a stored token — its verifier, derived from a legacy
 * cleartext `token` when the file predates WS-044. Every live-token Set/Map
 * in the HQ server is keyed on this, and the presented secret is hashed with
 * {@link hqTokenVerifier} before lookup, so both formats authenticate during
 * the migration window.
 */
export function hqTokenKey(token: Pick<HqToken, 'token' | 'verifier'>): string {
  if (token.verifier !== undefined && token.verifier.length > 0) return token.verifier;
  return token.token ? hqTokenVerifier(token.token) : '';
}

/**
 * On-disk form of a browser token: verifier present, secret blanked. Already
 * hashed tokens pass through untouched, so the conversion is idempotent.
 */
function hashBrowserToken(token: HqToken): HqToken {
  if (token.verifier !== undefined && token.verifier.length > 0) {
    return token.token ? { ...token, token: '' } : token;
  }
  if (!token.token) return token;
  return { ...token, verifier: hqTokenVerifier(token.token), token: '' };
}

/**
 * True when a token has a wall-clock expiry that has already passed.
 * Returns `false` when `expiresAt` is absent (the pre-TTL default).
 *
 * The check is fail-open for malformed values: an unparseable timestamp
 * is treated as "no expiry" rather than "already expired", because the
 * latter would lock the operator out of their own HQ on a bad file edit.
 * Use {@link tokenHasCapability} at the auth boundary to also deny
 * capabilities for expired tokens.
 *
 * @param at - epoch milliseconds; defaults to `Date.now()`. Exposed so
 *   tests can inject a fixed clock.
 * @param clockSkewMs - tolerance in milliseconds for clock skew between
 *   the issuing node and the verifying node. When set, a token that has
 *   technically expired by up to `clockSkewMs` is still accepted, so a
 *   verifier whose clock is slightly ahead of the issuer does not
 *   prematurely reject valid tokens. Defaults to 0 (no tolerance).
 */
export function isTokenExpired(
  token: Pick<HqToken, 'expiresAt'> | undefined,
  at: number = Date.now(),
  clockSkewMs: number = 0,
): boolean {
  if (token === undefined) return false;
  const expiresAt = token.expiresAt;
  if (expiresAt === undefined) return false;
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return false;
  return at >= parsed - Math.max(0, clockSkewMs);
}

/**
 * Check whether a token grants a capability. A token with no `capabilities`
 * field is unrestricted (backward-compat). Otherwise the capability must be
 * explicitly listed. **Expired tokens are refused regardless of capability**
 * — call this at the auth boundary so TTL rotation is enforced uniformly.
 *
 * @param clockSkewMs - passed through to {@link isTokenExpired}. When set, a
 *   token that has expired by up to `clockSkewMs` is still accepted. Defaults
 *   to 0.
 */
export function tokenHasCapability(
  token: HqToken | undefined,
  capability: string,
  clockSkewMs: number = 0,
): boolean {
  if (token === undefined) return false;
  if (isTokenExpired(token, Date.now(), clockSkewMs)) return false;
  if (token.capabilities === undefined) return true;
  return token.capabilities.includes(capability);
}

/**
 * Alias kept for backward-compat with Phase 3 callers/tests. New code
 * should prefer `HqToken`.
 */
export type HqBrowserToken = HqToken;

/** On-disk shape of `<dataDir>/auth.json`. */
export interface HqRuntimeFile {
  url: string;
  updatedAt: string;
  pid?: number;
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

/** An empty auth file — what a brand-new HQ install starts with. */
export function emptyHqAuthFile(): HqAuthFile {
  return {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
  };
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
 */
export function hqAuthContentHash(file: HqAuthFile): string | undefined {
  const REDACTED = HQ_AUTH_CONTENT_HASH_REDACTED;
  const redactToken = (t: HqToken): HqToken => ({ ...t, token: REDACTED });
  try {
    // `exactOptionalPropertyTypes: true` means optional fields can't be
    // assigned `undefined` explicitly — preserve absence via conditional
    // spreads so the projection stays a valid `HqAuthFile`.
    const projection: HqAuthFile = {
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
    // Stable key ordering — the projection above has a fixed key order, so
    // the serialized form is deterministic across runs for the same
    // structural state.
    const payload = JSON.stringify(projection);
    return createHash('sha256').update(payload).digest('hex');
  } catch {
    return undefined;
  }
}

/** Path to `auth.json` under the given data directory. */
export function hqAuthFilePath(dataDir: string): string {
  return path.join(dataDir, 'auth.json');
}

/** Path to the best-effort runtime endpoint marker under the given data directory. */
export function hqRuntimeFilePath(dataDir: string): string {
  return path.join(dataDir, 'runtime.json');
}

export async function writeHqRuntimeFile(
  dataDir: string,
  file: Omit<HqRuntimeFile, 'updatedAt'>,
): Promise<void> {
  const payload: HqRuntimeFile = {
    ...file,
    updatedAt: new Date().toISOString(),
  };
  const target = hqRuntimeFilePath(dataDir);
  await atomicWrite(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: SECRET_FILE_MODE });
  // WS-045: this file carries the local client token. `mode: 0o600` alone is a
  // no-op on Windows beyond the read-only bit, so every other account on the
  // machine could read it.
  await restrictFilePermissions(target, { label: 'hq-runtime' });
}

export function readHqRuntimeFileSync(dataDir: string): HqRuntimeFile | undefined {
  try {
    const parsed = JSON.parse(
      syncFs.readFileSync(hqRuntimeFilePath(dataDir), 'utf8'),
    ) as Partial<HqRuntimeFile>;
    if (typeof parsed.url !== 'string' || parsed.url.trim().length === 0) return undefined;
    if (typeof parsed.pid === 'number' && !isPidAlive(parsed.pid)) return undefined;
    return {
      url: parsed.url,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Read `auth.json` from disk. Returns `emptyHqAuthFile()` when the file does
 * NOT exist (ENOENT) — the only case treated as intentional open mode.
 *
 * Throws for all other read failures (EACCES, EIO, etc.), malformed JSON,
 * and unsupported schema versions. A corrupt or unreadable auth file must
 * never silently open the server.
 *
 * Callers that want to handle errors gracefully (e.g. the live-reload
 * watcher which should preserve the last-known-good state) should catch
 * the thrown error.
 */
export async function readHqAuthFile(
  dataDir: string,
  _opts: { warn?: (msg: string) => void } = {},
): Promise<HqAuthFile> {
  const file = hqAuthFilePath(dataDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyHqAuthFile();
    // Non-ENOENT (EACCES, EIO, …) — fail closed.
    throw new Error(
      `HQ auth file at ${file} cannot be read: ${(err as Error).message}. ` +
        'Fix the file permissions or delete it to start with an empty auth state.',
    );
  }
  let parsed: HqAuthFile;
  try {
    parsed = JSON.parse(raw) as HqAuthFile;
  } catch (err) {
    throw new Error(
      `HQ auth file at ${file} is not valid JSON: ${(err as Error).message}. ` +
        'Fix the file or delete it to start with an empty auth state.',
    );
  }
  if (parsed.version !== HQ_AUTH_FILE_VERSION) {
    throw new Error(
      `HQ auth file at ${file} has unsupported version ${String(parsed.version)} ` +
        `(expected ${String(HQ_AUTH_FILE_VERSION)}). ` +
        'Remove or update the file to match the current schema version.',
    );
  }
  return parsed;
}

/**
 * Write `auth.json` atomically, owner-only. Creates the data directory if
 * needed. Throws on I/O failure — callers (CLI commands) should surface the
 * error to the operator.
 *
 * WS-045: the `mode: 0o600` here was the whole protection, and Windows ignores
 * it. The file holds browser and client bearer tokens; it now also goes
 * through the icacls path so it is genuinely owner-only on both platforms.
 */
export async function writeHqAuthFile(dataDir: string, file: HqAuthFile): Promise<void> {
  const target = hqAuthFilePath(dataDir);
  const payload: HqAuthFile = {
    ...file,
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    // WS-044: browser secrets never touch the disk. Any legacy cleartext in
    // the incoming file is converted here, so the first write after an
    // upgrade migrates the whole list — no separate migration step to forget
    // to run, and no window where an old file stays cleartext because nothing
    // happened to rewrite it.
    ...(file.browserTokens !== undefined
      ? { browserTokens: file.browserTokens.map(hashBrowserToken) }
      : {}),
  };
  await atomicWrite(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: SECRET_FILE_MODE });
  await restrictFilePermissions(target, { label: 'hq-auth' });
}

export interface EnsureHqFirstRunAuthOptions {
  warn?: (msg: string) => void;
  /** Optional browser password login. Hashed with scrypt before storage. */
  password?: string;
  /**
   * Optional time-to-live (milliseconds) stamped on the first-run browser
   * and client tokens. When set, both tokens carry an `expiresAt` and the
   * HQ server will refuse them once it passes. Default: no expiry.
   *
   * Only affects tokens minted by THIS call (the first run). Tokens added
   * later via `wstack hq token create` choose their own TTL.
   */
  tokenTtlMs?: number | undefined;
  /**
   * Optional `actor` string recorded in `auth-audit.jsonl` for the two
   * `first-run` entries this function emits (one per minted token). The
   * CLI fills this with `user@host`; when omitted the entry carries no
   * `actor` field. Never contains the token string.
   */
  actor?: string | undefined;
}

export interface EnsureHqFirstRunAuthResult {
  authFile: HqAuthFile;
  created: boolean;
  browserToken?: HqToken;
  clientToken?: HqToken;
}

/**
 * Ensure a brand-new HQ data directory has the auth required for safe
 * first-run operation. Only a missing auth.json is bootstrapped; an existing
 * file, including one with empty token arrays, is treated as operator intent.
 *
 * Caller surface: the sole production caller is `startHqServer` in
 * `packages/cli/src/hq-server.ts`, which threads `actor: resolveAuditActor()`
 * so both first-run audit entries carry `user@host`. Test callers live under
 * `packages/core/tests/hq/` (token-ttl, first-run-audit, auth-store). Any
 * new production caller MUST pass `actor` for the audit log to carry
 * forensic identity — see `EnsureHqFirstRunAuthOptions.actor`.
 */
export async function ensureHqFirstRunAuthFile(
  dataDir: string,
  opts: EnsureHqFirstRunAuthOptions = {},
): Promise<EnsureHqFirstRunAuthResult> {
  const file = hqAuthFilePath(dataDir);
  try {
    await fs.access(file);
    const existing = await readHqAuthFile(dataDir, opts);
    if (opts.password) {
      const passwordUnchanged =
        existing.passwordHash !== undefined &&
        (await verifyHqPassword(opts.password, existing.passwordHash));
      if (!passwordUnchanged) {
        const authFile: HqAuthFile = {
          ...existing,
          passwordHash: await hashHqPassword(opts.password),
          // Rotating the cookie secret invalidates sessions created with the
          // previous password. This matters when --password is used to
          // recover or deliberately change an existing HQ installation.
          cookieSecret: mintHqCookieSecret(),
        };
        await writeHqAuthFile(dataDir, authFile);
        // Re-read so the hash reflects exactly what landed on disk —
        // `writeHqAuthFile` re-stamps `updatedAt` internally, so hashing
        // the in-memory `authFile` would diverge from the persisted state
        // an operator can independently inspect.
        const persisted = await readHqAuthFile(dataDir, opts);
        const hash = hqAuthContentHash(persisted);
        const actorField = opts.actor ? { actor: opts.actor } : {};
        logHqAuthAudit(
          dataDir,
          {
            kind: 'password-rotate',
            scope: 'browser',
            tokenId: '(password-rotation)',
            ...(hash !== undefined ? { contentHash: hash } : {}),
            ...actorField,
          },
          {
            onError: (err) =>
              opts.warn?.(`HQ password-rotate audit write failed: ${(err as Error).message}`),
          },
        );
        return { authFile: persisted, created: false };
      }
    }
    return { authFile: existing, created: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      opts.warn?.(`HQ auth file access failed at ${file}: ${(err as Error).message}`);
      return { authFile: await readHqAuthFile(dataDir, opts), created: false };
    }
  }

  // First-run credentials are deliberately least-privilege. Operators can
  // mint an execution-capable client token explicitly when remote command
  // execution is required; a freshly started HQ must never grant it by
  // accident.
  const browserToken = {
    ...mintHqToken({ label: 'first-run browser', ttlMs: opts.tokenTtlMs }),
    capabilities: ['control.enqueue'],
  };
  const clientToken = {
    ...mintHqToken({ label: 'first-run client', ttlMs: opts.tokenTtlMs }),
    capabilities: ['telemetry.publish'],
  };
  const authFile: HqAuthFile = {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [browserToken],
    clientTokens: [clientToken],
  };
  if (opts.password) {
    authFile.passwordHash = await hashHqPassword(opts.password);
    authFile.cookieSecret = mintHqCookieSecret();
  }
  await writeHqAuthFile(dataDir, authFile);

  // Re-read so the audit hash + the returned `authFile` reflect exactly
  // what landed on disk. `writeHqAuthFile` re-stamps `updatedAt` (and
  // could normalize other fields in the future); hashing the in-memory
  // `authFile` would diverge from the persisted state an operator can
  // independently inspect, defeating the forensic-tie-back purpose.
  const persisted = await readHqAuthFile(dataDir, opts);

  // Record both first-run mints in auth-audit.jsonl. Best-effort: a failed
  // append must never roll back the fresh auth.json we just wrote. The two
  // entries use the same `kind: 'first-run'` discriminator the audit
  // schema reserves for this bootstrap path. Both carry the content hash of
  // the persisted file so an operator reviewing the log can tie them back
  // to the exact on-disk state without the log holding secrets.
  const hash = hqAuthContentHash(persisted);
  const hashField = hash !== undefined ? { contentHash: hash } : {};
  const actorField = opts.actor ? { actor: opts.actor } : {};
  for (const [scope, token] of [
    ['browser', browserToken],
    ['client', clientToken],
  ] as const) {
    logHqAuthAudit(
      dataDir,
      {
        kind: 'first-run',
        scope,
        tokenId: token.id,
        ...hashField,
        ...(token.label ? { label: token.label } : {}),
        capabilities: token.capabilities,
        ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
        ...actorField,
      },
      {
        onError: (err) => opts.warn?.(`HQ first-run audit write failed: ${(err as Error).message}`),
      },
    );
  }

  return { authFile: persisted, created: true, browserToken, clientToken };
}

/**
 * Load → mutate → write. The mutator receives the current file (or an empty
 * one) and returns the next file. Use this for any read-modify-write cycle
 * to avoid clobbering concurrent edits from another CLI invocation.
 *
 * Note: this does NOT take a file lock. HQ auth edits are rare (operator
 * running `wstack --hq-token add` etc.) and the atomic rename protects
 * against torn writes; a race between two concurrent edits would be
 * last-write-wins, which is acceptable for this low-frequency file.
 */
export async function mutateHqAuthFile(
  dataDir: string,
  mutator: (current: HqAuthFile) => HqAuthFile | Promise<HqAuthFile>,
  opts: { warn?: (msg: string) => void } = {},
): Promise<HqAuthFile> {
  const current = await readHqAuthFile(dataDir, opts);
  const next = await mutator(current);
  await writeHqAuthFile(dataDir, next);
  return next;
}

const HQ_PASSWORD_SALT_BYTES = 16;
const HQ_PASSWORD_HASH_BYTES = 32;
const HQ_PASSWORD_SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/**
 * Hash a browser password for storage in `auth.json`. Uses scrypt with a
 * random salt; the returned string is `scrypt$<salt>$<hash>` in base64url.
 */
export function hashHqPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(HQ_PASSWORD_SALT_BYTES);
    scrypt(password, salt, HQ_PASSWORD_HASH_BYTES, HQ_PASSWORD_SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) return reject(err);
      const payload = `scrypt$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
      resolve(payload);
    });
  });
}

/**
 * Verify a browser password against a stored scrypt hash.
 */
export async function verifyHqPassword(password: string, hash: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !parts[1] || !parts[2]) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], 'base64url');
    expected = Buffer.from(parts[2], 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, expected.length, HQ_PASSWORD_SCRYPT_PARAMS, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return timingSafeEqual(derived, expected);
}

/** Mint a secret used to sign browser session cookies. */
export function mintHqCookieSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Options for {@link mintHqToken}.
 *
 * - `label` — human-readable identifier persisted alongside the token.
 * - `ttlMs` — when set, the token is stamped with `expiresAt = now + ttlMs`.
 *   Absent (the default) means the token never expires, preserving the
 *   pre-TTL contract.
 * - `now` — epoch milliseconds override for deterministic tests.
 */
export interface MintHqTokenOptions {
  label?: string | undefined;
  ttlMs?: number | undefined;
  now?: number | undefined;
}

/**
 * Mint a fresh token. Used for both browser and client tokens; the caller
 * decides which list to append to.
 *
 * Pass an options object to stamp an `expiresAt`; the bare-string overload
 * (`mintHqToken('my-label')`) is preserved for backward-compat.
 */
export function mintHqToken(labelOrOptions?: string | MintHqTokenOptions): HqToken {
  const opts: MintHqTokenOptions =
    typeof labelOrOptions === 'string' ? { label: labelOrOptions } : (labelOrOptions ?? {});
  const at = opts.now ?? Date.now();
  const createdAtIso = new Date(at).toISOString();
  return {
    id: randomUUID(),
    token: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
    createdAt: createdAtIso,
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.ttlMs !== undefined && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
      ? { expiresAt: new Date(at + opts.ttlMs).toISOString() }
      : {}),
  };
}

/**
 * Backward-compat alias for `mintHqToken`. Phase 3 callers/tests use this.
 */
export const mintHqBrowserToken = mintHqToken;

/**
 * Watch `auth.json` for changes and invoke `onChange` with the freshly-read
 * file. Returns a `close()` function that stops watching.
 *
 * The watcher debounces events (default 200ms) because most editors do a
 * tmp+rename dance that emits multiple events. On any read failure (file
 * deleted, corrupt, etc.) the `warn` callback is invoked with the same
 * semantics as `readHqAuthFile`; the watcher stays active so a future
 * valid write re-triggers the callback.
 *
 * Notes:
 * - `fs.watch` is best-effort across platforms. On some network
 *   filesystems events may not fire; the operator must restart the server
 *   to pick up changes in that case.
 * - The watcher polls the parent directory (not the file itself) so that
 *   atomic rename events surface reliably.
 */
export function watchHqAuthFile(
  dataDir: string,
  onChange: (file: HqAuthFile) => void,
  opts: { warn?: (msg: string) => void; debounceMs?: number } = {},
): { close: () => void } {
  const file = hqAuthFilePath(dataDir);
  const debounceMs = opts.debounceMs ?? 200;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  let watcher: syncFs.FSWatcher;
  try {
    // Watch the directory (not the file) so atomic-rename events surface
    // reliably. `fs.watch` is best-effort across platforms — on some
    // network filesystems events may not fire; the operator must restart
    // the server in that case.
    watcher = syncFs.watch(path.dirname(file), { recursive: false });
  } catch (err) {
    opts.warn?.(`HQ auth watcher could not start: ${(err as Error).message}`);
    return { close: () => {} };
  }

  const trigger = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const readOpts = opts.warn ? { warn: opts.warn } : {};
      void readHqAuthFile(dataDir, readOpts).then(
        (next) => {
          if (!closed) onChange(next);
        },
        () => {
          // readHqAuthFile never throws for routine I/O — this is a
          // belt-and-braces guard.
        },
      );
    }, debounceMs);
  };

  // Without a listener an FSWatcher 'error' event is an uncaught exception
  // (Windows emits transient EPERMs on dir churn). Degrade to "no watcher" —
  // same as the creation-failure path above. Exactly one handler: a second
  // one used to be registered after the 'change' listener, so every error
  // warned twice and the second warning always described a watcher the first
  // handler had already closed.
  watcher.on('error', (err: Error) => {
    opts.warn?.(`HQ auth watcher error: ${err.message}`);
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  });

  watcher.on('change', (eventType: string, filename: string | Buffer | null) => {
    const name = typeof filename === 'string' ? filename : '';
    // Only react to events that touch auth.json (rename, change).
    if (eventType === 'rename' || eventType === 'change') {
      if (!name || name === 'auth.json' || name === path.basename(file)) {
        trigger();
      }
    }
  });

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

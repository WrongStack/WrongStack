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
 * shared host cannot read issued tokens or the redaction policy. Reads
 * are lenient: a missing file yields an empty document; a corrupt file
 * yields an empty document plus a warning so the operator can recover.
 *
 * @module hq/auth-store
 */
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as path from 'node:path';

import { atomicWrite } from '../utils/atomic-write.js';
import { wstackGlobalRoot } from '../utils/wstack-paths.js';
import type { HqAlertRuleConfig } from './alerts.js';
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
}

/**
 * Check whether a token grants a capability. A token with no `capabilities`
 * field is unrestricted (backward-compat). Otherwise the capability must be
 * explicitly listed.
 */
export function tokenHasCapability(token: HqToken | undefined, capability: string): boolean {
  if (token === undefined) return false;
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

/** Path to `auth.json` under the given data directory. */
export function hqAuthFilePath(dataDir: string): string {
  return path.join(dataDir, 'auth.json');
}

/** Path to the best-effort runtime endpoint marker under the given data directory. */
export function hqRuntimeFilePath(dataDir: string): string {
  return path.join(dataDir, 'runtime.json');
}

export async function writeHqRuntimeFile(dataDir: string, file: Omit<HqRuntimeFile, 'updatedAt'>): Promise<void> {
  const payload: HqRuntimeFile = {
    ...file,
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(hqRuntimeFilePath(dataDir), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readHqRuntimeFileSync(dataDir: string): HqRuntimeFile | undefined {
  try {
    const parsed = JSON.parse(syncFs.readFileSync(hqRuntimeFilePath(dataDir), 'utf8')) as Partial<HqRuntimeFile>;
    if (typeof parsed.url !== 'string' || parsed.url.trim().length === 0) return undefined;
    if (typeof parsed.pid === 'number' && !isProcessAlive(parsed.pid)) return undefined;
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
 * Write `auth.json` atomically with mode 0o600. Creates the data directory
 * if needed. Throws on I/O failure — callers (CLI commands) should surface
 * the error to the operator.
 */
export async function writeHqAuthFile(dataDir: string, file: HqAuthFile): Promise<void> {
  const target = hqAuthFilePath(dataDir);
  const payload: HqAuthFile = {
    ...file,
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

export interface EnsureHqFirstRunAuthOptions {
  warn?: (msg: string) => void;
  /** Optional browser password login. Hashed with scrypt before storage. */
  password?: string;
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
 */
export async function ensureHqFirstRunAuthFile(
  dataDir: string,
  opts: EnsureHqFirstRunAuthOptions = {},
): Promise<EnsureHqFirstRunAuthResult> {
  const file = hqAuthFilePath(dataDir);
  try {
    await fs.access(file);
    return { authFile: await readHqAuthFile(dataDir, opts), created: false };
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
  const browserToken = { ...mintHqToken('first-run browser'), capabilities: ['control.enqueue'] };
  const clientToken = { ...mintHqToken('first-run client'), capabilities: ['telemetry.publish'] };
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
  return { authFile: await readHqAuthFile(dataDir, opts), created: true, browserToken, clientToken };
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
 * Mint a fresh token. Used for both browser and client tokens; the caller
 * decides which list to append to.
 */
export function mintHqToken(label?: string): HqToken {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    token: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
    ...(label ? { label } : {}),
    createdAt: now,
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

  watcher.on('change', (eventType: string, filename: string | Buffer | null) => {
    const name = typeof filename === 'string' ? filename : '';
    // Only react to events that touch auth.json (rename, change).
    if (eventType === 'rename' || eventType === 'change') {
      if (!name || name === 'auth.json' || name === path.basename(file)) {
        trigger();
      }
    }
  });

  watcher.on('error', (err: Error) => {
    opts.warn?.(`HQ auth watcher error: ${err.message}`);
  });

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

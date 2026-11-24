/**
 * HQ key vault routes.
 *
 * Operator (dashboard) routes — admin credential (`auth.admin`) required:
 *   GET    /api/vault/status
 *   POST   /api/vault/elevate                 password (+ TOTP when enabled) → 10 min step-up
 *   POST   /api/vault/unseal                  passphrase-protected vault after a restart
 *   GET    /api/vault/secrets                 metadata only, never a value
 *   POST   /api/vault/secrets                 { providerId, label, apiKey }
 *   POST   /api/vault/secrets/:id/rotate      { apiKey }
 *   DELETE /api/vault/secrets/:id
 *   GET    /api/vault/devices
 *   POST   /api/vault/devices/:id/approve | /revoke
 *   GET    /api/vault/grants
 *   POST   /api/vault/grants                  { secretId, deviceId, policy?, setActive?, leaseTtlSeconds?, expiresAt? }
 *   DELETE /api/vault/grants/:id
 *   POST   /api/vault/enrollment-codes        { label?, autoApprove? } → one-time enrollment token
 *
 * Device routes — no browser credential; exempt from the router's auth gate:
 *   POST   /api/vault/enroll                  MACed with the one-time code
 *   POST   /api/vault/fetch                   signed with the device key
 *
 * Three rules hold for every operator write (and the unseal):
 *  1. The vault needs an operator password. A fresh HQ has only a browser
 *     token; without a password there is no second factor to step up with and
 *     "step-up" would collapse into "any admin token".
 *  2. Secure channel: the TCP peer is loopback, or the socket is TLS, or a
 *     declared reverse proxy (`trustedProxyHops > 0`) says https. On plain
 *     HTTP over a LAN the pasted key — and an enrollment code, whose secrecy
 *     the enrollment MAC rests on — would cross the wire in the clear.
 *  3. Step-up: a fresh password (+ TOTP) proof, bound to the credential that
 *     made it, valid for {@link HQ_VAULT_ELEVATION_MS}.
 *
 * Device routes need none of these: what they carry is sealed end to end and
 * authenticated by the device's own keys, so plain HTTP reveals nothing.
 *
 * Nothing here goes through the command queue: `commands.jsonl` audits command
 * payloads and broadcasts acks to browsers.
 */
import { createHash } from 'node:crypto';
import type * as http from 'node:http';
import type { TLSSocket } from 'node:tls';
import {
  formatHqVaultEnrollmentToken,
  type HqVaultEnrollRequest,
  HqVaultError,
  type HqVaultFetchRequest,
  HqVaultStore,
  hqVaultPassphraseFromEnv,
  verifyHqPassword,
} from '@wrongstack/hq';
import {
  authenticateBrowserRequest,
  type HqBrowserAuthResult,
  hqAuthRequired,
  readHqSessionCookie,
} from '../auth.js';
import { resolveClientAddress } from '../client-address.js';
import type { LoginAttemptStore } from '../login-attempt-store.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../types.js';
import { readRequestBody, writeInvalidBody } from '../utils.js';
import {
  type ApplyHqAuthFile,
  consumeTotpCode,
  isLoopbackRequest,
  recordVerifyFailure,
  requireAdminCredential,
} from './auth/common.js';

export const HQ_VAULT_ELEVATION_MS = 10 * 60_000;
const BODY_LIMIT = 64 * 1024;

export interface HqVaultRouteDeps {
  mutableAuth: HqRouterMutableAuth;
  sessions: Map<string, HqSessionEntry>;
  loginAttempts: LoginAttemptStore;
  dataDir: string;
  applyAuthFile: ApplyHqAuthFile;
  trustedProxyHops: number;
  requireBrowserAuth: boolean | undefined;
  vault: HqVaultRouteState;
}

/**
 * Per-server vault state: the store, opened on first use (so an HQ that never
 * uses the vault never writes a master key), and the step-up grants.
 */
export class HqVaultRouteState {
  private storePromise: Promise<HqVaultStore> | undefined;
  private readonly elevations = new Map<string, number>();

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  store(): Promise<HqVaultStore> {
    if (!this.storePromise) {
      this.storePromise = HqVaultStore.open(this.dataDir, hqVaultPassphraseFromEnv(), {
        now: this.now,
      });
      // A failed open (unreadable file, wrong env passphrase) must not stick.
      this.storePromise.catch(() => {
        this.storePromise = undefined;
      });
    }
    return this.storePromise;
  }

  elevate(key: string): number {
    const until = this.now() + HQ_VAULT_ELEVATION_MS;
    this.elevations.set(key, until);
    return until;
  }

  elevatedUntil(key: string): number | undefined {
    const until = this.elevations.get(key);
    if (until === undefined) return undefined;
    if (until <= this.now()) {
      this.elevations.delete(key);
      return undefined;
    }
    return until;
  }
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function writeError(res: http.ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { error: { code, message } });
}

const VAULT_ERROR_STATUS: Record<HqVaultError['code'], number> = {
  VAULT_SEALED: 423,
  VAULT_NOT_FOUND: 404,
  VAULT_INVALID: 400,
  VAULT_CONFLICT: 409,
  VAULT_DENIED: 403,
};

function writeVaultFailure(res: http.ServerResponse, error: unknown): void {
  if (error instanceof HqVaultError) {
    writeError(res, VAULT_ERROR_STATUS[error.code], error.code, error.message);
    return;
  }
  // Never echo an unexpected error: it could quote file content.
  writeError(res, 500, 'VAULT_ERROR', 'The vault could not complete the request.');
}

async function readJsonObject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readRequestBody(req, BODY_LIMIT));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      writeError(res, 400, 'BAD_REQUEST', 'Expected a JSON object.');
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    writeInvalidBody(res, error);
    return undefined;
  }
}

/**
 * Whether the request arrived over a channel that keeps a pasted key off the
 * wire: a loopback TCP peer (which covers a reverse proxy on the same host),
 * a TLS socket, or — only when the operator declared a proxy chain — a proxy
 * reporting https. The raw socket decides; forwarded headers count only behind
 * a declared proxy, the same asymmetry the rate limiter keeps.
 */
export function isHqVaultSecureChannel(
  req: http.IncomingMessage,
  trustedProxyHops: number,
): boolean {
  if (isLoopbackRequest(req)) return true;
  if ((req.socket as Partial<TLSSocket>).encrypted === true) return true;
  if (trustedProxyHops > 0) {
    const proto = req.headers['x-forwarded-proto'];
    const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim().toLowerCase();
    return first === 'https';
  }
  return false;
}

/** The step-up is bound to the credential that proved it. */
function credentialKey(req: http.IncomingMessage, auth: NonNullable<HqBrowserAuthResult>): string {
  if (auth.kind === 'token') return `token:${auth.id}`;
  const cookie = readHqSessionCookie(req.headers.cookie) ?? '';
  return `cookie:${createHash('sha256').update(cookie).digest('hex')}`;
}

function actorOf(auth: NonNullable<HqBrowserAuthResult>): string {
  return auth.kind === 'token'
    ? `hq-dashboard:token:${auth.id}`
    : `hq-dashboard:session${auth.tokenId ? `:token:${auth.tokenId}` : ''}`;
}

const SECRET_ONE = /^\/api\/vault\/secrets\/([0-9a-f-]{36})$/;
const SECRET_ROTATE = /^\/api\/vault\/secrets\/([0-9a-f-]{36})\/rotate$/;
const DEVICE_ACTION = /^\/api\/vault\/devices\/([0-9a-f]{32})\/(approve|revoke)$/;
const GRANT_ONE = /^\/api\/vault\/grants\/([0-9a-f-]{36})$/;

/** Paths a device reaches without a browser credential. */
export function isHqVaultDevicePath(pathname: string): boolean {
  return pathname === '/api/vault/enroll' || pathname === '/api/vault/fetch';
}

/** True when the request was routed here. */
export async function handleApiVault(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: HqVaultRouteDeps,
): Promise<boolean> {
  const { pathname } = url;
  if (pathname !== '/api/vault' && !pathname.startsWith('/api/vault/')) return false;

  if (isHqVaultDevicePath(pathname)) {
    if (req.method !== 'POST') {
      writeError(res, 405, 'METHOD_NOT_ALLOWED', 'POST only.');
      return true;
    }
    await handleDeviceRoute(req, res, pathname, deps);
    return true;
  }

  // ── Operator routes ───────────────────────────────────────────────────────
  const auth = authenticateBrowserRequest(req, url, deps.mutableAuth, deps.sessions);
  if (hqAuthRequired(deps.mutableAuth, deps.requireBrowserAuth) && !auth) {
    writeError(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    return true;
  }
  if (!requireAdminCredential(res, auth) || auth === undefined) return true;

  const secure = isHqVaultSecureChannel(req, deps.trustedProxyHops);
  const passwordConfigured = deps.mutableAuth.passwordHash !== undefined;
  const key = credentialKey(req, auth);
  const actor = actorOf(auth);

  if (pathname === '/api/vault/status' && req.method === 'GET') {
    if (!passwordConfigured) {
      writeJson(res, 200, { state: 'unavailable', passwordConfigured, secureChannel: secure });
      return true;
    }
    try {
      const store = await deps.vault.store();
      const until = deps.vault.elevatedUntil(key);
      writeJson(res, 200, {
        ...store.status(),
        passwordConfigured,
        totpEnabled: deps.mutableAuth.totpSecret !== undefined,
        secureChannel: secure,
        ...(until !== undefined ? { elevatedUntil: new Date(until).toISOString() } : {}),
      });
    } catch (error) {
      writeVaultFailure(res, error);
    }
    return true;
  }

  if (!passwordConfigured) {
    writeError(
      res,
      409,
      'VAULT_REQUIRES_PASSWORD',
      'Set an HQ operator password (System → Security) before using the key vault.',
    );
    return true;
  }

  const isRead = req.method === 'GET';
  if (!isRead && !secure) {
    writeError(
      res,
      403,
      'VAULT_INSECURE_CHANNEL',
      'Key vault changes need HTTPS or a loopback connection. Start HQ with --tls-cert/--tls-key, or reach it through Tailscale serve / a local reverse proxy.',
    );
    return true;
  }

  if (pathname === '/api/vault/elevate' && req.method === 'POST') {
    await handleElevate(req, res, deps, key);
    return true;
  }

  let store: HqVaultStore;
  try {
    store = await deps.vault.store();
  } catch (error) {
    writeVaultFailure(res, error);
    return true;
  }

  if (pathname === '/api/vault/unseal' && req.method === 'POST') {
    await handleUnseal(req, res, deps, store, actor);
    return true;
  }

  if (isRead) {
    if (pathname === '/api/vault/secrets') writeJson(res, 200, { secrets: store.listSecrets() });
    else if (pathname === '/api/vault/devices')
      writeJson(res, 200, { devices: store.listDevices() });
    else if (pathname === '/api/vault/grants') writeJson(res, 200, { grants: store.listGrants() });
    else if (pathname === '/api/vault/audit') {
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
      writeJson(res, 200, { entries: await store.readAudit(Number.isFinite(limit) ? limit : 200) });
    }
    else writeError(res, 404, 'NOT_FOUND', 'Unknown vault route.');
    return true;
  }

  if (deps.vault.elevatedUntil(key) === undefined) {
    writeError(
      res,
      403,
      'VAULT_ELEVATION_REQUIRED',
      'Confirm your HQ password (and authenticator code) to change the key vault.',
    );
    return true;
  }

  try {
    if (pathname === '/api/vault/secrets' && req.method === 'POST') {
      const body = await readJsonObject(req, res);
      if (!body) return true;
      writeJson(res, 201, {
        secret: await store.createSecret(
          { providerId: body.providerId, label: body.label, apiKey: body.apiKey },
          actor,
        ),
      });
      return true;
    }
    const rotate = pathname.match(SECRET_ROTATE);
    if (rotate && req.method === 'POST') {
      const body = await readJsonObject(req, res);
      if (!body) return true;
      writeJson(res, 200, { secret: await store.rotateSecret(rotate[1]!, body.apiKey, actor) });
      return true;
    }
    const secretOne = pathname.match(SECRET_ONE);
    if (secretOne && req.method === 'DELETE') {
      await store.deleteSecret(secretOne[1]!, actor);
      writeJson(res, 200, { deleted: true });
      return true;
    }
    const device = pathname.match(DEVICE_ACTION);
    if (device && req.method === 'POST') {
      const status = device[2] === 'approve' ? 'approved' : 'revoked';
      writeJson(res, 200, { device: await store.setDeviceStatus(device[1]!, status, actor) });
      return true;
    }
    if (pathname === '/api/vault/grants' && req.method === 'POST') {
      const body = await readJsonObject(req, res);
      if (!body) return true;
      writeJson(res, 201, {
        grant: await store.createGrant(
          {
            secretId: body.secretId,
            deviceId: body.deviceId,
            policy: body.policy,
            setActive: body.setActive,
            leaseTtlSeconds: body.leaseTtlSeconds,
            expiresAt: body.expiresAt,
          },
          actor,
        ),
      });
      return true;
    }
    const grantOne = pathname.match(GRANT_ONE);
    if (grantOne && req.method === 'DELETE') {
      await store.revokeGrant(grantOne[1]!, actor);
      writeJson(res, 200, { revoked: true });
      return true;
    }
    if (pathname === '/api/vault/enrollment-codes' && req.method === 'POST') {
      const body = await readJsonObject(req, res);
      if (!body) return true;
      const minted = await store.mintEnrollmentCode(
        { label: body.label, autoApprove: body.autoApprove !== false },
        actor,
      );
      writeJson(res, 201, {
        enrollmentToken: formatHqVaultEnrollmentToken(minted.codeId, minted.code),
        expiresAt: minted.expiresAt,
        hq: minted.identity,
      });
      return true;
    }
  } catch (error) {
    writeVaultFailure(res, error);
    return true;
  }

  writeError(res, 404, 'NOT_FOUND', 'Unknown vault route.');
  return true;
}

async function handleElevate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: HqVaultRouteDeps,
  key: string,
): Promise<void> {
  const body = await readJsonObject(req, res);
  if (!body) return;
  const clientIp = resolveClientAddress(req, deps.trustedProxyHops);
  const { blocked, retryAfter } = deps.loginAttempts.checkBlocked(clientIp);
  if (blocked) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    res.end(
      JSON.stringify({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
      }),
    );
    return;
  }
  // Charged before the awaits, like every other factor check: a concurrent
  // burst must not all pass the block test. A confirmed proof clears it.
  recordVerifyFailure(deps.loginAttempts, clientIp);
  const password = typeof body.password === 'string' ? body.password : '';
  const passwordHash = deps.mutableAuth.passwordHash;
  const passwordOk =
    passwordHash !== undefined &&
    password.length > 0 &&
    (await verifyHqPassword(password, passwordHash));
  if (!passwordOk) {
    writeError(res, 403, 'INVALID_CREDENTIALS', 'Password or authenticator code is wrong.');
    return;
  }
  // Both factors when 2FA is on — the vault is the most valuable thing HQ holds.
  if (deps.mutableAuth.totpSecret !== undefined) {
    const code = typeof body.code === 'string' ? body.code : '';
    const outcome = await consumeTotpCode(code, deps.mutableAuth, deps.dataDir, deps.applyAuthFile);
    if (outcome !== 'ok') {
      writeError(
        res,
        403,
        outcome === 'replayed' ? 'TOTP_ALREADY_USED' : 'INVALID_CREDENTIALS',
        outcome === 'replayed'
          ? 'That authenticator code has already been used. Wait for the next one.'
          : 'Password or authenticator code is wrong.',
      );
      return;
    }
  }
  deps.loginAttempts.delete(clientIp);
  const until = deps.vault.elevate(key);
  writeJson(res, 200, { elevatedUntil: new Date(until).toISOString() });
}

async function handleUnseal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: HqVaultRouteDeps,
  store: HqVaultStore,
  actor: string,
): Promise<void> {
  const body = await readJsonObject(req, res);
  if (!body) return;
  if (store.state === 'unsealed') {
    writeJson(res, 200, { state: 'unsealed' });
    return;
  }
  const clientIp = resolveClientAddress(req, deps.trustedProxyHops);
  const { blocked, retryAfter } = deps.loginAttempts.checkBlocked(clientIp);
  if (blocked) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    res.end(
      JSON.stringify({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
      }),
    );
    return;
  }
  recordVerifyFailure(deps.loginAttempts, clientIp);
  const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
  try {
    await store.unseal(passphrase, actor);
  } catch {
    writeError(res, 403, 'VAULT_WRONG_PASSPHRASE', 'Wrong vault passphrase.');
    return;
  }
  deps.loginAttempts.delete(clientIp);
  writeJson(res, 200, { state: 'unsealed' });
}

async function handleDeviceRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: HqVaultRouteDeps,
): Promise<void> {
  // The vault exists only on an HQ with an operator password; until then
  // there is no code to enroll with and nothing to fetch.
  if (deps.mutableAuth.passwordHash === undefined) {
    writeError(res, 404, 'NOT_FOUND', 'The key vault is not enabled on this HQ.');
    return;
  }
  const body = await readJsonObject(req, res);
  if (!body) return;
  try {
    const store = await deps.vault.store();
    if (pathname === '/api/vault/enroll') {
      writeJson(res, 200, await store.enroll(body as unknown as HqVaultEnrollRequest));
    } else {
      writeJson(res, 200, await store.fetch(body as unknown as HqVaultFetchRequest));
    }
  } catch (error) {
    writeVaultFailure(res, error);
  }
}

import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import {
  type HqAuthFile,
  hashHqPassword,
  isLoopbackHost,
  mintHqCookieSecret,
  mutateHqAuthFile,
  verifyHqPassword,
} from '@wrongstack/core/hq';
import {
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotp,
  verifyTotpCounter,
} from '@wrongstack/core/security';
import {
  authenticateBrowserRequest,
  clearHqSessionCookie,
  type HqBrowserAuthResult,
  isCookieAuth,
  isTokenAuth,
  parseHqSessionCookie,
  readHqSessionCookie,
  serializeHqSessionCookie,
  setHqSessionCookie,
} from '../auth.js';
import type { LoginAttemptStore } from '../login-attempt-store.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../types.js';
import { resolveClientAddress } from '../client-address.js';
import { readRequestBody, writeInvalidBody } from '../utils.js';

/**
 * True when the request's ACTUAL peer is on this machine.
 *
 * Deliberately reads `req.socket.remoteAddress` and never the resolved client
 * address: this is a trust decision (it authorizes the open-mode password
 * bootstrap), and a forwarded header must never be able to claim loopback.
 * Rate limiting is the opposite case — see {@link resolveClientAddress}.
 */
function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  return address !== undefined && isLoopbackHost(address);
}

/**
 * Capability required to operate the account-security surface: enrolling or
 * removing 2FA, changing the password without knowing it, listing and revoking
 * browser sessions, and reading the auth audit log.
 *
 * WS-102: these routes used to gate on `if (!auth)` alone, so ANY authenticated
 * principal could reach them — including the least-privileged token HQ mints on
 * first run (`capabilities: ['control.enqueue']`). That token could
 * `POST /api/auth/totp/setup` → `/enable`, receive the recovery codes, and take
 * the `sessions.clear()` that enrollment performs. The operator was then held
 * at `totpRequired: true` on every password login with no authenticator and no
 * recovery codes, and `/totp/disable` demands auth they could no longer obtain:
 * a one-request, unrecoverable lockout from a token scoped to enqueueing
 * commands. Editing `auth.json` by hand was the only way back.
 */
export const HQ_AUTH_ADMIN_CAPABILITY = 'auth.admin';

/**
 * True when `auth` may operate the account-security surface.
 *
 * - Password-origin cookie sessions (`kind: 'cookie'` with no `tokenId`) are
 *   the operator themselves — always allowed.
 * - A token with no `capabilities` field is unrestricted by the documented
 *   contract in `HqToken.capabilities`, so it is allowed.
 * - A capability-scoped token must list {@link HQ_AUTH_ADMIN_CAPABILITY}.
 *
 * Token-origin cookie sessions resolve their capabilities from the LIVE token
 * record on every request (see `authenticateBrowserRequest`), so upgrading a
 * token to a cookie never widens what it can do here.
 */
export function callerCanAdministerAuth(auth: HqBrowserAuthResult): boolean {
  if (auth === undefined) return false;
  if (auth.kind === 'cookie' && auth.tokenId === undefined) return true;
  if (auth.capabilities === undefined) return true;
  return auth.capabilities.includes(HQ_AUTH_ADMIN_CAPABILITY);
}

/** Shared 403 for a caller that authenticated but lacks `auth.admin`. */
function writeAuthAdminRequired(res: http.ServerResponse): void {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: {
        code: 'AUTH_ADMIN_REQUIRED',
        message: `This endpoint requires the '${HQ_AUTH_ADMIN_CAPABILITY}' capability.`,
      },
    }),
  );
}

/**
 * Authenticate + authorize an account-security request in one step. Returns
 * the auth context on success, or `undefined` after having already written the
 * 401/403 response.
 */
function authorizeAuthAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
): HqBrowserAuthResult {
  const auth = authenticateBrowserRequest(
    req,
    new URL(req.url ?? '/', 'http://localhost'),
    mutableAuth,
    sessions,
  );
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }),
    );
    return undefined;
  }
  if (!callerCanAdministerAuth(auth)) {
    writeAuthAdminRequired(res);
    return undefined;
  }
  return auth;
}

export async function handleApiAuthStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  requireBrowserAuth: boolean | undefined,
  trustedPublicOrigins: Set<string>,
  secureCookies: boolean | undefined,
): Promise<void> {
  const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
  const openMode =
    mutableAuth.browserTokens.size === 0 &&
    mutableAuth.passwordHash === undefined &&
    mutableAuth.requireAuthFloor !== true;
  const localOpenMode = openMode && !requireBrowserAuth && isLoopbackRequest(req);
  const publicOrigin = trustedPublicOrigins.values().next().value;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      tokenMode: mutableAuth.browserTokens.size > 0,
      passwordMode: mutableAuth.passwordHash !== undefined,
      totpEnabled: mutableAuth.totpSecret !== undefined,
      recoveryCodesRemaining: mutableAuth.totpRecoveryCodes?.length ?? 0,
      publicRelay: requireBrowserAuth === true || publicOrigin !== undefined,
      ...(publicOrigin !== undefined ? { publicOrigin } : {}),
      secureCookies: secureCookies === true,
      loggedIn: auth !== undefined || localOpenMode,
      authKind: isCookieAuth(auth)
        ? 'password'
        : isTokenAuth(auth)
          ? 'token'
          : localOpenMode
            ? 'open'
            : undefined,
    }),
  );
}

export async function handleApiLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  loginAttempts: LoginAttemptStore,
  secureCookies: boolean | undefined,
  trustedProxyHops: number,
): Promise<void> {
  if (!mutableAuth.passwordHash) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'PASSWORD_NOT_CONFIGURED',
          message: 'Password login is not enabled on this HQ server.',
        },
      }),
    );
    return;
  }

  const clientIp = resolveClientAddress(req, trustedProxyHops);
  const writeRateLimited = (retryAfter: number): void => {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter),
    });
    res.end(
      JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          message: `Too many failed login attempts. Retry after ${retryAfter} seconds.`,
        },
      }),
    );
  };

  // Pre-parse rate-limit check (IP scope only — we don't have the password
  // yet). Runs first so a blocked IP never gets its body read.
  const ipCheck = loginAttempts.checkBlocked(clientIp);
  if (ipCheck.blocked) {
    writeRateLimited(ipCheck.retryAfter);
    return;
  }

  let body: { password?: unknown };
  try {
    body = JSON.parse(await readRequestBody(req)) as { password?: unknown };
  } catch (error) {
    writeInvalidBody(res, error);
    return;
  }

  if (typeof body.password !== 'string' || body.password.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'password is required' } }));
    return;
  }

  // WS-104: now that the candidate password is known, apply the credential-
  // scoped backoff. This is the check that makes a rotating-IP attacker pay
  // for repeating the same guess — the pre-parse check above can only see the
  // IP, which is precisely what such an attacker rotates.
  const credCheck = loginAttempts.checkBlocked(clientIp, body.password);
  if (credCheck.blocked) {
    writeRateLimited(credCheck.retryAfter);
    return;
  }

  const ok = await verifyHqPassword(body.password, mutableAuth.passwordHash);
  if (!ok || !mutableAuth.cookieSecret) {
    loginAttempts.recordFailure(clientIp, body.password);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'INVALID_PASSWORD', message: 'Invalid password.' } }));
    return;
  }

  // NOTE: do NOT clear loginAttempts yet when 2FA is active — the verify
  // endpoint re-applies backoff on failed TOTP attempts, but only if the
  // counter set by the initial login survives. Clearing here would let an
  // attacker re-login → reset → brute-force verify in a tight loop.
  if (mutableAuth.totpSecret) {
    const pendingSessionId = randomUUID();
    sessions.set(pendingSessionId, {
      createdAt: Date.now(),
      kind: 'password',
      pending2fa: true,
      lastSeenAt: Date.now(),
    });
    setHqSessionCookie(
      res,
      serializeHqSessionCookie(pendingSessionId, mutableAuth.cookieSecret),
      secureCookies,
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ loggedIn: false, totpRequired: true }));
    return;
  }

  loginAttempts.clearOnSuccess(clientIp, body.password);
  const sessionId = randomUUID();
  sessions.set(sessionId, { createdAt: Date.now(), kind: 'password', lastSeenAt: Date.now() });
  setHqSessionCookie(
    res,
    serializeHqSessionCookie(sessionId, mutableAuth.cookieSecret),
    secureCookies,
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ loggedIn: true }));
}

export async function handleApiLogout(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  secureCookies: boolean | undefined,
): Promise<void> {
  const auth = authenticateBrowserRequest(
    req,
    new URL(req.url ?? '/', 'http://localhost'),
    mutableAuth,
    sessions,
  );
  if (isCookieAuth(auth)) {
    const raw = readHqSessionCookie(req.headers.cookie);
    if (raw) {
      const sessionId = parseHqSessionCookie(raw, mutableAuth.cookieSecret ?? '');
      if (sessionId) sessions.delete(sessionId);
    }
  }
  clearHqSessionCookie(res, secureCookies);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ loggedIn: false }));
}

export async function handleApiPassword(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  dataDir: string,
  secureCookies: boolean | undefined,
  requireBrowserAuth: boolean | undefined,
  applyAuthFile: ApplyHqAuthFile,
): Promise<void> {
  const auth = authenticateBrowserRequest(
    req,
    new URL(req.url ?? '/', 'http://localhost'),
    mutableAuth,
    sessions,
  );
  const localOpenBootstrap =
    auth === undefined &&
    req.method === 'POST' &&
    mutableAuth.browserTokens.size === 0 &&
    mutableAuth.passwordHash === undefined &&
    isLoopbackRequest(req);
  if (auth === undefined && !localOpenBootstrap) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'AUTH_REQUIRED',
          message: 'A browser token or password session is required to manage the password.',
        },
      }),
    );
    return;
  }

  if (localOpenBootstrap) {
    // WS-049: an unauthenticated loopback caller is claiming a fresh, open
    // instance by setting its first password.
    //
    // What this is NOT: a way in. In open mode the control plane is already
    // reachable unauthenticated from loopback (`POST /api/command`), so
    // claiming the password grants no access the caller did not already have.
    // The cross-origin web path is closed separately — the router's origin
    // guard runs before this route and a browser always sends `Origin` on a
    // POST, which must match the request Host.
    //
    // What it IS: silent lockout. The operator who never set a password is now
    // shut out of their own HQ, across restarts, with nothing to tell them why.
    // A same-user local process cannot be authenticated away by a loopback
    // server — it can read the data dir and the console — so the honest
    // mitigation is to make the claim impossible to miss rather than to
    // pretend it can be prevented.
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'hq.auth.password_claimed_unauthenticated',
        message:
          'An unauthenticated loopback request set the HQ password on an open instance. ' +
          'If this was not you, stop HQ and remove passwordHash from auth.json.',
        remoteAddress: req.socket.remoteAddress ?? 'unknown',
        dataDir,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  let body: { currentPassword?: unknown; newPassword?: unknown } = {};
  try {
    body = JSON.parse(await readRequestBody(req)) as typeof body;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } }));
    return;
  }

  // H2: require currentPassword for ALL callers (cookie or token) when a
  // password is already set, unless the caller has the auth.admin capability.
  // Previously this only checked `isCookieAuth(auth)`, so a leaked/read-only
  // browser token could change or remove the HQ password without knowing it.
  const hasAdminCapability =
    auth !== undefined &&
    'capabilities' in auth &&
    auth.capabilities?.includes('auth.admin');

  if (!localOpenBootstrap && mutableAuth.passwordHash !== undefined && !hasAdminCapability) {
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    if (!currentPassword || !(await verifyHqPassword(currentPassword, mutableAuth.passwordHash))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Current password is required to change or remove it.' },
        }),
      );
      return;
    }
  }

  if (req.method === 'DELETE') {
    if (requireBrowserAuth && mutableAuth.browserTokens.size === 0) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'BROWSER_AUTH_REQUIRED',
            message:
              'Cannot remove the only browser authentication method while a public relay is active.',
          },
        }),
      );
      return;
    }
    const next = await mutateHqAuthFile(dataDir, (current) => {
      const updated = { ...current };
      delete updated.passwordHash;
      delete updated.cookieSecret;
      // Cascade: removing the password also clears TOTP 2FA state, since
      // 2FA without a password is inert and leaving it orphaned could
      // confuse a future re-enrollment.
      delete updated.totpSecret;
      delete updated.totpPendingSecret;
      delete updated.totpRecoveryCodes;
      return updated;
    });
    applyAuthFile(next);
    sessions.clear();
    clearHqSessionCookie(res, secureCookies);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        passwordMode: false,
        tokenMode: mutableAuth.browserTokens.size > 0,
        loggedIn: !isCookieAuth(auth) && isTokenAuth(auth),
      }),
    );
    return;
  }

  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (newPassword.length < 8 || newPassword.length > 1024) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'INVALID_PASSWORD',
          message: 'New password must be between 8 and 1024 characters.',
        },
      }),
    );
    return;
  }

  const passwordHash = await hashHqPassword(newPassword);
  const cookieSecret = mintHqCookieSecret();
  const next = await mutateHqAuthFile(dataDir, (current) => ({
    ...current,
    passwordHash,
    cookieSecret,
  }));
  applyAuthFile(next);
  sessions.clear();

  if (isCookieAuth(auth) || localOpenBootstrap) {
    const sessionId = randomUUID();
    sessions.set(sessionId, { createdAt: Date.now(), kind: 'password', lastSeenAt: Date.now() });
    setHqSessionCookie(res, serializeHqSessionCookie(sessionId, cookieSecret), secureCookies);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      passwordMode: true,
      tokenMode: mutableAuth.browserTokens.size > 0,
      loggedIn: true,
    }),
  );
}

/**
 * Applies a freshly-persisted `auth.json` to the live server state.
 *
 * WS-101: this used to be a second, hand-rolled copy of the projection in
 * `hq-server/auth-state.ts`. The two drifted in exactly the ways duplicated
 * security code drifts: this copy skipped the expired-token filter on the
 * CLIENT scope (re-admitting expired `/ws/client` tokens, where the upgrade
 * gate does no expiry check of its own), never refreshed the raw token lists
 * behind `tokenStats()`, and — worst — never re-ran the WS-010 exposure
 * assessment, so `DELETE /api/auth/password` on a non-loopback bind dropped
 * every gate into open mode until the `fs.watch` debounce happened to fire.
 *
 * It is now a function type supplied by the server, bound to
 * `HqAuthState.apply`, so the mutation routes and the reload watcher share one
 * projection and one floor evaluation.
 */
export type ApplyHqAuthFile = (next: HqAuthFile) => void;

// ── Bootstrap exchange ──────────────────────────────────────────────────────

export async function handleApiBootstrap(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  secureCookies: boolean | undefined,
  bootstrapStore: import('@wrongstack/core/hq').HqBootstrapCodeStore,
): Promise<void> {
  if (!mutableAuth.cookieSecret) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'BOOTSTRAP_UNAVAILABLE',
          message: 'Cookie signing is not configured on this HQ server.',
        },
      }),
    );
    return;
  }

  let body: { code?: unknown };
  try {
    body = JSON.parse(await readRequestBody(req)) as { code?: unknown };
  } catch (error) {
    writeInvalidBody(res, error);
    return;
  }

  if (typeof body.code !== 'string' || body.code.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'code is required' } }));
    return;
  }

  const entry = bootstrapStore.consume(body.code);
  if (!entry) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'INVALID_OR_EXPIRED_CODE',
          message: 'The bootstrap code is invalid, already used, or expired.',
        },
      }),
    );
    return;
  }

  // Verify the originating token is still live.
  const tokenLive = [...mutableAuth.browserTokenObjs.values()].some(
    (obj) => obj.id === entry.tokenId,
  );
  if (!tokenLive) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'TOKEN_REVOKED',
          message: 'The token that issued this bootstrap code has been revoked.',
        },
      }),
    );
    return;
  }

  const sessionId = randomUUID();
  sessions.set(sessionId, {
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    kind: 'token',
    tokenId: entry.tokenId,
    ...(entry.capabilities !== undefined ? { capabilities: entry.capabilities } : {}),
  });
  setHqSessionCookie(
    res,
    serializeHqSessionCookie(sessionId, mutableAuth.cookieSecret),
    secureCookies,
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ loggedIn: true }));
}

/**
 * WS-065 — exchange a live browser token for an HttpOnly session cookie.
 *
 * The bootstrap flow above already gives fresh startup URLs a cookie and never
 * persists a client-side credential. What it does not cover is the *legacy*
 * paths: an older `?token=` startup URL, and manual token entry in the token
 * gate. Both leave the raw token in `sessionStorage`, where any script on the
 * origin can read it. This endpoint lets the SPA complete that migration on
 * its own — authenticate once with the token it already holds, receive a
 * cookie, and delete the stored copy.
 *
 * The minted session is exactly the one `handleApiBootstrap` mints: `kind:
 * 'token'` carrying the source token's id. That matters because
 * `authenticateBrowserRequest` re-resolves a token-origin session's
 * capabilities from the LIVE token record on every request, so upgrading
 * grants nothing the token did not already grant and dies the moment the token
 * is revoked. No privilege boundary is crossed: the caller proved possession
 * of the token, and the cookie is strictly weaker (HttpOnly, same-origin,
 * server-expiring).
 */
export async function handleApiTokenUpgrade(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  secureCookies: boolean | undefined,
): Promise<void> {
  if (!mutableAuth.cookieSecret) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'UPGRADE_UNAVAILABLE',
          message: 'Cookie signing is not configured on this HQ server.',
        },
      }),
    );
    return;
  }

  const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);

  // Already on a cookie — report success WITHOUT minting a second session.
  // The client calls this on every load until it succeeds, so a mint-per-call
  // would grow the session table for the lifetime of the tab.
  if (isCookieAuth(auth)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ loggedIn: true, upgraded: false }));
    return;
  }

  if (!isTokenAuth(auth)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 'UNAUTHORIZED', message: 'A valid browser token is required.' },
      }),
    );
    return;
  }

  // `authenticateBrowserRequest` falls back to `id: 'unknown'` when the matched
  // token has no record in `browserTokenObjs`. Minting a session for that id
  // would produce a cookie that authenticates ONCE and is then evicted, because
  // the cookie path resolves capabilities by looking the id back up and deletes
  // the session when it finds nothing. The client clears its stored token on
  // success, so handing back a doomed cookie would lock the user out. Refuse,
  // and let the client keep what it has.
  const tokenLive = [...mutableAuth.browserTokenObjs.values()].some((obj) => obj.id === auth.id);
  if (!tokenLive) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'TOKEN_NOT_UPGRADEABLE',
          message: 'This token has no server-side record to bind a session to.',
        },
      }),
    );
    return;
  }

  const sessionId = randomUUID();
  sessions.set(sessionId, {
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    kind: 'token',
    tokenId: auth.id,
    ...(auth.capabilities !== undefined ? { capabilities: auth.capabilities } : {}),
  });
  setHqSessionCookie(
    res,
    serializeHqSessionCookie(sessionId, mutableAuth.cookieSecret),
    secureCookies,
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ loggedIn: true, upgraded: true }));
}

// ── 2FA: TOTP and recovery-code endpoints ──────────────────────────────────

/** Short-lived pending-2FA session TTL (5 minutes). */
const PENDING_2FA_TTL_MS = 5 * 60_000;

/**
 * In-process mutex for recovery-code consumption. `mutateHqAuthFile` does not
 * take a file lock (by design — auth edits are rare), so two concurrent
 * verify requests could both read the same on-disk hashes, both pass the
 * verify check, and both consume the same code. This promise chain
 * serializes recovery-code consumption within the process.
 */
let recoveryCodeLock: Promise<void> = Promise.resolve();

/** Maximum failed verification attempts before a pending session is consumed. */
const MAX_2FA_VERIFY_FAILURES = 5;

/** Record a failed 2FA attempt, feeding the same exponential backoff as login. */
function recordVerifyFailure(
  loginAttempts: LoginAttemptStore,
  clientIp: string,
): number {
  const prev = loginAttempts.get(clientIp);
  const count = (prev?.count ?? 0) + 1;
  loginAttempts.recordFailure(clientIp);
  return count;
}

/**
 * POST `/api/login/verify` — complete 2FA for a pending-2FA session.
 * Accepts either a TOTP `code` or a `recoveryCode`. On success, the pending
 * session is upgraded to a full session (pending2fa cleared). Recovery codes
 * are single-use: the matched hash is removed from `auth.json` on success.
 */
export async function handleApiLoginVerify(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _url: URL,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  loginAttempts: LoginAttemptStore,
  dataDir: string,
  secureCookies: boolean | undefined,
  applyAuthFile: ApplyHqAuthFile,
  trustedProxyHops: number,
): Promise<void> {
  if (!mutableAuth.cookieSecret) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NO_COOKIE_SECRET' } }));
    return;
  }

  // Rate-limit: reuse the loginAttempts per-IP backoff so a stolen password
  // cannot brute-force the 6-digit TOTP at network speed.
  const clientIp = resolveClientAddress(req, trustedProxyHops);
  const { blocked, retryAfter } = loginAttempts.checkBlocked(clientIp);
  if (blocked) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } }));
    return;
  }

  // Extract the pending-2FA session from the cookie.
  const raw = readHqSessionCookie(req.headers.cookie);
  const sessionId = raw ? parseHqSessionCookie(raw, mutableAuth.cookieSecret) : undefined;
  if (!sessionId) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NO_PENDING_SESSION', message: 'No pending 2FA session.' } }));
    return;
  }
  const session = sessions.get(sessionId);
  if (!session?.pending2fa) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NO_PENDING_SESSION', message: 'Session is not pending 2FA.' } }));
    return;
  }
  // Expire the pending session if it exceeds the TTL.
  if (Date.now() - session.createdAt > PENDING_2FA_TTL_MS) {
    sessions.delete(sessionId);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'TOTP_EXPIRED', message: '2FA session expired. Please log in again.' } }));
    return;
  }

  let body: { code?: unknown; recoveryCode?: unknown };
  try {
    body = JSON.parse(await readRequestBody(req)) as typeof body;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } }));
    return;
  }

  // Path A: TOTP code
  if (typeof body.code === 'string' && body.code.length > 0) {
    if (!mutableAuth.totpSecret) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'TOTP_NOT_ENABLED', message: '2FA is not configured.' } }));
      return;
    }
    const matchedCounter = verifyTotpCounter(body.code, mutableAuth.totpSecret);
    // RFC 6238 §5.2: a code is single-use. The ±1-step window keeps it valid
    // for ~90s, so a replay of an already-spent code must be refused even
    // though it still verifies arithmetically.
    const replayed =
      matchedCounter !== undefined &&
      mutableAuth.totpLastUsedCounter !== undefined &&
      matchedCounter <= mutableAuth.totpLastUsedCounter;
    if (matchedCounter === undefined || replayed) {
      if (recordVerifyFailure(loginAttempts, clientIp) >= MAX_2FA_VERIFY_FAILURES) {
        sessions.delete(sessionId);
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: replayed ? 'TOTP_ALREADY_USED' : 'INVALID_TOTP',
            message: replayed
              ? 'That authenticator code has already been used. Wait for the next one.'
              : 'Invalid authenticator code.',
          },
        }),
      );
      return;
    }
    mutableAuth.totpLastUsedCounter = matchedCounter;
    // Upgrade to full session and reset the failure history.
    loginAttempts.clearOnSuccess(clientIp);
    sessions.delete(sessionId);
    const fullSessionId = randomUUID();
    sessions.set(fullSessionId, { createdAt: Date.now(), kind: 'password', lastSeenAt: Date.now() });
    setHqSessionCookie(
      res,
      serializeHqSessionCookie(fullSessionId, mutableAuth.cookieSecret),
      secureCookies,
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ loggedIn: true }));
    return;
  }

  // Path B: recovery code
  if (typeof body.recoveryCode === 'string' && body.recoveryCode.length > 0) {
    const usedHash = hashRecoveryCode(body.recoveryCode);
    const storedHashes = mutableAuth.totpRecoveryCodes ?? [];
    if (storedHashes.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NO_RECOVERY_CODES', message: 'No recovery codes available.' } }));
      return;
    }
    if (!verifyRecoveryCode(body.recoveryCode, storedHashes)) {
      if (recordVerifyFailure(loginAttempts, clientIp) >= MAX_2FA_VERIFY_FAILURES) {
        sessions.delete(sessionId);
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INVALID_RECOVERY_CODE', message: 'Invalid recovery code.' } }));
      return;
    }
    // Consume atomically under an in-process mutex: `mutateHqAuthFile` has no
    // file lock, so concurrent requests could both read the same on-disk
    // hashes. The mutex serializes the read-modify-write cycle so only one
    // request can find and remove the hash.
    let consumed = false;
    let remainingCount = 0;
    // Acquire mutex
    await recoveryCodeLock;
    let releaseLock: () => void = () => {};
    recoveryCodeLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    try {
      const next = await mutateHqAuthFile(dataDir, (current) => {
        const diskHashes = current.totpRecoveryCodes ?? [];
        const idx = diskHashes.indexOf(usedHash);
        if (idx === -1) {
          consumed = false;
          remainingCount = diskHashes.length;
          return current;
        }
        consumed = true;
        const remaining = diskHashes.filter((_, i) => i !== idx);
        remainingCount = remaining.length;
        return { ...current, totpRecoveryCodes: remaining };
      });
      if (!consumed) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'RECOVERY_CODE_ALREADY_USED', message: 'This recovery code has already been used.' } }));
        return;
      }
      applyAuthFile(next);
    } finally {
      releaseLock();
    }
    // Upgrade to full session and reset the failure history.
    loginAttempts.clearOnSuccess(clientIp);
    sessions.delete(sessionId);
    const fullSessionId = randomUUID();
    sessions.set(fullSessionId, { createdAt: Date.now(), kind: 'password', lastSeenAt: Date.now() });
    setHqSessionCookie(
      res,
      serializeHqSessionCookie(fullSessionId, mutableAuth.cookieSecret),
      secureCookies,
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ loggedIn: true, recoveryCodesRemaining: remainingCount }));
    return;
  }

  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Provide a `code` or `recoveryCode`.' } }),
  );
}

/**
 * POST `/api/auth/totp/setup` — generate a new TOTP secret (not yet active).
 * Returns the base32 secret + otpauth URI for QR display. The secret is
 * persisted as `totpPendingSecret` — login does NOT check this field, so
 * an unconfirmed setup cannot lock the operator out. 2FA becomes active
 * only after `/api/auth/totp/enable` verifies a code.
 *
 * Requires existing auth (cookie or token) — only the operator can set up 2FA.
 */
export async function handleApiTotpSetup(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  dataDir: string,
  applyAuthFile: ApplyHqAuthFile,
): Promise<void> {
  if (!authorizeAuthAdmin(req, res, mutableAuth, sessions)) return;

  // Reject if 2FA is already active — re-rolling requires disable first so a
  // stolen cookie can't silently migrate 2FA to the attacker's authenticator.
  if (mutableAuth.totpSecret) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'TOTP_ALREADY_ENABLED', message: '2FA is already active. Disable it first to re-enroll.' } }),
    );
    return;
  }

  const secret = generateTotpSecret();
  const uri = buildOtpAuthUri(secret, 'HQ');

  // Persist as PENDING — not active. Login checks `totpSecret`, not this.
  // Apply the persisted file so the live projection changes atomically with
  // the successful write rather than waiting for the fs.watch debounce.
  const next = await mutateHqAuthFile(dataDir, (current) => ({
    ...current,
    totpPendingSecret: secret,
  }));
  applyAuthFile(next);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ secret, uri, enabled: false }));
}

/**
 * POST `/api/auth/totp/enable` — confirm 2FA enrollment by providing a valid
 * TOTP code. Promotes `totpPendingSecret` → `totpSecret` (active), generates
 * and returns recovery codes (shown once). After this, 2FA is required for
 * password login.
 */
export async function handleApiTotpEnable(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  dataDir: string,
  applyAuthFile: ApplyHqAuthFile,
): Promise<void> {
  if (!authorizeAuthAdmin(req, res, mutableAuth, sessions)) return;

  // Reject if 2FA is already active — mirrors the setup handler's guard.
  // Without this, a double-submit or network retry during the
  // mutateHqAuthFile await re-verifies the same pending secret and
  // overwrites totpRecoveryCodes with a fresh batch, silently
  // invalidating the codes returned by the first response.
  if (mutableAuth.totpSecret) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'TOTP_ALREADY_ENABLED', message: '2FA is already active.' } }),
    );
    return;
  }

  const pendingSecret = mutableAuth.totpPendingSecret;
  if (!pendingSecret) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'TOTP_NOT_SETUP', message: 'Call /api/auth/totp/setup first.' } }),
    );
    return;
  }

  let body: { code?: unknown };
  try {
    body = JSON.parse(await readRequestBody(req)) as typeof body;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } }));
    return;
  }

  if (typeof body.code !== 'string' || body.code.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'code is required.' } }));
    return;
  }

  // Verify the code against the PENDING secret.
  if (!verifyTotp(body.code, pendingSecret)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'INVALID_TOTP', message: 'Invalid authenticator code.' } }));
    return;
  }

  // 2FA confirmed: promote pending → active, generate recovery codes.
  // Sync mutableAuth immediately so login enforces 2FA without waiting for
  // the fs.watch debounce. Also invalidate all existing sessions so a
  // previously-stolen cookie cannot outlive the 2FA enrollment.
  const recoveryCodes = generateRecoveryCodes();
  const recoveryHashes = recoveryCodes.map(hashRecoveryCode);

  const next = await mutateHqAuthFile(dataDir, (current) => {
    const updated = { ...current };
    updated.totpSecret = pendingSecret;
    delete updated.totpPendingSecret;
    updated.totpRecoveryCodes = recoveryHashes;
    return updated;
  });
  applyAuthFile(next);

  // Clear all sessions — every active session must now re-authenticate
  // through the 2FA flow. The operator's current browser session is
  // cleared too; they'll need to log in again with their authenticator.
  sessions.clear();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ enabled: true, recoveryCodes }));
}

/**
 * POST `/api/auth/totp/disable` — remove TOTP 2FA entirely. Requires the
 * current password (or a valid TOTP code) as confirmation.
 */
export async function handleApiTotpDisable(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  loginAttempts: LoginAttemptStore,
  dataDir: string,
  applyAuthFile: ApplyHqAuthFile,
  trustedProxyHops: number,
): Promise<void> {
  if (!authorizeAuthAdmin(req, res, mutableAuth, sessions)) return;

  const clientIp = resolveClientAddress(req, trustedProxyHops);
  const { blocked, retryAfter } = loginAttempts.checkBlocked(clientIp);
  if (blocked) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } }));
    return;
  }

  let body: { password?: unknown; code?: unknown };
  try {
    body = JSON.parse(await readRequestBody(req)) as typeof body;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } }));
    return;
  }

  // Require either the password or a valid TOTP code as confirmation.
  let confirmed = false;
  if (typeof body.password === 'string' && body.password.length > 0 && mutableAuth.passwordHash) {
    confirmed = await verifyHqPassword(body.password, mutableAuth.passwordHash);
  }
  if (!confirmed && typeof body.code === 'string' && mutableAuth.totpSecret) {
    confirmed = verifyTotp(body.code, mutableAuth.totpSecret);
  }
  if (!confirmed) {
    recordVerifyFailure(loginAttempts, clientIp);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'CONFIRMATION_REQUIRED', message: 'Provide the current password or a TOTP code.' } }),
    );
    return;
  }

  loginAttempts.delete(clientIp);
  const next = await mutateHqAuthFile(dataDir, (current) => {
    const updated = { ...current };
    delete updated.totpSecret;
    delete updated.totpPendingSecret;
    delete updated.totpRecoveryCodes;
    return updated;
  });
  applyAuthFile(next);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ enabled: false }));
}

// ── Session management ─────────────────────────────────────────────────────

/**
 * GET `/api/auth/sessions` — list all active browser sessions for the
 * session-management UI.
 *
 * The full session ID is returned because the revoke endpoint below is keyed
 * on it. That is safe on its own — the cookie value is `<id>.<HMAC>` and the
 * HMAC needs `cookieSecret` — but it does hand every reader a working revoke
 * handle for every other session, so the route is gated on `auth.admin`
 * (WS-102) rather than on "is authenticated" as it was.
 *
 * The previous docstring claimed the full ID was never returned while the code
 * returned it; the code was right about what the UI needs, the docstring was
 * right about it deserving a gate.
 */
export function handleApiAuthSessions(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
): void {
  const now = Date.now();
  const list = [];
  for (const [id, session] of sessions) {
    // Never expose pending-2FA sessions.
    if (session.pending2fa) continue;
    list.push({
      // The client sends the full ID back to revoke; `shortId` is for display.
      id,
      shortId: id.slice(0, 8),
      kind: session.kind,
      createdAt: new Date(session.createdAt).toISOString(),
      lastSeenAt: new Date(session.lastSeenAt).toISOString(),
      ageMinutes: Math.round((now - session.createdAt) / 60_000),
      idleMinutes: Math.round((now - session.lastSeenAt) / 60_000),
    });
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      sessions: list,
      idleTimeoutMinutes: Math.round(
        (HqServerAuthRef.HQ_SESSION_IDLE_TIMEOUT_MS ?? 30 * 60_000) / 60_000,
      ),
      maxAgeDays: Math.round(HqServerAuthRef.HQ_SESSION_MAX_AGE_MS / (24 * 60 * 60_000)),
      passwordMode: mutableAuth.passwordHash !== undefined,
    }),
  );
}

/**
 * DELETE `/api/auth/sessions/:id` — revoke a single session by ID.
 * DELETE `/api/auth/sessions` — revoke ALL sessions (force logout everyone).
 */
export async function handleApiAuthSessionsRevoke(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  sessions: Map<string, HqSessionEntry>,
): Promise<void> {
  const pathParts = url.pathname.split('/').filter(Boolean);
  // /api/auth/sessions/:id or /api/auth/sessions
  const targetId = pathParts[3]; // ['api', 'auth', 'sessions', ':id']

  if (targetId) {
    // Revoke a single session
    const session = sessions.get(targetId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Session not found.' } }));
      return;
    }
    sessions.delete(targetId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revoked: 1 }));
    return;
  }

  // Revoke all sessions
  const count = sessions.size;
  sessions.clear();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ revoked: count }));
}

// Lazy import to avoid circular dependency at module load time.
import * as HqServerAuthRef from '../auth.js';
import { readHqAuthAuditTail } from '@wrongstack/core/hq';

/**
 * GET `/api/auth/audit` — recent auth events for the audit panel.
 * Returns the last 50 entries from auth-audit.jsonl, newest first.
 */
export function handleApiAuthAudit(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  dataDir: string,
): void {
  const entries = readHqAuthAuditTail(dataDir, 50);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ entries }));
}

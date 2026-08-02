import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import {
  DEFAULT_HQ_REDACTION_POLICY,
  type HqAlertRuleConfig,
  type HqRedactionPolicy,
  type HqToken,
  hashHqPassword,
  hqTokenKey,
  isLoopbackHost,
  isTokenExpired,
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
} from '@wrongstack/core/security';
import {
  authenticateBrowserRequest,
  clearHqSessionCookie,
  HQ_SESSION_COOKIE,
  isCookieAuth,
  isTokenAuth,
  parseCookieHeader,
  parseHqSessionCookie,
  serializeHqSessionCookie,
  setHqSessionCookie,
} from '../auth.js';
import type { LoginAttemptStore } from '../login-attempt-store.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../types.js';
import { readRequestBody, writeInvalidBody } from '../utils.js';

function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  return address !== undefined && isLoopbackHost(address);
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

  const clientIp = req.socket.remoteAddress ?? 'unknown';
  // Pre-parse rate-limit check (IP only — we don't have the password yet).
  const { blocked, retryAfter } = loginAttempts.checkBlocked(clientIp, '');
  if (blocked) {
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
    const cookies = parseCookieHeader(req.headers.cookie);
    const raw = cookies[HQ_SESSION_COOKIE] ?? cookies['__Host-hq.session'];
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
    auth.capabilities !== undefined &&
    auth.capabilities.includes('auth.admin');

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
    applyAuthFile(mutableAuth, next);
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
  applyAuthFile(mutableAuth, next);
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

export function applyAuthFile(
  mutableAuth: HqRouterMutableAuth,
  next: {
    browserTokens?: Array<{
      token: string;
      id: string;
      capabilities?: string[];
      expiresAt?: string;
    }>;
    clientTokens?: Array<HqToken>;
    redactionPolicy?: Partial<HqRedactionPolicy>;
    passwordHash?: string;
    cookieSecret?: string;
    alertRules?: HqAlertRuleConfig;
    totpSecret?: string;
    totpPendingSecret?: string;
    totpRecoveryCodes?: string[];
  },
): void {
  mutableAuth.operatorPolicy = {
    ...DEFAULT_HQ_REDACTION_POLICY,
    ...(next.redactionPolicy ?? {}),
  };
  mutableAuth.operatorPolicyOverride = next.redactionPolicy;
  // WS-011: reload rebuilt the live sets from the raw file without filtering
  // expired entries and without carrying `expiresAt` forward, so an expired
  // token was re-admitted on every reload and could never be re-checked.
  const liveBrowserTokens = (next.browserTokens ?? []).filter((t) => !isTokenExpired(t));
  // WS-044: keyed on the verifier, so a hashed file and a legacy cleartext
  // one both authenticate through `hqTokenKey`.
  mutableAuth.browserTokens = new Set(liveBrowserTokens.map(hqTokenKey));
  mutableAuth.clientTokens = new Set((next.clientTokens ?? []).map(hqTokenKey));
  mutableAuth.browserTokenObjs = new Map(
    liveBrowserTokens.map((t) => [
      hqTokenKey(t),
      {
        id: t.id,
        ...(t.capabilities !== undefined ? { capabilities: t.capabilities } : {}),
        ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}),
      },
    ]),
  );
  mutableAuth.clientTokenObjs = new Map(
    (next.clientTokens ?? []).map((token: HqToken) => [hqTokenKey(token), token]),
  );
  mutableAuth.passwordHash = next.passwordHash;
  mutableAuth.cookieSecret = next.cookieSecret;
  mutableAuth.alertRules = next.alertRules;
  mutableAuth.totpSecret = next.totpSecret;
  mutableAuth.totpPendingSecret = next.totpPendingSecret;
  mutableAuth.totpRecoveryCodes = next.totpRecoveryCodes;
}

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
  loginAttempts.recordFailure(clientIp, '');
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
): Promise<void> {
  if (!mutableAuth.cookieSecret) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NO_COOKIE_SECRET' } }));
    return;
  }

  // Rate-limit: reuse the loginAttempts per-IP backoff so a stolen password
  // cannot brute-force the 6-digit TOTP at network speed.
  const clientIp = req.socket.remoteAddress ?? 'unknown';
  const { blocked, retryAfter } = loginAttempts.checkBlocked(clientIp, '');
  if (blocked) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } }));
    return;
  }

  // Extract the pending-2FA session from the cookie.
  const cookies = parseCookieHeader(req.headers.cookie);
  const raw = cookies[HQ_SESSION_COOKIE] ?? cookies['__Host-hq.session'];
  const sessionId = raw ? parseHqSessionCookie(raw, mutableAuth.cookieSecret) : undefined;
  if (!sessionId) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NO_PENDING_SESSION', message: 'No pending 2FA session.' } }));
    return;
  }
  const session = sessions.get(sessionId);
  if (!session || !session.pending2fa) {
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
    if (!verifyTotp(body.code, mutableAuth.totpSecret)) {
      if (recordVerifyFailure(loginAttempts, clientIp) >= MAX_2FA_VERIFY_FAILURES) {
        sessions.delete(sessionId);
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INVALID_TOTP', message: 'Invalid authenticator code.' } }));
      return;
    }
    // Upgrade to full session and reset the failure history.
    loginAttempts.clearOnSuccess(clientIp, '');
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
      applyAuthFile(mutableAuth, next);
    } finally {
      releaseLock();
    }
    // Upgrade to full session and reset the failure history.
    loginAttempts.clearOnSuccess(clientIp, '');
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
): Promise<void> {
  const auth = authenticateBrowserRequest(
    req,
    new URL(req.url ?? '/', 'http://localhost'),
    mutableAuth,
    sessions,
  );
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }));
    return;
  }

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
  applyAuthFile(mutableAuth, next);

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
): Promise<void> {
  const auth = authenticateBrowserRequest(
    req,
    new URL(req.url ?? '/', 'http://localhost'),
    mutableAuth,
    sessions,
  );
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }));
    return;
  }

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
  applyAuthFile(mutableAuth, next);

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
): Promise<void> {
  const auth = authenticateBrowserRequest(
    req,
    new URL(req.url ?? '/', 'http://localhost'),
    mutableAuth,
    sessions,
  );
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }));
    return;
  }

  const clientIp = req.socket.remoteAddress ?? 'unknown';
  const { blocked, retryAfter } = loginAttempts.checkBlocked(clientIp, '');
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
  applyAuthFile(mutableAuth, next);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ enabled: false }));
}

// ── Session management ─────────────────────────────────────────────────────

/**
 * GET `/api/auth/sessions` — list all active browser sessions for the
 * session-management UI. Returns each session's kind, creation time,
 * last-seen time, and a truncated ID (never the full session ID — that
 * would allow cookie forgery since the session ID IS the cookie value).
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
    // Never expose pending-2FA sessions or the full session ID.
    if (session.pending2fa) continue;
    list.push({
      // Truncated for display only — the client sends the full ID to revoke.
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

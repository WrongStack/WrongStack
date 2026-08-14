import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import {
  hashHqPassword,
  mintHqCookieSecret,
  mutateHqAuthFile,
  verifyHqPassword,
} from '@wrongstack/core/hq';
import {
  authenticateBrowserRequest,
  clearHqSessionCookie,
  isCookieAuth,
  isTokenAuth,
  parseHqSessionCookie,
  readHqSessionCookie,
  serializeHqSessionCookie,
  setHqSessionCookie,
} from '../../auth.js';
import { resolveClientAddress } from '../../client-address.js';
import type { LoginAttemptStore } from '../../login-attempt-store.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../../types.js';
import { readRequestBody, writeInvalidBody } from '../../utils.js';
import { type ApplyHqAuthFile, isLoopbackRequest } from './common.js';

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

  const hasAdminCapability =
    auth !== undefined && 'capabilities' in auth && auth.capabilities?.includes('auth.admin');

  if (!localOpenBootstrap && mutableAuth.passwordHash !== undefined && !hasAdminCapability) {
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    if (!currentPassword || !(await verifyHqPassword(currentPassword, mutableAuth.passwordHash))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'INVALID_CURRENT_PASSWORD',
            message: 'Current password is required to change or remove it.',
          },
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

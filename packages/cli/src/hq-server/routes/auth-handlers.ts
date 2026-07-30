import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import {
  DEFAULT_HQ_REDACTION_POLICY,
  hashHqPassword,
  isLoopbackHost,
  mintHqCookieSecret,
  mutateHqAuthFile,
  verifyHqPassword,
  type HqAlertRuleConfig,
  type HqRedactionPolicy,
  type HqToken,
} from '@wrongstack/core/hq';
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
    mutableAuth.browserTokens.size === 0 && mutableAuth.passwordHash === undefined;
  const localOpenMode = openMode && !requireBrowserAuth && isLoopbackRequest(req);
  const publicOrigin = trustedPublicOrigins.values().next().value;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      tokenMode: mutableAuth.browserTokens.size > 0,
      passwordMode: mutableAuth.passwordHash !== undefined,
      publicRelay: requireBrowserAuth === true || publicOrigin !== undefined,
      ...(publicOrigin !== undefined ? { publicOrigin } : {}),
      secureCookies: secureCookies === true,
      loggedIn: auth !== undefined || localOpenMode,
      authKind:
        isCookieAuth(auth)
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
  loginAttempts: Map<string, { count: number; blockedUntil: number; lastAttempt: number }>,
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
  const existing = loginAttempts.get(clientIp);
  if (existing && existing.blockedUntil > Date.now()) {
    const retryAfter = Math.ceil((existing.blockedUntil - Date.now()) / 1000);
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
    res.end(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'password is required' } }),
    );
    return;
  }

  const ok = await verifyHqPassword(body.password, mutableAuth.passwordHash);
  if (!ok || !mutableAuth.cookieSecret) {
    const prev = loginAttempts.get(clientIp);
    const count = (prev?.count ?? 0) + 1;
    const backoffMs = Math.min(2 ** count * 1000, 16_000);
    loginAttempts.set(clientIp, {
      count,
      blockedUntil: Date.now() + backoffMs,
      lastAttempt: Date.now(),
    });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'INVALID_PASSWORD', message: 'Invalid password.' } }),
    );
    return;
  }

  loginAttempts.delete(clientIp);
  const sessionId = randomUUID();
  sessions.set(sessionId, { createdAt: Date.now(), kind: 'password' });
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
    const raw = cookies[HQ_SESSION_COOKIE];
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

  let body: { currentPassword?: unknown; newPassword?: unknown } = {};
  try {
    body = JSON.parse(await readRequestBody(req)) as typeof body;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } }),
    );
    return;
  }

  if (isCookieAuth(auth) && mutableAuth.passwordHash !== undefined) {
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    if (
      !currentPassword ||
      !(await verifyHqPassword(currentPassword, mutableAuth.passwordHash))
    ) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Current password is invalid.' },
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
        error: { code: 'INVALID_PASSWORD', message: 'New password must be between 8 and 1024 characters.' },
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
    sessions.set(sessionId, { createdAt: Date.now(), kind: 'password' });
    setHqSessionCookie(
      res,
      serializeHqSessionCookie(sessionId, cookieSecret),
      secureCookies,
    );
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
    browserTokens?: Array<{ token: string; id: string; capabilities?: string[] }>;
    clientTokens?: Array<HqToken>;
    redactionPolicy?: Partial<HqRedactionPolicy>;
    passwordHash?: string;
    cookieSecret?: string;
    alertRules?: HqAlertRuleConfig;
  },
): void {
  mutableAuth.operatorPolicy = {
    ...DEFAULT_HQ_REDACTION_POLICY,
    ...(next.redactionPolicy ?? {}),
  };
  mutableAuth.operatorPolicyOverride = next.redactionPolicy;
  mutableAuth.browserTokens = new Set((next.browserTokens ?? []).map((t) => t.token));
  mutableAuth.clientTokens = new Set((next.clientTokens ?? []).map((t) => t.token));
  mutableAuth.browserTokenObjs = new Map(
    (next.browserTokens ?? []).map((t) => [
      t.token,
      { id: t.id, ...(t.capabilities !== undefined ? { capabilities: t.capabilities } : {}) },
    ]),
  );
  mutableAuth.clientTokenObjs = new Map(
    (next.clientTokens ?? []).map((token: HqToken) => [token.token, token]),
  );
  mutableAuth.passwordHash = next.passwordHash;
  mutableAuth.cookieSecret = next.cookieSecret;
  mutableAuth.alertRules = next.alertRules;
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
    res.end(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'code is required' } }),
    );
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

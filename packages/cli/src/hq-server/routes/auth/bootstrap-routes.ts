import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import {
  authenticateBrowserRequest,
  isCookieAuth,
  isTokenAuth,
  serializeHqSessionCookie,
  setHqSessionCookie,
} from '../../auth.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../../types.js';
import { readRequestBody, writeInvalidBody } from '../../utils.js';

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

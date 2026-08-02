/**
 * WS-065 — `POST /api/auth/upgrade`: trade a live browser token for an
 * HttpOnly session cookie so the SPA can stop keeping the raw token in
 * `sessionStorage`.
 *
 * The bootstrap exchange (see `d2-bootstrap-exchange.test.ts`) already covers
 * fresh startup URLs. This route covers what bootstrap cannot reach: an older
 * `?token=` startup URL, and a token pasted into the token gate. For those the
 * stored token is the user's only credential, so deleting the fallback outright
 * was not an option — the client only clears storage once this route has
 * confirmed a cookie.
 *
 * The properties worth pinning are about what upgrading must NOT do: it must
 * not accept anything other than a live token, must not mint a session for a
 * token the cookie path cannot resolve back, must not widen capabilities, and
 * must not survive revocation of the source token.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HQ_AUTH_FILE_VERSION, hqTokenKey, writeHqAuthFile } from '@wrongstack/core/hq';

import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { handleApiTokenUpgrade } from '../src/hq-server/routes/auth-handlers.js';
import type { HqSessionEntry } from '../src/hq-server/types.js';

const TOKEN = 'ws065-token-public';
const COOKIE_SECRET = 'ws065-test-cookie-secret-do-not-use-in-prod';

function getPort(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

function upgrade(baseUrl: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/upgrade`, { method: 'POST', headers });
}

/** The `hq.session=…` pair from a Set-Cookie header, ready to send back. */
function cookiePair(res: Response): string {
  const raw = res.headers.get('set-cookie');
  expect(raw, 'expected a session cookie').not.toBeNull();
  return (raw ?? '').split(';')[0] ?? '';
}

let handle: HqServerHandle | null = null;
let tempRoot: string;
let dataDir: string;

async function seed(capabilities?: string[]): Promise<void> {
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    cookieSecret: COOKIE_SECRET,
    browserTokens: [
      {
        id: 'ws065-browser',
        token: TOKEN,
        createdAt: new Date().toISOString(),
        ...(capabilities !== undefined ? { capabilities } : {}),
      },
    ],
  });
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-ws065-'));
  dataDir = path.join(tempRoot, 'hq');
  await fs.mkdir(dataDir, { recursive: true });
  await seed();
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('POST /api/auth/upgrade (WS-065)', () => {
  it('exchanges a live token for an HttpOnly session cookie', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const res = await upgrade(`http://127.0.0.1:${handle.port}`, {
      Authorization: `Bearer ${TOKEN}`,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { loggedIn?: boolean; upgraded?: boolean };
    expect(body.loggedIn).toBe(true);
    expect(body.upgraded).toBe(true);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=\d+/);
  });

  it('never echoes the token back in the response', async () => {
    // The point of the exchange is to stop the token from living in the
    // browser; returning it in the body would defeat it.
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const res = await upgrade(`http://127.0.0.1:${handle.port}`, {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(await res.text()).not.toContain(TOKEN);
    expect(res.headers.get('set-cookie')).not.toContain(TOKEN);
  });

  it('the issued cookie actually authenticates subsequent requests', async () => {
    // Without this the client would clear its stored token and be locked out.
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const base = `http://127.0.0.1:${handle.port}`;
    const res = await upgrade(base, { Authorization: `Bearer ${TOKEN}` });

    const status = await fetch(`${base}/api/auth/status`, { headers: { Cookie: cookiePair(res) } });
    const body = (await status.json()) as { loggedIn?: boolean; authKind?: string };
    expect(body.loggedIn).toBe(true);
    expect(body.authKind).toBe('password'); // `authKind` reports cookie sessions as 'password'
  });

  it('rejects a request with no credential', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const res = await upgrade(`http://127.0.0.1:${handle.port}`, {});
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a wrong token', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const res = await upgrade(`http://127.0.0.1:${handle.port}`, {
      Authorization: 'Bearer not-the-token',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('is idempotent for an already-cookie caller — no second session minted', async () => {
    // The client retries on every load until it succeeds, so minting per call
    // would grow the server session table for the lifetime of the tab.
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const base = `http://127.0.0.1:${handle.port}`;
    const first = await upgrade(base, { Authorization: `Bearer ${TOKEN}` });

    const second = await upgrade(base, { Cookie: cookiePair(first) });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { loggedIn?: boolean; upgraded?: boolean };
    expect(body.loggedIn).toBe(true);
    expect(body.upgraded).toBe(false);
    expect(second.headers.get('set-cookie')).toBeNull();
  });

  it('carries the source token capabilities, and does not widen them', async () => {
    await seed(['view']);
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const base = `http://127.0.0.1:${handle.port}`;
    const res = await upgrade(base, { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);

    // A capability-limited token must not become a full-access cookie. The
    // cookie path reports `authKind: 'password'` for any cookie, so probe a
    // capability-gated route instead of trusting the label.
    const cmd = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { Cookie: cookiePair(res), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope', command: 'noop' }),
    });
    expect(cmd.status).toBe(403);
  });

  it('mints a session bound to the token id, not a free-standing one', async () => {
    // This is the hinge of the whole design. `authenticateBrowserRequest`
    // treats a `kind: 'token'` session as live only while a token with that
    // `tokenId` still exists, and deletes it otherwise — so revoking the source
    // token also kills every cookie upgraded from it. If the handler minted a
    // `kind: 'cookie'` (password-origin) session instead, upgrading would be a
    // way to OUTLIVE revocation with full access, which is strictly worse than
    // the sessionStorage exposure this change set out to remove.
    //
    // Asserted directly against the authenticator rather than by rewriting
    // auth.json and waiting on the file watcher, because that path is a timed
    // race and this property is not.
    const sessions = new Map<string, HqSessionEntry>();
    // The live set holds VERIFIERS (`sha256(secret)`), never the secret — see
    // `timingSafeTokenMatch`. Key the maps the way the server does.
    const key = hqTokenKey({ token: TOKEN });
    const mutableAuth = {
      browserTokens: new Set([key]),
      browserTokenObjs: new Map([[key, { id: 'ws065-browser', capabilities: ['view'] }]]),
      cookieSecret: COOKIE_SECRET,
    };

    const req = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { authorization: `Bearer ${TOKEN}` },
    } as unknown as import('node:http').IncomingMessage;
    const res = {
      setHeader() {
        /* the handler's cookie write is captured via `sessions` below */
      },
      writeHead() {},
      end() {},
    } as unknown as import('node:http').ServerResponse;

    await handleApiTokenUpgrade(
      req,
      res,
      new URL('http://127.0.0.1/api/auth/upgrade'),
      mutableAuth as never,
      sessions,
      undefined,
    );

    const entry = [...sessions.values()][0];
    expect(entry?.kind).toBe('token');
    expect(entry?.tokenId).toBe('ws065-browser');
    expect(entry?.capabilities).toEqual(['view']);
  });

  it('refuses a token with no server-side record', async () => {
    // `authenticateBrowserRequest` falls back to `id: 'unknown'` for a token
    // present in the live set but absent from `browserTokenObjs`. The cookie
    // path would then fail to resolve the id back and evict the session — so
    // the client would clear its stored token in exchange for a cookie that
    // stops working on the very next request.
    const sessions = new Map<string, HqSessionEntry>();
    const mutableAuth = {
      browserTokens: new Set([hqTokenKey({ token: TOKEN })]),
      browserTokenObjs: new Map(), // deliberately empty
      cookieSecret: COOKIE_SECRET,
    };
    let status = 0;
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { authorization: `Bearer ${TOKEN}` },
    } as unknown as import('node:http').IncomingMessage;
    const res = {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end() {},
    } as unknown as import('node:http').ServerResponse;

    await handleApiTokenUpgrade(
      req,
      res,
      new URL('http://127.0.0.1/api/auth/upgrade'),
      mutableAuth as never,
      sessions,
      undefined,
    );
    expect(status).toBe(409);
    expect(sessions.size).toBe(0);
  });
});

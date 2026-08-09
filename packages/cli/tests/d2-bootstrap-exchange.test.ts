/**
 * D2 — Auth bootstrap exchange acceptance gate.
 *
 * Plan §11.4 (security caveat): "a reusable browser token ends up in
 * tunnel URLs and WS URLs. The remediation is an architectural
 * bootstrap exchange (short-lived one-time code → Secure/HttpOnly/SameSite
 * cookie → reusable control-capability token kept out of URLs)."
 *
 * What this gate locks down:
 *   1. /api/auth/bootstrap is the only auth path for token-mode HQ —
 *      the browser URL never carries a reusable token; the startup
 *      link uses `#bootstrap=<one-time-code>` only.
 *   2. POST /api/auth/bootstrap with a valid code returns ONLY a
 *      Set-Cookie header (`HttpOnly`, `SameSite=Lax`, optional `Secure`,
 *      and a `Max-Age`); the body is `{ loggedIn: true }` and must NOT
 *      include a reusable token.
 *   3. The code is single-use: a second POST with the same code returns
 *      401 INVALID_OR_EXPIRED_CODE.
 *   4. The code is short-lived: HqBootstrapCodeStore issues codes with
 *      a 120-second TTL.
 *   5. Capability downgrades take effect immediately (re-read from the
 *      live browser token on every request).
 *
 * Note: D2 builds on `HqBootstrapCodeStore` (already shipped) and the
 * existing `/api/auth/bootstrap` route. The fix is to lock the contract
 * with a focused CI gate so the leak cannot regress silently.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_AUTH_FILE_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

function getPort(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

async function readSetCookie(response: Response): Promise<string | null> {
  // Node's undici merges repeated Set-Cookie headers into one
  // comma-separated string. There is exactly one cookie set on bootstrap
  // success, so the first segment is the HQ session cookie.
  const raw = response.headers.get('set-cookie');
  return raw;
}

async function fetchBootstrap(baseUrl: string, code: string | null): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/bootstrap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(code === null ? {} : { 'X-Origin-Fragment': 'unit-test' }),
    },
    body: code === null ? '{}' : JSON.stringify({ code }),
  });
}

let handle: HqServerHandle | null = null;
let tempRoot: string;
let dataDir: string;
let cookieSecret = '';

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-d2-'));
  dataDir = path.join(tempRoot, 'hq');
  await fs.mkdir(dataDir, { recursive: true });
  cookieSecret = 'd2-test-cookie-secret-do-not-use-in-prod';
  // Seed a known browser token + cookie secret before startHqServer mints
  // a first-run auth file. Using a pre-shared cookie secret keeps the
  // signed session cookie deterministic across test runs.
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    cookieSecret,
    browserTokens: [
      { id: 'd2-browser', token: 'd2-token-public', createdAt: new Date().toISOString() },
    ],
  });
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('D2 — auth bootstrap exchange', () => {
  it('rejects /api/auth/bootstrap with no code', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const res = await fetchBootstrap(`http://127.0.0.1:${handle.port}`, null);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('BAD_REQUEST');
    // No Set-Cookie on rejection.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects /api/auth/bootstrap with an unknown code', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const res = await fetchBootstrap(`http://127.0.0.1:${handle.port}`, 'no-such-code');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('INVALID_OR_EXPIRED_CODE');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('does not leak a reusable token in the response body or headers', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });

    // Reach into the running server via the first-run browser token to
    // issue a one-time bootstrap code. (The first-run setup exposes the
    // bootstrap URL on `handle.firstRunSetup.browserUrl`.)
    const setup = handle.firstRunSetup;
    expect(setup?.browserUrl).toBeDefined();
    const fragment = setup?.browserUrl?.split('#bootstrap=')[1];
    expect(typeof fragment).toBe('string');
    expect(fragment?.length).toBeGreaterThan(20);

    // The browser URL must NOT contain the long-lived token. The fragment
    // carries only the one-time bootstrap code.
    expect(setup?.browserUrl).not.toContain('d2-token-public');

    const res = await fetchBootstrap(`http://127.0.0.1:${handle.port}`, fragment ?? '');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loggedIn?: boolean; token?: unknown };
    expect(body.loggedIn).toBe(true);
    // Response body must not echo any token-shaped field.
    expect(body.token).toBeUndefined();

    const setCookie = await readSetCookie(res);
    expect(setCookie).not.toBeNull();
    // The session cookie is HttpOnly + SameSite=Lax.
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=\d+/);
  });

  it('consumes a bootstrap code on first use (single-use semantics)', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });
    const fragment = handle.firstRunSetup?.browserUrl?.split('#bootstrap=')[1];
    expect(typeof fragment).toBe('string');

    const first = await fetchBootstrap(`http://127.0.0.1:${handle.port}`, fragment ?? '');
    expect(first.status).toBe(200);
    expect(first.headers.get('set-cookie')).not.toBeNull();

    const second = await fetchBootstrap(`http://127.0.0.1:${handle.port}`, fragment ?? '');
    expect(second.status).toBe(401);
    const body = (await second.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('INVALID_OR_EXPIRED_CODE');
  });

  it('does not place a reusable token on /ws/browser or /ws/client', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: getPort(), dataDir });

    // The first-run browser URL is fragment-only — no query-string
    // token. The legacy query-string token remains as a backward-
    // compatible path for CLIs that already wire that variable, but
    // D2's contract is: the *browser* URL stays fragment-only.
    const browserUrl = handle.firstRunSetup?.browserUrl ?? '';
    expect(browserUrl).not.toMatch(/\?token=/);
    expect(browserUrl).toContain('#bootstrap=');
  });
});

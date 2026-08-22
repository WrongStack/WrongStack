import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HQ_AUTH_FILE_VERSION,
  hashHqPassword,
  mintHqCookieSecret,
  readHqAuthFile,
  verifyHqPassword,
  writeHqAuthFile,
} from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

let handle: HqServerHandle | null = null;
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-pwd-'));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  // Windows: HQ may still hold auth/login-attempt files for a beat after
  // close(), so bare rmdir flakes with ENOTEMPTY under full-suite load.
  // Node's recursive rm retries EBUSY/ENOTEMPTY when maxRetries is set.
  await fs.rm(dataDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
});

/**
 * WS-044: browser token secrets are no longer recoverable from `auth.json` —
 * only their `sha256` verifier is persisted. Tests that need to PRESENT a
 * token therefore seed one they already know, exactly as an operator does with
 * the secret `hq token create` prints once. Reading it back off disk, which is
 * what these tests used to do, is precisely the capability that was removed.
 */
const SEEDED_TOKEN = 'k'.repeat(64);

async function seedAuthFile(opts: { password?: string } = {}): Promise<void> {
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [{ id: 'seeded', token: SEEDED_TOKEN, createdAt: new Date().toISOString() }],
    ...(opts.password !== undefined
      ? { passwordHash: await hashHqPassword(opts.password), cookieSecret: mintHqCookieSecret() }
      : {}),
  });
}

function httpUrl(handle: HqServerHandle, pathname: string): string {
  return `http://${handle.host}:${handle.port}${pathname}`;
}

function wsUrl(handle: HqServerHandle, pathname: string, _cookie?: string): string {
  const base = `ws://${handle.host}:${handle.port}${pathname}`;
  return base; // cookie is supplied via headers in the WebSocket constructor below.
}

function waitForOpen(ws: WebSocket, timeout = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS open timeout')), timeout);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// @ts-expect-error — kept for reference but unused in current test suite
function _waitForClose(ws: WebSocket, timeout = 3_000): Promise<number | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeout);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function login(
  handle: HqServerHandle,
  password: string,
): Promise<{ res: Response; cookie: string | null }> {
  const res = await fetch(httpUrl(handle, '/api/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const rawCookie = res.headers.get('set-cookie');
  return { res, cookie: rawCookie };
}

describe('HQ server — optional browser password login', () => {
  it('first-run --password stores a password hash and cookie secret', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir, password: 'secret123' });
    const auth = await readHqAuthFile(dataDir);
    expect(auth.passwordHash).toMatch(/^scrypt\$/);
    expect(typeof auth.cookieSecret).toBe('string');
    expect(auth.cookieSecret?.length).toBeGreaterThan(0);
  });

  it('login is disabled when no password is configured', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const { res } = await login(handle, 'anything');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('PASSWORD_NOT_CONFIGURED');
  });

  it('rejects a wrong password', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir, password: 'secret123' });
    const { res } = await login(handle, 'wrong');
    expect(res.status).toBe(401);
  });

  it('accepts the correct password and sets a session cookie', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir, password: 'secret123' });
    const { res, cookie } = await login(handle, 'secret123');
    expect(res.status).toBe(200);
    expect(cookie).toMatch(/hq\.session=/);
  });

  it('auth/status reports password mode without leaking the hash', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir, password: 'secret123' });
    const res = await fetch(httpUrl(handle, '/api/auth/status'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tokenMode: boolean;
      passwordMode: boolean;
      loggedIn: boolean;
    };
    expect(body.passwordMode).toBe(true);
    expect(body.tokenMode).toBe(true); // first-run still mints browser tokens
    expect(body.loggedIn).toBe(false);
  });

  it('auth/status reports only server-established public relay metadata', async () => {
    handle = await startHqServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      password: 'secret123',
      secureCookies: true,
      requireBrowserAuth: true,
    });
    handle.trustPublicOrigin('https://quiet-river.trycloudflare.com');

    const res = await fetch(httpUrl(handle, '/api/auth/status'));
    const body = (await res.json()) as {
      publicRelay?: boolean;
      publicOrigin?: string;
      secureCookies?: boolean;
    };
    expect(body).toMatchObject({
      publicRelay: true,
      publicOrigin: 'https://quiet-river.trycloudflare.com',
      secureCookies: true,
    });
  });

  it('protected /api routes reject unauthenticated requests in password mode', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir, password: 'secret123' });
    await writeHqAuthFile(dataDir, {
      ...(await readHqAuthFile(dataDir)),
      browserTokens: [], // disable token mode so only password matters
    });
    // The auth file was overwritten after startup, so restart to pick it up.
    await handle.close();
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const res = await fetch(httpUrl(handle, '/api/snapshot'));
    expect(res.status).toBe(401);
  });

  it('protected /api routes accept a valid session cookie', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir, password: 'secret123' });
    await writeHqAuthFile(dataDir, {
      ...(await readHqAuthFile(dataDir)),
      browserTokens: [],
    });
    await handle.close();
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const { cookie } = await login(handle, 'secret123');
    expect(cookie).toBeTruthy();

    const res = await fetch(httpUrl(handle, '/api/snapshot'), {
      headers: { Cookie: cookie! },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals?: { activeClients?: number } };
    expect(typeof body.totals?.activeClients).toBe('number');
  });

  it('/ws/browser accepts the session cookie and rejects without it', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir, password: 'secret123' });
    await writeHqAuthFile(dataDir, {
      ...(await readHqAuthFile(dataDir)),
      browserTokens: [],
    });
    await handle.close();
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const bad = new WebSocket(wsUrl(handle, '/ws/browser'));
    await expect(waitForOpen(bad)).rejects.toThrow();
    bad.close();

    const { cookie } = await login(handle, 'secret123');
    expect(cookie).toBeTruthy();
    const good = new WebSocket(wsUrl(handle, '/ws/browser'), {
      headers: { Cookie: cookie! },
    } as never);
    await expect(waitForOpen(good)).resolves.toBeUndefined();
    good.close();
  });

  it('logout clears the session cookie and subsequent requests 401', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir, password: 'secret123' });
    await writeHqAuthFile(dataDir, {
      ...(await readHqAuthFile(dataDir)),
      browserTokens: [],
    });
    await handle.close();
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const { cookie } = await login(handle, 'secret123');
    const logout = await fetch(httpUrl(handle, '/api/logout'), {
      method: 'POST',
      headers: { Cookie: cookie! },
    });
    expect(logout.status).toBe(200);
    const cleared = logout.headers.get('set-cookie');
    expect(cleared).toMatch(/hq\.session=;/);

    const after = await fetch(httpUrl(handle, '/api/snapshot'), {
      headers: { Cookie: cookie! },
    });
    expect(after.status).toBe(401);
  });

  it('password mode still allows valid browser tokens', async () => {
    await seedAuthFile({ password: 'secret123' });
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const token = SEEDED_TOKEN;
    // The secret is NOT on disk — only its verifier.
    expect((await readHqAuthFile(dataDir)).browserTokens?.[0]?.token).toBe('');

    const res = await fetch(httpUrl(handle, '/api/snapshot'), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const ws = new WebSocket(
      `ws://${handle.host}:${handle.port}/ws/browser?token=${encodeURIComponent(token!)}`,
    );
    await expect(waitForOpen(ws)).resolves.toBeUndefined();
    ws.close();
  });

  it('allows an authenticated browser token to enable password login', async () => {
    await seedAuthFile();
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const token = SEEDED_TOKEN;

    const response = await fetch(httpUrl(handle, '/api/auth/password'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newPassword: 'enabled-from-web' }),
    });
    expect(response.status).toBe(200);
    const auth = await readHqAuthFile(dataDir);
    expect(await verifyHqPassword('enabled-from-web', auth.passwordHash ?? '')).toBe(true);
  });

  it('allows local open mode to bootstrap a password and signs in that browser', async () => {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [],
    });
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const response = await fetch(httpUrl(handle, '/api/auth/password'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: 'local-bootstrap' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/hq\.session=/);
    const auth = await readHqAuthFile(dataDir);
    expect(await verifyHqPassword('local-bootstrap', auth.passwordHash ?? '')).toBe(true);
  });

  it('requires the current password for a password-session rotation', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir, password: 'secret123' });
    await writeHqAuthFile(dataDir, {
      ...(await readHqAuthFile(dataDir)),
      browserTokens: [],
    });
    await handle.close();
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const { cookie } = await login(handle, 'secret123');

    const rejected = await fetch(httpUrl(handle, '/api/auth/password'), {
      method: 'POST',
      headers: { Cookie: cookie!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'new-secret-123' }),
    });
    expect(rejected.status).toBe(403);

    const changed = await fetch(httpUrl(handle, '/api/auth/password'), {
      method: 'POST',
      headers: { Cookie: cookie!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'secret123', newPassword: 'new-secret-123' }),
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('set-cookie')).toMatch(/hq\.session=/);
    const auth = await readHqAuthFile(dataDir);
    expect(await verifyHqPassword('new-secret-123', auth.passwordHash ?? '')).toBe(true);
    expect(await verifyHqPassword('secret123', auth.passwordHash ?? '')).toBe(false);
  });

  it('requires the current password when a browser token removes password protection (H2)', async () => {
    await seedAuthFile({ password: 'secret123' });
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const token = SEEDED_TOKEN;

    // Without currentPassword → rejected (H2: token-auth can no longer bypass)
    const rejected = await fetch(httpUrl(handle, '/api/auth/password'), {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(rejected.status).toBe(403);

    // With correct currentPassword → succeeds
    const response = await fetch(httpUrl(handle, '/api/auth/password'), {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ currentPassword: 'secret123' }),
    });
    expect(response.status).toBe(200);
    const auth = await readHqAuthFile(dataDir);
    expect(auth.passwordHash).toBeUndefined();
    expect(auth.cookieSecret).toBeUndefined();
  });

  it('refuses to remove the final browser credential while a public relay is active', async () => {
    handle = await startHqServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      password: 'secret123',
    });
    await writeHqAuthFile(dataDir, {
      ...(await readHqAuthFile(dataDir)),
      browserTokens: [],
    });
    await handle.close();
    handle = await startHqServer({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      requireBrowserAuth: true,
    });
    const { cookie } = await login(handle, 'secret123');

    const response = await fetch(httpUrl(handle, '/api/auth/password'), {
      method: 'DELETE',
      headers: { Cookie: cookie!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'secret123' }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('BROWSER_AUTH_REQUIRED');
    expect((await readHqAuthFile(dataDir)).passwordHash).toMatch(/^scrypt\$/);
  });

  it('login lockout persists across server restart (M1)', async () => {
    await seedAuthFile({ password: 'secret123' });

    // First start: fail login once to trigger initial backoff (2s window).
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
    const fail1 = await login(handle, 'wrong');
    expect(fail1.res.status).toBe(401);

    // Second attempt immediately should be rate-limited (IP is in backoff).
    const locked = await login(handle, 'wrong');
    expect(locked.res.status).toBe(429);
    expect(locked.res.headers.get('retry-after')).not.toBeNull();

    // Close the server — the lockout state must survive in login-attempts.json.
    await handle.close();
    handle = null;

    // The LoginAttemptStore has a 500ms debounced write; allow it to flush.
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Verify the persistence file exists and has a non-expired entry.
    const lockoutFile = path.join(dataDir, 'login-attempts.json');
    const raw = await fs.readFile(lockoutFile, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, { blockedUntil: number }>;
    const anyBlocked = Object.values(parsed).some((e) => e.blockedUntil > Date.now());
    expect(anyBlocked).toBe(true);

    // Restart with the same dataDir.
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    // Give the store a moment to load from disk (fire-and-forget on startup).
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Same IP should still be locked out — the lockout survived the restart.
    const stillLocked = await login(handle, 'wrong');
    expect(stillLocked.res.status).toBe(429);

    // Correct password should also be blocked (IP is locked, not just the
    // wrong credential).
    const correctButLocked = await login(handle, 'secret123');
    expect(correctButLocked.res.status).toBe(429);
  });

  it('keeps cred: entries in memory and does not persist password hashes to login-attempts.json (SEC-001)', async () => {
    await seedAuthFile({ password: 'secret123' });
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    // Fail login with a specific candidate password
    const badPass = 'MyWrongPassword456!';
    const fail = await login(handle, badPass);
    expect(fail.res.status).toBe(401);

    await handle.close();
    handle = null;
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Verify disk content
    const lockoutFile = path.join(dataDir, 'login-attempts.json');
    const raw = await fs.readFile(lockoutFile, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // IP entries exist on disk, but NO cred: entries exist on disk
    expect(Object.keys(parsed).some((k) => k.startsWith('cred:'))).toBe(false);
  });
});

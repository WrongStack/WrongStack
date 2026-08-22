import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HQ_AUTH_FILE_VERSION,
  hashHqPassword,
  mintHqCookieSecret,
  mutateHqAuthFile,
  readHqAuthFile,
  writeHqAuthFile,
} from '@wrongstack/core/hq';
import {
  generateRecoveryCodes,
  generateTotp,
  generateTotpSecret,
  hashRecoveryCode,
} from '@wrongstack/core/security';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

let handle: HqServerHandle | null = null;
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-totp-'));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

const PASSWORD = 'secret123';
const SEEDED_TOKEN = 't'.repeat(64);

function httpUrl(pathname: string): string {
  return `http://${handle!.host}:${handle!.port}${pathname}`;
}

async function seedPasswordAuth(): Promise<void> {
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [{ id: 'seeded', token: SEEDED_TOKEN, createdAt: new Date().toISOString() }],
    passwordHash: await hashHqPassword(PASSWORD),
    cookieSecret: mintHqCookieSecret(),
  });
}

async function login(password: string): Promise<{ res: Response; cookie: string | null }> {
  const res = await fetch(httpUrl('/api/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const rawCookie = res.headers.get('set-cookie');
  return { res, cookie: rawCookie?.split(';')[0] ?? null };
}

async function loginAndVerify(code: string, cookie: string): Promise<Response> {
  return fetch(httpUrl('/api/login/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code }),
  });
}

async function authedFetch(
  pathname: string,
  opts: RequestInit = {},
  cookie?: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (cookie) headers['Cookie'] = cookie;
  else headers['Authorization'] = `Bearer ${SEEDED_TOKEN}`;
  return fetch(httpUrl(pathname), { ...opts, headers });
}

describe('HQ server — TOTP 2FA', () => {
  it('login without TOTP returns loggedIn true', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir, password: PASSWORD });
    const { res, cookie } = await login(PASSWORD);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loggedIn: boolean; totpRequired?: boolean };
    expect(body.loggedIn).toBe(true);
    expect(body.totpRequired).toBeUndefined();
    expect(cookie).toMatch(/hq\.session=/);
  });

  it('login with TOTP enabled returns totpRequired and no full session', async () => {
    await seedPasswordAuth();
    // Seed a TOTP secret directly
    const secret = generateTotpSecret();
    await mutateHqAuthFile(dataDir, (cur) => ({ ...cur, totpSecret: secret }));
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const { res, cookie } = await login(PASSWORD);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loggedIn: boolean; totpRequired: boolean };
    expect(body.loggedIn).toBe(false);
    expect(body.totpRequired).toBe(true);

    // The cookie is a pending-2FA session — it must NOT work on other routes
    const snap = await fetch(httpUrl('/api/snapshot'), { headers: { Cookie: cookie! } });
    expect(snap.status).toBe(401);
  });

  it('login/verify with a valid TOTP code upgrades to a full session', async () => {
    await seedPasswordAuth();
    const secret = generateTotpSecret();
    await mutateHqAuthFile(dataDir, (cur) => ({ ...cur, totpSecret: secret }));
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const { cookie } = await login(PASSWORD);
    expect(cookie).not.toBeNull();

    const code = generateTotp(secret);
    const verifyRes = await loginAndVerify(code, cookie!);
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as { loggedIn: boolean };
    expect(verifyBody.loggedIn).toBe(true);

    // The new cookie from the verify response works on /api/snapshot
    const verifyCookie = verifyRes.headers.get('set-cookie')?.split(';')[0] ?? null;
    expect(verifyCookie).toMatch(/hq\.session=/);
    const snap = await fetch(httpUrl('/api/snapshot'), { headers: { Cookie: verifyCookie! } });
    expect(snap.status).toBe(200);
  });

  it('login/verify with an invalid code is rejected', async () => {
    await seedPasswordAuth();
    const secret = generateTotpSecret();
    await mutateHqAuthFile(dataDir, (cur) => ({ ...cur, totpSecret: secret }));
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const { cookie } = await login(PASSWORD);
    const verifyRes = await loginAndVerify('000000', cookie!);
    expect(verifyRes.status).toBe(401);
  });

  it('login/verify rate-limits repeated failures', async () => {
    await seedPasswordAuth();
    const secret = generateTotpSecret();
    await mutateHqAuthFile(dataDir, (cur) => ({ ...cur, totpSecret: secret }));
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const { cookie } = await login(PASSWORD);
    expect(cookie).not.toBeNull();

    const firstFailure = await loginAndVerify('000000', cookie!);
    expect(firstFailure.status).toBe(401);

    const throttled = await loginAndVerify('000000', cookie!);
    expect(throttled.status).toBe(429);
  });

  it('recovery code verifies and is consumed', async () => {
    await seedPasswordAuth();
    const secret = generateTotpSecret();
    const codes = generateRecoveryCodes();
    const hashes = codes.map(hashRecoveryCode);
    await mutateHqAuthFile(dataDir, (cur) => ({
      ...cur,
      totpSecret: secret,
      totpRecoveryCodes: hashes,
    }));
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const { cookie } = await login(PASSWORD);
    // Use the first recovery code
    const verifyRes = await fetch(httpUrl('/api/login/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie! },
      body: JSON.stringify({ recoveryCode: codes[0] }),
    });
    expect(verifyRes.status).toBe(200);
    const body = (await verifyRes.json()) as { loggedIn: boolean; recoveryCodesRemaining: number };
    expect(body.loggedIn).toBe(true);
    expect(body.recoveryCodesRemaining).toBe(codes.length - 1);

    // The same recovery code should NOT work again (single-use)
    const { cookie: cookie2 } = await login(PASSWORD);
    const reuseRes = await fetch(httpUrl('/api/login/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2! },
      body: JSON.stringify({ recoveryCode: codes[0] }),
    });
    expect(reuseRes.status).toBe(401);
  });

  it('totp setup accepts an authenticated password-session cookie', async () => {
    await seedPasswordAuth();
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const { cookie } = await login(PASSWORD);
    const res = await authedFetch('/api/auth/totp/setup', { method: 'POST' }, cookie);

    expect(cookie).not.toBeNull();
    expect(res.status).toBe(200);
  });

  it('totp setup writes pending secret, not active', async () => {
    await seedPasswordAuth();
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const res = await authedFetch('/api/auth/totp/setup', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secret: string; uri: string; enabled: boolean };
    expect(body.secret).toHaveLength(32);
    expect(body.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(body.enabled).toBe(false);

    // Login should NOT require TOTP yet (pending, not active)
    const { res: loginRes } = await login(PASSWORD);
    const loginBody = (await loginRes.json()) as { totpRequired?: boolean };
    expect(loginBody.totpRequired).toBeUndefined();
  });

  it('totp enable promotes pending to active and returns recovery codes', async () => {
    await seedPasswordAuth();
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const { cookie } = await login(PASSWORD);

    // Step 1: setup through the authenticated password session.
    const setupRes = await authedFetch('/api/auth/totp/setup', { method: 'POST' }, cookie);
    const setupBody = (await setupRes.json()) as { secret: string };

    // Step 2: enable through the same session with a valid code.
    const code = generateTotp(setupBody.secret);
    const enableRes = await authedFetch(
      '/api/auth/totp/enable',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      },
      cookie,
    );
    expect(enableRes.status).toBe(200);
    const enableBody = (await enableRes.json()) as { enabled: boolean; recoveryCodes: string[] };
    expect(enableBody.enabled).toBe(true);
    expect(enableBody.recoveryCodes).toHaveLength(8);

    // Login should now require TOTP
    const { res: loginRes } = await login(PASSWORD);
    const loginBody = (await loginRes.json()) as { totpRequired?: boolean };
    expect(loginBody.totpRequired).toBe(true);
  });

  it('totp disable removes 2FA entirely', async () => {
    await seedPasswordAuth();
    const secret = generateTotpSecret();
    const hashes = generateRecoveryCodes().map(hashRecoveryCode);
    await mutateHqAuthFile(dataDir, (cur) => ({
      ...cur,
      totpSecret: secret,
      totpRecoveryCodes: hashes,
    }));
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const { res: pendingRes, cookie: pendingCookie } = await login(PASSWORD);
    expect((await pendingRes.json()) as { totpRequired?: boolean }).toMatchObject({
      totpRequired: true,
    });
    const verified = await loginAndVerify(generateTotp(secret), pendingCookie!);
    const cookie = verified.headers.get('set-cookie')?.split(';')[0] ?? null;
    expect(verified.status).toBe(200);
    expect(cookie).not.toBeNull();

    // Disable with the password through the verified password session.
    const res = await authedFetch(
      '/api/auth/totp/disable',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      },
      cookie,
    );
    expect(res.status).toBe(200);

    // Login should NOT require TOTP anymore
    const { res: loginRes } = await login(PASSWORD);
    const loginBody = (await loginRes.json()) as { totpRequired?: boolean };
    expect(loginBody.totpRequired).toBeUndefined();
  });

  it('totp disable rate-limits repeated invalid confirmations', async () => {
    await seedPasswordAuth();
    const secret = generateTotpSecret();
    await mutateHqAuthFile(dataDir, (cur) => ({ ...cur, totpSecret: secret }));
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const invalid = await authedFetch('/api/auth/totp/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    expect(invalid.status).toBe(403);

    const throttled = await authedFetch('/api/auth/totp/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    expect(throttled.status).toBe(429);
  });

  it('auth/status reports totpEnabled', async () => {
    await seedPasswordAuth();
    const secret = generateTotpSecret();
    await mutateHqAuthFile(dataDir, (cur) => ({ ...cur, totpSecret: secret }));
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const res = await fetch(httpUrl('/api/auth/status'));
    const body = (await res.json()) as { totpEnabled: boolean; recoveryCodesRemaining: number };
    expect(body.totpEnabled).toBe(true);
  });

  it('totp setup rejects unauthenticated requests', async () => {
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir, password: PASSWORD });
    const res = await fetch(httpUrl('/api/auth/totp/setup'), { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('totp setup with already-active 2FA returns 409', async () => {
    await seedPasswordAuth();
    const secret = generateTotpSecret();
    await mutateHqAuthFile(dataDir, (cur) => ({ ...cur, totpSecret: secret }));
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const res = await authedFetch('/api/auth/totp/setup', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('recovery code double-spend: concurrent requests — first succeeds, second gets 409', async () => {
    await seedPasswordAuth();
    const secret = generateTotpSecret();
    const codes = generateRecoveryCodes();
    const hashes = codes.map(hashRecoveryCode);
    await mutateHqAuthFile(dataDir, (cur) => ({
      ...cur,
      totpSecret: secret,
      totpRecoveryCodes: hashes,
    }));
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    // Login to get a pending-2FA session cookie.
    const { cookie } = await login(PASSWORD);
    expect(cookie).not.toBeNull();

    // Fire two concurrent verify requests with the SAME recovery code.
    // The mutator re-reads on-disk hashes inside mutateHqAuthFile, so only
    // one request finds the hash; the other gets 409 RECOVERY_CODE_ALREADY_USED.
    const recoveryCode = codes[0]!;
    const [resA, resB] = await Promise.all([
      fetch(httpUrl('/api/login/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie! },
        body: JSON.stringify({ recoveryCode }),
      }),
      fetch(httpUrl('/api/login/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie! },
        body: JSON.stringify({ recoveryCode }),
      }),
    ]);

    // Exactly one must succeed (200) and the other must get 409.
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    // The successful one reports loggedIn: true; the 409 has the right code.
    const ok = resA.status === 200 ? resA : resB;
    const conflict = resA.status === 409 ? resA : resB;
    const okBody = (await ok.json()) as { loggedIn: boolean };
    expect(okBody.loggedIn).toBe(true);
    const conflictBody = (await conflict.json()) as { error: { code: string } };
    expect(conflictBody.error.code).toBe('RECOVERY_CODE_ALREADY_USED');
  });

  it('persists totpLastUsedCounter to auth.json on successful TOTP verification (SEC-002)', async () => {
    await seedPasswordAuth();
    const secret = generateTotpSecret();
    await mutateHqAuthFile(dataDir, (cur) => ({ ...cur, totpSecret: secret }));
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });

    const { cookie } = await login(PASSWORD);
    expect(cookie).not.toBeNull();

    const validCode = generateTotp(secret);
    const verifyRes = await loginAndVerify(validCode, cookie!);
    expect(verifyRes.status).toBe(200);

    // Verify counter was written to disk in auth.json
    const updated = await readHqAuthFile(dataDir);
    expect(typeof updated.totpLastUsedCounter).toBe('number');
    expect(updated.totpLastUsedCounter).toBeGreaterThan(0);
  });
});

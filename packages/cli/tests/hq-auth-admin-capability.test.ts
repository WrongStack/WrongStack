/**
 * WS-101 / WS-102 / WS-103 — regressions for the HQ auth audit.
 *
 * Three defects, all of the same shape: a security decision that existed in
 * one place and was re-derived, weakened, or skipped in another.
 *
 *  - WS-101 the in-process auth-mutation routes ran their own copy of the
 *    live-auth projection, which skipped the expired-token filter on the client
 *    scope and never re-ran the WS-010 exposure assessment.
 *  - WS-102 the account-security routes gated on "is authenticated" rather than
 *    on a capability, so the least-privileged token HQ mints on first run could
 *    enroll 2FA and lock the operator out.
 *  - WS-103 every session-cookie reader preferred the unprefixed cookie name
 *    over the `__Host-`-prefixed one.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HQ_AUTH_FILE_VERSION,
  type HqAuthFile,
  hashHqPassword,
  mintHqCookieSecret,
  writeHqAuthFile,
} from '@wrongstack/core/hq';
import { generateTotp, generateTotpSecret, verifyTotpCounter } from '@wrongstack/core/security';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hqAuthRequired, readHqSessionCookie } from '../src/hq-server/auth.js';
import { createHqAuthState, projectAuthFile } from '../src/hq-server/auth-state.js';
import { LoginAttemptStore } from '../src/hq-server/login-attempt-store.js';
import { callerCanAdministerAuth } from '../src/hq-server/routes/auth-handlers.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

const PAST = new Date(Date.now() - 60_000).toISOString();

function authFile(over: Partial<HqAuthFile> = {}): HqAuthFile {
  return {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    ...over,
  } as HqAuthFile;
}

describe('WS-101 — one projection, one floor evaluation', () => {
  it('drops expired client tokens (the /ws/client gate does no expiry check of its own)', () => {
    const state = createHqAuthState(authFile(), '/tmp/unused');
    state.apply(
      authFile({
        clientTokens: [
          { id: 'c-live', token: 'a'.repeat(64), createdAt: PAST },
          { id: 'c-dead', token: 'b'.repeat(64), createdAt: PAST, expiresAt: PAST },
        ],
      }),
    );
    expect(state.mutableAuth.clientTokens.size).toBe(1);
    expect(state.mutableAuth.clientTokenObjs.size).toBe(1);
    expect([...state.mutableAuth.clientTokenObjs.values()][0]?.id).toBe('c-live');
  });

  it('drops expired browser tokens through the same projection', () => {
    const mutableAuth = createHqAuthState(authFile(), '/tmp/unused').mutableAuth;
    projectAuthFile(
      mutableAuth,
      authFile({
        browserTokens: [{ id: 'b-dead', token: 'c'.repeat(64), createdAt: PAST, expiresAt: PAST }],
      }),
    );
    expect(mutableAuth.browserTokens.size).toBe(0);
    expect(mutableAuth.browserTokenObjs.size).toBe(0);
  });

  it('re-runs the exposure hook on every apply, so removing the last credential re-latches the floor', () => {
    const applied: Array<{ hasPassword: boolean }> = [];
    const state = createHqAuthState(
      authFile({ passwordHash: 'scrypt$aa$bb', cookieSecret: 'sekret' }),
      '/tmp/unused',
      {
        onApplied: (live) => {
          applied.push({ hasPassword: live.passwordHash !== undefined });
          // Stand-in for `assessHqExposure` on a non-loopback bind.
          live.requireAuthFloor = live.browserTokens.size === 0 && live.passwordHash === undefined;
        },
      },
    );

    state.mutableAuth.requireAuthFloor = false;
    expect(hqAuthRequired(state.mutableAuth, undefined)).toBe(true);

    // The route path for `DELETE /api/auth/password` goes through `apply`.
    state.apply(authFile());

    expect(applied).toEqual([{ hasPassword: false }]);
    expect(state.mutableAuth.requireAuthFloor).toBe(true);
    // The gate stays closed instead of dropping into open mode.
    expect(hqAuthRequired(state.mutableAuth, undefined)).toBe(true);
  });

  it('keeps tokenStats() in step with the applied file', () => {
    const state = createHqAuthState(
      authFile({
        browserTokens: [{ id: 'b1', token: 'd'.repeat(64), createdAt: PAST, expiresAt: PAST }],
      }),
      '/tmp/unused',
    );
    expect(state.tokenStats().expired).toBe(1);
    state.apply(authFile({ browserTokens: [] }));
    expect(state.tokenStats().expired).toBe(0);
    expect(state.tokenStats().browserTotal).toBe(0);
  });
});

describe('WS-102 — auth.admin capability policy', () => {
  it('admits a password-origin cookie session', () => {
    expect(callerCanAdministerAuth({ kind: 'cookie' })).toBe(true);
  });

  it('admits an unrestricted token (capabilities absent = unrestricted by contract)', () => {
    expect(callerCanAdministerAuth({ kind: 'token', token: 'x', id: 'i' })).toBe(true);
  });

  it('refuses the least-privileged token HQ mints on first run', () => {
    expect(
      callerCanAdministerAuth({
        kind: 'token',
        token: 'x',
        id: 'i',
        capabilities: ['control.enqueue'],
      }),
    ).toBe(false);
  });

  it('refuses a token-origin cookie session that lacks the capability', () => {
    expect(
      callerCanAdministerAuth({ kind: 'cookie', tokenId: 'i', capabilities: ['control.enqueue'] }),
    ).toBe(false);
  });

  it('admits a token that explicitly carries auth.admin', () => {
    expect(
      callerCanAdministerAuth({
        kind: 'token',
        token: 'x',
        id: 'i',
        capabilities: ['control.enqueue', 'auth.admin'],
      }),
    ).toBe(true);
  });

  it('refuses an unauthenticated caller', () => {
    expect(callerCanAdministerAuth(undefined)).toBe(false);
  });
});

describe('WS-103 — session cookie name preference', () => {
  it('prefers the __Host- prefixed cookie when both names are present', () => {
    expect(readHqSessionCookie('hq.session=injected; __Host-hq.session=genuine')).toBe('genuine');
    expect(readHqSessionCookie('__Host-hq.session=genuine; hq.session=injected')).toBe('genuine');
  });

  it('falls back to the plain name on loopback deployments', () => {
    expect(readHqSessionCookie('hq.session=loopback')).toBe('loopback');
  });

  it('returns undefined when neither is present', () => {
    expect(readHqSessionCookie('other=1')).toBeUndefined();
    expect(readHqSessionCookie(undefined)).toBeUndefined();
  });
});

describe('WS-104 — credential-scoped login backoff', () => {
  it('keys on the password alone, so rotating IPs cannot reset the counter', () => {
    const a = LoginAttemptStore.credentialKey('hunter2');
    const b = LoginAttemptStore.credentialKey('hunter2');
    const c = LoginAttemptStore.credentialKey('different');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('127.0.0.1');
  });

  it('blocks a repeated password guess arriving from a fresh IP', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-attempts-'));
    try {
      const store = new LoginAttemptStore(dir);
      // Three failures of the same password from three different addresses.
      store.recordFailure('10.0.0.1', 'guess');
      store.recordFailure('10.0.0.2', 'guess');
      store.recordFailure('10.0.0.3', 'guess');

      // A fourth, previously-unseen IP has a clean IP counter…
      expect(store.checkBlocked('10.0.0.9').blocked).toBe(false);
      // …but the credential counter has seen this password three times.
      expect(store.checkBlocked('10.0.0.9', 'guess').blocked).toBe(true);
      // A different password from that IP is unaffected.
      expect(store.checkBlocked('10.0.0.9', 'other').blocked).toBe(false);
      await store.flush();
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  });

  it('does not accumulate a shared cred:sha256("") counter for passwordless flows', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-attempts-'));
    try {
      const store = new LoginAttemptStore(dir);
      // The 2FA-verify path records failures with no password.
      store.recordFailure('10.0.0.1');
      store.recordFailure('10.0.0.2');
      // Only the two IP entries exist — no shared credential bucket.
      expect(store.size).toBe(2);
      await store.flush();
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  });
});

describe('WS-105 — TOTP codes are single-use', () => {
  it('verifyTotpCounter reports the matched step', () => {
    const secret = generateTotpSecret();
    const at = 1_700_000_000_000;
    const code = generateTotp(secret, at);
    expect(verifyTotpCounter(code, secret, at)).toBe(Math.floor(at / 1000 / 30));
    expect(verifyTotpCounter('000000', secret, at)).toBeUndefined();
  });

  it('a code from the previous step still verifies inside the ±1 window', () => {
    const secret = generateTotpSecret();
    const at = 1_700_000_000_000;
    const previous = generateTotp(secret, at - 30_000);
    // This is the replay surface: arithmetically valid ~90s, which is why the
    // server records the matched counter rather than trusting the boolean.
    expect(verifyTotpCounter(previous, secret, at)).toBe(Math.floor(at / 1000 / 30) - 1);
  });
});

describe('WS-102 — end to end over HTTP', () => {
  let handle: HqServerHandle | null = null;
  let dataDir: string;
  const SCOPED = 'e'.repeat(64);
  const ADMIN = 'f'.repeat(64);

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-authadmin-'));
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        {
          id: 'scoped',
          token: SCOPED,
          createdAt: new Date().toISOString(),
          capabilities: ['control.enqueue'],
        },
        {
          id: 'admin',
          token: ADMIN,
          createdAt: new Date().toISOString(),
          capabilities: ['control.enqueue', 'auth.admin'],
        },
      ],
      passwordHash: await hashHqPassword('secret123'),
      cookieSecret: mintHqCookieSecret(),
    });
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });

  const call = (pathname: string, token: string, method = 'POST'): Promise<Response> =>
    fetch(`http://${handle!.host}:${handle!.port}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });

  it('a control.enqueue-only token cannot start TOTP enrollment', async () => {
    const res = await call('/api/auth/totp/setup', SCOPED);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'AUTH_ADMIN_REQUIRED',
    );
  });

  it('a control.enqueue-only token cannot revoke sessions or read the auth audit', async () => {
    expect((await call('/api/auth/sessions', SCOPED, 'DELETE')).status).toBe(403);
    expect((await call('/api/auth/sessions', SCOPED, 'GET')).status).toBe(403);
    expect((await call('/api/auth/audit', SCOPED, 'GET')).status).toBe(403);
  });

  it('an auth.admin token still reaches the same routes', async () => {
    expect((await call('/api/auth/audit', ADMIN, 'GET')).status).toBe(200);
    expect((await call('/api/auth/sessions', ADMIN, 'GET')).status).toBe(200);
    // TOTP setup succeeds and returns a pending (not yet active) secret.
    const res = await call('/api/auth/totp/setup', ADMIN);
    expect(res.status).toBe(200);
    expect((await res.json()) as { enabled: boolean }).toMatchObject({ enabled: false });
  });

  it('the scoped token keeps the capability it was granted', async () => {
    const res = await fetch(`http://${handle!.host}:${handle!.port}/api/snapshot`, {
      headers: { Authorization: `Bearer ${SCOPED}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('WS-105 — /api/login/verify refuses a replayed TOTP code', () => {
  let handle: HqServerHandle | null = null;
  let dataDir: string;
  const PASSWORD = 'secret123';
  let secret: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-totp-replay-'));
    secret = generateTotpSecret();
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      passwordHash: await hashHqPassword(PASSWORD),
      cookieSecret: mintHqCookieSecret(),
      totpSecret: secret,
    });
    handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });

  const url = (p: string): string => `http://${handle!.host}:${handle!.port}${p}`;

  async function loginForPendingCookie(): Promise<string> {
    const res = await fetch(url('/api/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(await res.json()).toMatchObject({ totpRequired: true });
    return res.headers.get('set-cookie')?.split(';')[0] ?? '';
  }

  const verify = (code: string, cookie: string): Promise<Response> =>
    fetch(url('/api/login/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ code }),
    });

  it('accepts a code once, then rejects the same code on a second login', async () => {
    const code = generateTotp(secret);

    const firstCookie = await loginForPendingCookie();
    const first = await verify(code, firstCookie);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ loggedIn: true });

    // Same code, fresh pending session — the ±1-step window still makes it
    // arithmetically valid, but the counter has been spent.
    const secondCookie = await loginForPendingCookie();
    const second = await verify(code, secondCookie);
    expect(second.status).toBe(401);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      'TOTP_ALREADY_USED',
    );
  });
});

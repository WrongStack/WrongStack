/**
 * HQ key vault over HTTP: an operator stores a key, enrolls a device with a
 * one-time token, grants the key, and the device fetches it — sealed to its
 * own keys and signed by HQ. Around that: the vault refuses to run without an
 * operator password, refuses changes without a fresh password (+ TOTP) proof,
 * refuses changes over a plain-HTTP non-loopback channel, and serves device
 * routes without a browser credential.
 */
import * as fs from 'node:fs/promises';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildHqVaultEnrollRequest,
  buildHqVaultFetchRequest,
  generateHqVaultKeyPair,
  HQ_AUTH_FILE_VERSION,
  HQ_VAULT_FILE,
  type HqVaultBundle,
  type HqVaultEnrollResponse,
  hashHqPassword,
  mintHqCookieSecret,
  openHqVaultBundle,
  verifyHqVaultEnrollResponse,
  writeHqAuthFile,
} from '@wrongstack/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isHqVaultSecureChannel } from '../src/hq-server/routes/vault-handlers.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

const ADMIN = 'a'.repeat(64);
const SCOPED = 'b'.repeat(64);
const PASSWORD = 'operator-password-1';
const API_KEY = 'sk-live-looking-test-value-0123456789';

let handle: HqServerHandle | null = null;
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-vault-routes-'));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

async function start(options: { password?: boolean } = {}): Promise<void> {
  const now = new Date().toISOString();
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: now,
    browserTokens: [
      {
        id: 'admin',
        token: ADMIN,
        createdAt: now,
        capabilities: ['control.enqueue', 'auth.admin'],
      },
      { id: 'scoped', token: SCOPED, createdAt: now, capabilities: ['control.enqueue'] },
    ],
    ...(options.password !== false
      ? { passwordHash: await hashHqPassword(PASSWORD), cookieSecret: mintHqCookieSecret() }
      : {}),
  });
  handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
}

async function api(
  pathname: string,
  options: { token?: string; method?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${handle!.port}${pathname}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      'Content-Type': 'application/json',
      ...(options.token !== undefined ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const errorCode = (r: { json: Record<string, unknown> }): unknown =>
  (r.json.error as { code?: unknown } | undefined)?.code;

describe('HQ key vault routes', () => {
  it('runs the whole flow: store, enroll, grant, fetch, rotate', async () => {
    await start();

    // Admin only.
    expect((await api('/api/vault/status', { token: SCOPED })).status).toBe(403);
    const status = await api('/api/vault/status', { token: ADMIN });
    expect(status.json).toMatchObject({ state: 'unsealed', secureChannel: true });

    // Changes need a fresh password proof.
    const early = await api('/api/vault/secrets', {
      token: ADMIN,
      body: { providerId: 'openai', label: 'team', apiKey: API_KEY },
    });
    expect(errorCode(early)).toBe('VAULT_ELEVATION_REQUIRED');
    expect(
      errorCode(await api('/api/vault/elevate', { token: ADMIN, body: { password: 'wrong' } })),
    ).toBe('INVALID_CREDENTIALS');
    // The failed proof shares the login backoff: an immediate retry is held off.
    expect(
      (await api('/api/vault/elevate', { token: ADMIN, body: { password: PASSWORD } })).status,
    ).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const elevated = await api('/api/vault/elevate', {
      token: ADMIN,
      body: { password: PASSWORD },
    });
    expect(elevated.status).toBe(200);

    const created = await api('/api/vault/secrets', {
      token: ADMIN,
      body: { providerId: 'openai', label: 'team', apiKey: API_KEY },
    });
    expect(created.status).toBe(201);
    const secretId = (created.json.secret as { id: string }).id;
    const listed = await api('/api/vault/secrets', { token: ADMIN });
    expect(JSON.stringify(listed.json)).not.toContain(API_KEY);
    expect(await fs.readFile(path.join(dataDir, HQ_VAULT_FILE), 'utf8')).not.toContain(API_KEY);

    // Enroll a device with the one-time token, over no browser credential.
    const minted = await api('/api/vault/enrollment-codes', {
      token: ADMIN,
      body: { label: 'LAB-02' },
    });
    expect(minted.status).toBe(201);
    const keys = generateHqVaultKeyPair();
    const { request, code } = buildHqVaultEnrollRequest(
      keys,
      minted.json.enrollmentToken as string,
      {
        hostname: 'LAB-02',
      },
    );
    const enrolled = await api('/api/vault/enroll', { body: request });
    expect(enrolled.status).toBe(200);
    const pinned = verifyHqVaultEnrollResponse(
      enrolled.json as unknown as HqVaultEnrollResponse,
      request,
      code,
    );
    expect(pinned.fingerprint).toBe((minted.json.hq as { fingerprint: string }).fingerprint);
    const deviceId = (enrolled.json as unknown as HqVaultEnrollResponse).deviceId;

    // Nothing granted yet.
    const emptyReq = buildHqVaultFetchRequest(keys, { mode: 'fetch' });
    const empty = await api('/api/vault/fetch', { body: emptyReq });
    expect((empty.json as unknown as HqVaultBundle).items).toEqual([]);

    expect(
      (
        await api('/api/vault/grants', {
          token: ADMIN,
          body: { secretId, deviceId, setActive: true },
        })
      ).status,
    ).toBe(201);
    const req = buildHqVaultFetchRequest(keys, { mode: 'fetch' });
    const fetched = await api('/api/vault/fetch', { body: req });
    expect(fetched.status).toBe(200);
    expect(JSON.stringify(fetched.json)).not.toContain(API_KEY);
    const opened = openHqVaultBundle(fetched.json as unknown as HqVaultBundle, keys, pinned, req);
    expect(opened[0]).toMatchObject({ providerId: 'openai', apiKey: API_KEY, setActive: true });

    // Replaying the same signed request is refused.
    expect(errorCode(await api('/api/vault/fetch', { body: req }))).toBe('VAULT_DENIED');

    // Rotation reaches the device.
    await api(`/api/vault/secrets/${secretId}/rotate`, {
      token: ADMIN,
      body: { apiKey: 'sk-next' },
    });
    const req2 = buildHqVaultFetchRequest(keys, { mode: 'fetch' });
    const after = openHqVaultBundle(
      (await api('/api/vault/fetch', { body: req2 })).json as unknown as HqVaultBundle,
      keys,
      pinned,
      req2,
    );
    expect(after[0]).toMatchObject({ version: 2, apiKey: 'sk-next' });

    // Revoking the device ends delivery.
    expect(
      (
        await api(`/api/vault/devices/${deviceId}/revoke`, {
          token: ADMIN,
          method: 'POST',
          body: {},
        })
      ).status,
    ).toBe(200);
    expect(
      errorCode(
        await api('/api/vault/fetch', { body: buildHqVaultFetchRequest(keys, { mode: 'fetch' }) }),
      ),
    ).toBe('VAULT_DENIED');
  });

  it('serves the audit trail newest first, without values', async () => {
    await start();
    await api('/api/vault/elevate', { token: ADMIN, body: { password: PASSWORD } });
    await api('/api/vault/secrets', {
      token: ADMIN,
      body: { providerId: 'openai', label: 'team', apiKey: API_KEY },
    });
    await api('/api/vault/enrollment-codes', { token: ADMIN, body: {} });
    const audit = await api('/api/vault/audit?limit=10', { token: ADMIN });
    expect(audit.status).toBe(200);
    const kinds = (audit.json.entries as { kind: string }[]).map((e) => e.kind);
    expect(kinds).toEqual(['enrollment.mint', 'secret.create']);
    expect(JSON.stringify(audit.json)).not.toContain(API_KEY);
    expect((await api('/api/vault/audit', { token: SCOPED })).status).toBe(403);
  });

  it('a device request signed by someone else is refused without a browser credential', async () => {
    await start();
    await api('/api/vault/status', { token: ADMIN });
    const stranger = buildHqVaultFetchRequest(generateHqVaultKeyPair(), { mode: 'fetch' });
    const res = await api('/api/vault/fetch', { body: stranger });
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('VAULT_DENIED');
  });

  it('the vault refuses to run without an operator password', async () => {
    await start({ password: false });
    expect((await api('/api/vault/status', { token: ADMIN })).json).toMatchObject({
      state: 'unavailable',
      passwordConfigured: false,
    });
    expect(
      errorCode(await api('/api/vault/elevate', { token: ADMIN, body: { password: 'x' } })),
    ).toBe('VAULT_REQUIRES_PASSWORD');
    expect((await api('/api/vault/enroll', { body: {} })).status).toBe(404);
    // No vault files were created by any of it.
    await expect(fs.access(path.join(dataDir, HQ_VAULT_FILE))).rejects.toThrow();
  });
});

describe('isHqVaultSecureChannel', () => {
  const req = (remoteAddress: string, extra: Partial<http.IncomingMessage> = {}) =>
    ({ socket: { remoteAddress }, headers: {}, ...extra }) as unknown as http.IncomingMessage;

  it('accepts loopback and TLS sockets, refuses plain HTTP from the LAN', () => {
    expect(isHqVaultSecureChannel(req('127.0.0.1'), 0)).toBe(true);
    expect(isHqVaultSecureChannel(req('::ffff:127.0.0.1'), 0)).toBe(true);
    expect(isHqVaultSecureChannel(req('192.168.1.20'), 0)).toBe(false);
    expect(
      isHqVaultSecureChannel(
        { socket: { remoteAddress: '192.168.1.20', encrypted: true }, headers: {} } as never,
        0,
      ),
    ).toBe(true);
  });

  it('believes X-Forwarded-Proto only behind a declared proxy', () => {
    const forwarded = req('192.168.1.20', { headers: { 'x-forwarded-proto': 'https' } } as never);
    expect(isHqVaultSecureChannel(forwarded, 0)).toBe(false);
    expect(isHqVaultSecureChannel(forwarded, 1)).toBe(true);
  });
});

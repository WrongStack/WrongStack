/**
 * HQ key vault, P4: an enrolled machine follows HQ without a manual Sync.
 * HQ counts operator changes (`revision`), announces them (`hq.vault_changed`)
 * and answers a cheap revision poll; the machine syncs once per change and
 * records what it has. A revoked device is told so in a statement signed by
 * HQ's pinned key, and only such a statement removes what HQ gave.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault } from '@wrongstack/core/security';
import {
  generateHqVaultKeyPair,
  HQ_AUTH_FILE_VERSION,
  HqVaultDeviceRevokedError,
  HqVaultSyncScheduler,
  hashHqPassword,
  hqVaultSign,
  mintHqCookieSecret,
  readHqDevice,
  writeHqAuthFile,
} from '@wrongstack/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HqVaultRouteState } from '../src/hq-server/routes/vault-handlers.js';
import { broadcastHqVaultChanged } from '../src/hq-server/vault-notice.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { HqCredentialService } from '../src/hq-vault/service.js';
import { loadConfigProviders, mutateConfigProviders } from '../src/provider-config-utils.js';

const ADMIN = 'd'.repeat(64);
const PASSWORD = 'operator-password-2';

let handle: HqServerHandle | null = null;
let root: string;
let hqDir: string;
let configPath: string;
let vault: DefaultSecretVault;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-vault-push-'));
  hqDir = path.join(root, 'hq');
  configPath = path.join(root, 'profiles', 'default', 'config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  vault = new DefaultSecretVault({ keyFile: path.join(root, '.key') });
  const now = new Date().toISOString();
  await writeHqAuthFile(hqDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: now,
    browserTokens: [
      {
        id: 'admin',
        token: ADMIN,
        createdAt: now,
        capabilities: ['control.enqueue', 'auth.admin'],
      },
    ],
    passwordHash: await hashHqPassword(PASSWORD),
    cookieSecret: mintHqCookieSecret(),
  });
  handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir: hqDir });
  await admin('/api/vault/elevate', { password: PASSWORD });
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

const origin = (): string => `http://127.0.0.1:${handle!.port}`;

async function admin(pathname: string, body?: unknown, method?: string) {
  const res = await fetch(`${origin()}${pathname}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${pathname}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** A service whose HQ requests are counted (and can be rewritten). */
function service(
  rewrite?: (url: string, response: Response, init?: RequestInit) => Promise<Response>,
): HqCredentialService & { calls: string[] } {
  const calls: string[] = [];
  const svc = new HqCredentialService({
    globalRoot: root,
    vault,
    profileConfigPath: configPath,
    hostname: 'LAB-03',
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(new URL(url).pathname);
      const response = await fetch(input, init);
      return rewrite ? rewrite(url, response, init) : response;
    }) as typeof fetch,
  });
  return Object.assign(svc, { calls });
}

async function enrollAndGrant(): Promise<string> {
  await admin('/api/vault/profiles', {
    id: 'team',
    type: 'openai',
    family: 'openai-compatible',
    baseUrl: 'https://llm.internal.example/v1',
    apiKey: 'sk-team-value-0123456789',
    keyLabel: 'team',
  });
  const minted = await admin('/api/vault/enrollment-codes', { autoApprove: true });
  const { device } = await service().enroll(origin(), minted.enrollmentToken);
  await admin(`/api/vault/profiles/team/devices/${device.deviceId}`, { granted: true }, 'PUT');
  return device.deviceId;
}

describe('HQ revision and background sync', () => {
  it('counts operator changes, answers the revision poll, and sync records what it has', async () => {
    const deviceId = await enrollAndGrant();
    const first = await service().revision();
    expect(first.revision).toBeGreaterThanOrEqual(2); // profile + grant

    await service().sync();
    expect((await readHqDevice(root, vault))?.syncedRevision).toBe(first.revision);

    // A device fetch (and its token renewals) is not an operator change.
    expect((await service().revision()).revision).toBe(first.revision);

    await admin('/api/vault/profiles/team', { models: ['gpt-team'] }, 'PATCH');
    const after = await service().revision();
    expect(after).toEqual({ hqId: first.hqId, revision: first.revision + 1 });
    expect(deviceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('the scheduler fetches only when HQ moved, once for a burst of notices', async () => {
    await enrollAndGrant();
    const svc = service();
    const scheduler = new HqVaultSyncScheduler({ service: svc, jitterMs: 0 });
    try {
      await scheduler.poll();
      expect(svc.calls.filter((p) => p === '/api/vault/fetch')).toHaveLength(1);
      await scheduler.poll(); // nothing moved: a revision GET, no fetch
      expect(svc.calls.filter((p) => p === '/api/vault/fetch')).toHaveLength(1);

      await admin('/api/vault/profiles/team', { models: ['gpt-next'] }, 'PATCH');
      const { hqId, revision } = await svc.revision();
      for (let i = 0; i < 3; i++) scheduler.notice({ hqId, revision });
      scheduler.notice({ hqId: 'f'.repeat(32), revision: revision + 5 }); // another HQ
      await expect
        .poll(async () => (await readHqDevice(root, vault))?.syncedRevision, { timeout: 15_000 })
        .toBe(revision);
      expect(svc.calls.filter((p) => p === '/api/vault/fetch')).toHaveLength(2);
      const providers = await loadConfigProviders(configPath, vault);
      expect(providers['team']?.models).toEqual(['gpt-next']);
    } finally {
      scheduler.stop();
    }
  });

  it('a revoked device removes what HQ gave on HQ’s signed word, and keeps its identity marked', async () => {
    const deviceId = await enrollAndGrant();
    await service().sync();
    expect(Object.keys(await loadConfigProviders(configPath, vault))).toContain('team');

    await admin(`/api/vault/devices/${deviceId}/revoke`, {});
    const error = await service()
      .sync()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HqVaultDeviceRevokedError);
    expect((error as HqVaultDeviceRevokedError).removed.map((r) => r.providerId)).toEqual(['team']);
    expect(await loadConfigProviders(configPath, vault)).not.toHaveProperty('team');
    const device = await readHqDevice(root, vault);
    expect(device?.status).toBe('revoked');
    expect(device?.revokedAt).toBeTruthy();
  });

  it('an unsigned, forged or replayed revocation removes nothing', async () => {
    await enrollAndGrant();
    await service().sync();
    const device = (await readHqDevice(root, vault))!;
    const impostor = generateHqVaultKeyPair();
    const forgeries: Array<(nonce: string) => unknown> = [
      () => undefined, // a bare 403
      (nonce) => {
        const body = {
          v: 2,
          hqId: device.hq.hqId,
          deviceId: device.deviceId,
          requestNonce: nonce,
          revokedAt: new Date().toISOString(),
        };
        // Signed, but not by the pinned HQ key.
        const sig = hqVaultSign({ ...body, purpose: 'wstack-hq-vault/v2/revoked' }, impostor);
        return { ...body, sig };
      },
      () => ({ v: 2, hqId: device.hq.hqId, deviceId: device.deviceId, requestNonce: 'old' }),
    ];
    for (const forge of forgeries) {
      const svc = service(async (url, response, init) => {
        if (!url.endsWith('/api/vault/fetch')) return response;
        await response.text();
        // The forgery answers the very request it intercepts.
        const { nonce } = JSON.parse(String(init?.body)) as { nonce: string };
        return new Response(
          JSON.stringify({
            error: { code: 'VAULT_DENIED', message: 'This device was revoked.' },
            revocation: forge(nonce),
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      });
      await expect(svc.sync()).rejects.not.toBeInstanceOf(HqVaultDeviceRevokedError);
    }
    expect(Object.keys(await loadConfigProviders(configPath, vault))).toContain('team');
    expect((await readHqDevice(root, vault))?.status).toBe('approved');
  });
});

describe('revocation inside the config lock', () => {
  it('a renewal (which runs inside the config lock) only fails; the next sync cleans up', async () => {
    const deviceId = await enrollAndGrant();
    await service().sync();
    const credential = (await loadConfigProviders(configPath, vault))['team']!.apiKeys![0]!;
    await admin(`/api/vault/devices/${deviceId}/revoke`, {});

    // The refresh transaction holds the config lock while it renews; a renewal
    // that tried to remove keys here would wait on that same lock forever.
    let outcome: unknown;
    const inLock = mutateConfigProviders(configPath, vault, async () => {
      outcome = await service()
        .renewKey(credential)
        .catch((e: unknown) => e);
    });
    const timedOut = new Promise((r) => setTimeout(() => r('timed out'), 10_000));
    expect(await Promise.race([inLock.then(() => 'done'), timedOut])).toBe('done');
    expect(outcome).toBeInstanceOf(HqVaultDeviceRevokedError);
    // Nothing written inside the lock; the device stays enrolled for the cleanup.
    expect(Object.keys(await loadConfigProviders(configPath, vault))).toContain('team');
    expect((await readHqDevice(root, vault))?.status).toBe('approved');

    await expect(service().sync()).rejects.toBeInstanceOf(HqVaultDeviceRevokedError);
    expect(await loadConfigProviders(configPath, vault)).not.toHaveProperty('team');
  }, 30_000);
});

describe('HQ side of the notice', () => {
  it('an unauthenticated revision check on an HQ that never used the vault creates nothing', async () => {
    const fresh = path.join(root, 'fresh-hq');
    await fs.cp(path.join(hqDir, 'auth.json'), path.join(fresh, 'auth.json'), {
      recursive: true,
    });
    const other = await startHqServer({ host: '127.0.0.1', port: 0, dataDir: fresh });
    try {
      const res = await fetch(`http://127.0.0.1:${other.port}/api/vault/revision`);
      expect(res.status).toBe(404);
      const files = await fs.readdir(fresh);
      expect(files.filter((f) => f.startsWith('hq-vault'))).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('announces each operator change with the HQ id and the new revision', async () => {
    const state = new HqVaultRouteState(path.join(root, 'hq-notice'));
    const seen: Array<{ hqId: string; revision: number }> = [];
    state.onChange((notice) => seen.push(notice));
    const store = await state.store();
    await store.createProfile({ id: 'a', type: 'openai', apiKey: 'sk-a-0123456789' }, 'admin');
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toEqual({ hqId: store.identity()!.hqId, revision: 1 });
    expect(await state.notice()).toEqual(seen[0]);
  });

  it('sends the notice to every connected client, whatever its project', () => {
    const sent: string[] = [];
    const ws = { readyState: 1, send: (m: string) => sent.push(m), bufferedAmount: 0 };
    const clients = new Map([
      [{}, { ws }],
      [{}, { ws }],
    ]) as never;
    expect(broadcastHqVaultChanged(clients, { hqId: 'a'.repeat(32), revision: 7 })).toBe(2);
    expect(sent.map((m) => JSON.parse(m))).toEqual([
      { type: 'hq.vault_changed', payload: { hqId: 'a'.repeat(32), revision: 7 } },
      { type: 'hq.vault_changed', payload: { hqId: 'a'.repeat(32), revision: 7 } },
    ]);
  });
});

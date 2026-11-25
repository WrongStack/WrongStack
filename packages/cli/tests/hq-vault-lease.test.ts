/**
 * HQ key vault, memory-only (lease) grants, against a real HQ server: the
 * device mirrors the profile but stores a marker as the key, the value lives
 * only in the process's lease store, and nothing that writes the config —
 * sync, import, a lease renewal, a model-list write — ever puts it on disk.
 * An older device that does not say it keeps leases off disk gets no value.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderConfig } from '@wrongstack/contracts/types';
import { DefaultSecretVault } from '@wrongstack/core/security';
import {
  HQ_AUTH_FILE_VERSION,
  HQ_LEASED_KEY_MARKER,
  HQ_VAULT_FETCH_PURPOSE,
  hashHqPassword,
  hqVaultSign,
  mintHqCookieSecret,
  readHqDevice,
  writeHqAuthFile,
} from '@wrongstack/hq';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { HqCredentialService } from '../src/hq-vault/service.js';
import { loadConfigProviders, mutateConfigProviders } from '../src/provider-config-utils.js';

const ADMIN = 'e'.repeat(64);
const PASSWORD = 'operator-password-3';
const VALUE = 'sk-leased-team-value-0123456789';

let handle: HqServerHandle | null = null;
let root: string;
let hqDir: string;
let configPath: string;
let vault: DefaultSecretVault;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-vault-lease-'));
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
  // The lease store is per process: leave none behind for the next test.
  await service()
    .unenroll({ removeKeys: false })
    .catch(() => undefined);
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

function service(): HqCredentialService {
  return new HqCredentialService({ globalRoot: root, vault, profileConfigPath: configPath });
}

async function enrollWithLease(lease = true): Promise<string> {
  await admin('/api/vault/profiles', {
    id: 'team',
    type: 'openai',
    family: 'openai-compatible',
    baseUrl: 'https://llm.internal.example/v1',
    apiKey: VALUE,
    keyLabel: 'team',
  });
  const minted = await admin('/api/vault/enrollment-codes', { autoApprove: true });
  const { device } = await service().enroll(origin(), minted.enrollmentToken);
  await admin(
    `/api/vault/profiles/team/devices/${device.deviceId}`,
    { granted: true, lease },
    'PUT',
  );
  return device.deviceId;
}

/**
 * Whether this process holds the lease: a provider built from the stored
 * entry is the real one, not the stand-in that waits for HQ.
 */
function holdsLease(cfg: ProviderConfig): boolean {
  return Object.getPrototypeOf(makeProviderFromConfig('team', cfg)) !== Object.prototype;
}

/** The decrypted config on disk, and its raw text. */
async function onDisk() {
  return {
    providers: await loadConfigProviders(configPath, vault),
    raw: await fs.readFile(configPath, 'utf8'),
  };
}

describe('HQ lease grants', () => {
  it('stores a marker on disk and holds the value in memory only', async () => {
    const deviceId = await enrollWithLease();
    const profile = (await admin('/api/vault/profiles/team')).profile;
    expect(profile.leaseDeviceIds).toEqual([deviceId]);

    await service().sync();
    const { providers, raw } = await onDisk();
    const key = providers['team']!.apiKeys![0]!;
    expect(key.apiKey).toBe(HQ_LEASED_KEY_MARKER);
    expect(key.source?.lease).toBe(true);
    expect(providers['team']!.baseUrl).toBe('https://llm.internal.example/v1');
    expect(raw).not.toContain(VALUE);
    // The process resolves the live value.
    expect(holdsLease(providers['team']!)).toBe(true);
    expect((await readHqDevice(root, vault))?.leaseProfileIds).toEqual(['team']);
  });

  it('no config writer puts the value on disk: import, lease renewal, a model-list write', async () => {
    await enrollWithLease();
    await service().sync();
    await service().importKeys();
    expect(await service().refreshLeases()).toBeGreaterThan(Date.now());
    // What the model persister and every other writer do: re-read, change, write.
    await mutateConfigProviders(configPath, vault, (all) => {
      all['team']!.models = ['gpt-team'];
    });
    const { providers, raw } = await onDisk();
    expect(raw).not.toContain(VALUE);
    expect(JSON.stringify(providers)).not.toContain(VALUE);
    expect(providers['team']!.models).toEqual(['gpt-team']);
    expect(holdsLease(providers['team']!)).toBe(true);
  });

  it('an older device that does not name the lease feature gets no value', async () => {
    await enrollWithLease();
    const device = (await readHqDevice(root, vault))!;
    const body = {
      v: 2 as const,
      deviceId: device.deviceId,
      ts: new Date().toISOString(),
      nonce: 'old-client-nonce-0123456789',
      mode: 'fetch' as const,
    };
    const sig = hqVaultSign({ ...body, purpose: HQ_VAULT_FETCH_PURPOSE }, device.keys);
    const res = await fetch(`${origin()}/api/vault/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, sig }),
    });
    const bundle = (await res.json()) as { profiles: Array<Record<string, any>> };
    expect(bundle.profiles[0]!.lease).toEqual({ ttlSeconds: 3600, withheld: true });
    expect(bundle.profiles[0]!.keys.every((k: Record<string, unknown>) => !k.sealed)).toBe(true);
  });

  it('turning the lease off on HQ is a change; the next sync stores the key normally', async () => {
    const deviceId = await enrollWithLease();
    await service().sync();
    const before = (await service().revision()).revision;
    await admin(
      `/api/vault/profiles/team/devices/${deviceId}`,
      { granted: true, lease: false },
      'PUT',
    );
    expect((await service().revision()).revision).toBe(before + 1);
    await service().sync();
    const key = (await onDisk()).providers['team']!.apiKeys![0]!;
    expect(key.apiKey).toBe(VALUE);
    expect(key.source?.lease).toBeUndefined();
    expect((await readHqDevice(root, vault))?.leaseProfileIds).toBeUndefined();
  });

  it('unenrolling forgets the leases this process held', async () => {
    await enrollWithLease();
    await service().sync();
    const cfg = (await onDisk()).providers['team']!;
    expect(holdsLease(cfg)).toBe(true);
    await service().unenroll({ removeKeys: false });
    expect(holdsLease(cfg)).toBe(false);
  });
});

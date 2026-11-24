/**
 * The client half of the HQ key vault against a real HQ server: enroll with
 * the dashboard's token, import granted keys into the profile config through
 * the one config writer, follow rotations and revocations on sync — and never
 * touch an endpoint, a pasted key, or a key HQ did not deliver.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault } from '@wrongstack/core/security';
import {
  HQ_AUTH_FILE_VERSION,
  hashHqPassword,
  mintHqCookieSecret,
  writeHqAuthFile,
} from '@wrongstack/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { runHqImportFlow } from '../src/hq-vault/flow.js';
import { HqCredentialService } from '../src/hq-vault/service.js';
import { loadConfigProviders, mutateConfigProviders } from '../src/provider-config-utils.js';

const ADMIN = 'c'.repeat(64);
const PASSWORD = 'operator-password-1';
const OPENAI_KEY = 'sk-hq-openai-value-0123456789';

let handle: HqServerHandle | null = null;
let root: string;
let hqDir: string;
let configPath: string;
let vault: DefaultSecretVault;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-vault-client-'));
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

async function admin(
  pathname: string,
  body?: unknown,
  method?: string,
): Promise<Record<string, any>> {
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
  return new HqCredentialService({
    globalRoot: root,
    vault,
    profileConfigPath: configPath,
    hostname: 'LAB-02',
    modelsRegistry: {
      async getProvider(id: string) {
        return id === 'openai'
          ? ({
              id,
              family: 'openai',
              apiBase: 'https://api.openai.com/v1',
              envVars: ['OPENAI_API_KEY'],
            } as never)
          : undefined;
      },
    },
  });
}

async function enroll(autoApprove = true): Promise<string> {
  const minted = await admin('/api/vault/enrollment-codes', { autoApprove });
  const { device } = await service().enroll(origin(), minted.enrollmentToken);
  return device.deviceId;
}

describe('HqCredentialService', () => {
  it('enrolls, imports a granted key encrypted at rest, and records where it came from', async () => {
    const secret = (
      await admin('/api/vault/secrets', {
        providerId: 'openai',
        label: 'team',
        apiKey: OPENAI_KEY,
      })
    ).secret;
    const deviceId = await enroll();
    await admin('/api/vault/grants', { secretId: secret.id, deviceId, setActive: true });

    // The device file holds no private key in the clear.
    const deviceFile = await fs.readFile(path.join(root, 'hq-device.json'), 'utf8');
    expect(deviceFile).toMatch(/enc:v\d+:/);
    expect(deviceFile).not.toMatch(/"(?:encPrivate|signPrivate)"/);

    const report = await service().importKeys();
    expect(report.added).toEqual([{ providerId: 'openai', label: 'team' }]);

    const raw = await fs.readFile(configPath, 'utf8');
    expect(raw).not.toContain(OPENAI_KEY);
    const providers = await loadConfigProviders(configPath, vault);
    expect(providers.openai).toMatchObject({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      activeKey: 'team',
    });
    expect(providers.openai!.apiKeys![0]).toMatchObject({
      label: 'team',
      apiKey: OPENAI_KEY,
      source: { kind: 'hq', keyId: secret.id, version: 1 },
    });
  });

  it('never changes an existing provider endpoint and keeps pasted keys apart', async () => {
    await mutateConfigProviders(configPath, vault, (all) => {
      all.openai = {
        type: 'openai',
        baseUrl: 'https://proxy.internal/v1',
        apiKeys: [{ label: 'team', apiKey: 'sk-pasted-here', createdAt: 'x' }],
        activeKey: 'team',
      };
    });
    const secret = (
      await admin('/api/vault/secrets', {
        providerId: 'openai',
        label: 'team',
        apiKey: OPENAI_KEY,
      })
    ).secret;
    const deviceId = await enroll();
    await admin('/api/vault/grants', { secretId: secret.id, deviceId });

    const report = await service().importKeys();
    expect(report.added).toEqual([{ providerId: 'openai', label: 'team-hq' }]);
    const providers = await loadConfigProviders(configPath, vault);
    expect(providers.openai!.baseUrl).toBe('https://proxy.internal/v1');
    expect(providers.openai!.activeKey).toBe('team');
    expect(providers.openai!.apiKeys!.map((k) => [k.label, k.apiKey])).toEqual([
      ['team', 'sk-pasted-here'],
      ['team-hq', OPENAI_KEY],
    ]);
  });

  it('sync follows rotation and revocation and leaves other keys alone', async () => {
    await mutateConfigProviders(configPath, vault, (all) => {
      all.openai = {
        type: 'openai',
        apiKeys: [{ label: 'mine', apiKey: 'sk-mine', createdAt: 'x' }],
      };
    });
    const secret = (
      await admin('/api/vault/secrets', {
        providerId: 'openai',
        label: 'team',
        apiKey: OPENAI_KEY,
      })
    ).secret;
    const deviceId = await enroll();
    const grant = (await admin('/api/vault/grants', { secretId: secret.id, deviceId })).grant;
    await service().importKeys();

    await admin(`/api/vault/secrets/${secret.id}/rotate`, { apiKey: 'sk-rotated' });
    const rotated = await service().sync();
    expect(rotated.updated).toEqual([{ providerId: 'openai', label: 'team' }]);
    let keys = (await loadConfigProviders(configPath, vault)).openai!.apiKeys!;
    expect(keys.find((k) => k.label === 'team')).toMatchObject({
      apiKey: 'sk-rotated',
      source: { version: 2 },
    });

    expect((await service().sync()).unchanged).toHaveLength(1);

    await admin(`/api/vault/grants/${grant.id}`, undefined, 'DELETE');
    const revoked = await service().sync();
    expect(revoked.removed).toEqual([{ providerId: 'openai', label: 'team' }]);
    keys = (await loadConfigProviders(configPath, vault)).openai!.apiKeys!;
    expect(keys.map((k) => k.label)).toEqual(['mine']);
  });

  it('skips a provider it cannot place, and lease grants', async () => {
    const odd = (
      await admin('/api/vault/secrets', {
        providerId: 'mystery-gateway',
        label: 'x',
        apiKey: 'sk-x',
      })
    ).secret;
    const leased = (
      await admin('/api/vault/secrets', {
        providerId: 'openai',
        label: 'lease',
        apiKey: 'sk-lease',
      })
    ).secret;
    const deviceId = await enroll();
    await admin('/api/vault/grants', { secretId: odd.id, deviceId });
    await admin('/api/vault/grants', { secretId: leased.id, deviceId, policy: 'lease' });
    const report = await service().importKeys();
    expect(report.added).toEqual([]);
    expect(report.skipped.map((s) => s.providerId).sort()).toEqual(['mystery-gateway', 'openai']);
    expect(await loadConfigProviders(configPath, vault)).toEqual({});
  });

  it('a pending device is told to wait; unenroll can remove what HQ delivered', async () => {
    const secret = (
      await admin('/api/vault/secrets', {
        providerId: 'openai',
        label: 'team',
        apiKey: OPENAI_KEY,
      })
    ).secret;
    const deviceId = await enroll(false);
    await expect(service().importKeys()).rejects.toThrow(/waiting for approval/);
    await admin(`/api/vault/devices/${deviceId}/approve`, {});
    await admin('/api/vault/grants', { secretId: secret.id, deviceId });
    await service().importKeys();
    expect((await service().device())?.status).toBe('approved');

    const { removed } = await service().unenroll({ removeKeys: true });
    expect(removed).toEqual([{ providerId: 'openai', label: 'team' }]);
    expect(await service().device()).toBeUndefined();
    expect((await loadConfigProviders(configPath, vault)).openai!.apiKeys).toBeUndefined();
  });

  it("applies a grant's 'make it active' once, not on every sync", async () => {
    await mutateConfigProviders(configPath, vault, (all) => {
      all.openai = {
        type: 'openai',
        apiKeys: [{ label: 'mine', apiKey: 'sk-mine', createdAt: 'x' }],
      };
    });
    const secret = (
      await admin('/api/vault/secrets', { providerId: 'openai', label: 'team', apiKey: OPENAI_KEY })
    ).secret;
    const deviceId = await enroll();
    await admin('/api/vault/grants', { secretId: secret.id, deviceId, setActive: true });
    await service().importKeys();
    expect((await loadConfigProviders(configPath, vault)).openai!.activeKey).toBe('team');

    // The user switches back to their own key; syncing must not undo that.
    await mutateConfigProviders(configPath, vault, (all) => {
      all.openai!.activeKey = 'mine';
    });
    await service().sync();
    await admin(`/api/vault/secrets/${secret.id}/rotate`, { apiKey: 'sk-rotated' });
    await service().sync();
    expect((await loadConfigProviders(configPath, vault)).openai!.activeKey).toBe('mine');
  });

  it('refuses a second enrollment without --replace', async () => {
    await enroll();
    const minted = await admin('/api/vault/enrollment-codes', {});
    await expect(service().enroll(origin(), minted.enrollmentToken)).rejects.toThrow(
      /already enrolled/,
    );
  });
});

describe('runHqImportFlow (the /auth menu and TUI flow)', () => {
  it('enrolls on first use, lists the grants and imports on Enter', async () => {
    const secret = (
      await admin('/api/vault/secrets', { providerId: 'openai', label: 'team', apiKey: OPENAI_KEY })
    ).secret;
    const minted = await admin('/api/vault/enrollment-codes', { autoApprove: true });
    const out: string[] = [];
    const answers = [origin(), '', ''];
    const secrets = [minted.enrollmentToken as string];
    const deps = {
      renderer: {
        write: (s: string) => out.push(s),
        writeInfo: (s: string) => out.push(s),
        writeWarning: (s: string) => out.push(s),
        writeError: (s: string) => out.push(`ERR ${s}`),
      },
      reader: {
        readLine: async () => answers.shift() ?? '',
        readSecret: async () => secrets.shift() ?? '',
      },
      modelsRegistry: {
        getProvider: async (id: string) =>
          id === 'openai'
            ? ({ id, family: 'openai', apiBase: 'https://api.openai.com/v1' } as never)
            : undefined,
      } as never,
      vault,
      profileConfigPath: configPath,
    };
    // First run enrolls; nothing is granted yet.
    expect(await runHqImportFlow(deps)).toBe(0);
    expect(out.join('')).toContain('Enrolled with');
    expect(out.join('')).toContain('grants this device no keys yet');

    const deviceId = (await service().device())!.deviceId;
    await admin('/api/vault/grants', { secretId: secret.id, deviceId });
    out.length = 0;
    expect(await runHqImportFlow(deps)).toBe(0);
    expect(out.join('')).toContain('openai/team');
    expect(out.join('')).toContain('+ added    openai/team');
    const providers = await loadConfigProviders(configPath, vault);
    expect(providers.openai!.apiKeys![0]!.apiKey).toBe(OPENAI_KEY);
  });
});

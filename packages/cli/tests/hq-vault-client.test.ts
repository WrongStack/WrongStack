/**
 * The client half of the HQ key vault against a real HQ server: enroll with
 * the dashboard's token, mirror granted provider profiles into the profile
 * config through the one config writer, follow HQ's changes on sync — and
 * never overwrite a provider, key or active-key choice made on this machine.
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
  });
}

async function enroll(autoApprove = true): Promise<string> {
  const minted = await admin('/api/vault/enrollment-codes', { autoApprove });
  const { device } = await service().enroll(origin(), minted.enrollmentToken);
  return device.deviceId;
}

async function grant(profileId: string, deviceId: string, granted = true): Promise<void> {
  await admin(`/api/vault/profiles/${profileId}/devices/${deviceId}`, { granted }, 'PUT');
}

const PROXY = {
  id: 'team-proxy',
  type: 'openai',
  family: 'openai-compatible',
  baseUrl: 'https://llm.internal.example/v1',
  models: ['gpt-team'],
  apiKey: OPENAI_KEY,
  keyLabel: 'team',
};

describe('HqCredentialService', () => {
  it('enrolls and mirrors a granted profile — endpoint, models and key — encrypted at rest', async () => {
    await admin('/api/vault/profiles', PROXY);
    const deviceId = await enroll();
    await grant('team-proxy', deviceId);

    // The device file holds no private key in the clear.
    const deviceFile = await fs.readFile(path.join(root, 'hq-device.json'), 'utf8');
    expect(deviceFile).toMatch(/enc:v\d+:/);
    expect(deviceFile).not.toMatch(/"(?:encPrivate|signPrivate)"/);

    const report = await service().importKeys();
    expect(report.added).toEqual([{ providerId: 'team-proxy', profileId: 'team-proxy' }]);

    const raw = await fs.readFile(configPath, 'utf8');
    expect(raw).not.toContain(OPENAI_KEY);
    const providers = await loadConfigProviders(configPath, vault);
    expect(providers['team-proxy']).toMatchObject({
      type: 'openai',
      family: 'openai-compatible',
      baseUrl: 'https://llm.internal.example/v1',
      models: ['gpt-team'],
      activeKey: 'team',
      source: { kind: 'hq', profileId: 'team-proxy', version: expect.any(Number) },
    });
    expect(providers['team-proxy']!.apiKeys![0]).toMatchObject({
      label: 'team',
      apiKey: OPENAI_KEY,
      authMethod: 'api_key',
      source: { kind: 'hq', version: 1 },
    });
  });

  it('never overwrites a provider entered here: the HQ profile lands beside it as <id>-hq', async () => {
    await mutateConfigProviders(configPath, vault, (all) => {
      all.openai = {
        type: 'openai',
        baseUrl: 'https://proxy.internal/v1',
        apiKeys: [{ label: 'team', apiKey: 'sk-pasted-here', createdAt: 'x' }],
        activeKey: 'team',
      };
    });
    await admin('/api/vault/profiles', {
      id: 'openai',
      baseUrl: 'https://hq.example/v1',
      apiKey: OPENAI_KEY,
      keyLabel: 'team',
    });
    const deviceId = await enroll();
    await grant('openai', deviceId);

    const report = await service().importKeys();
    expect(report.added).toEqual([{ providerId: 'openai-hq', profileId: 'openai' }]);
    const providers = await loadConfigProviders(configPath, vault);
    expect(providers.openai).toMatchObject({ baseUrl: 'https://proxy.internal/v1' });
    expect(providers.openai!.apiKeys!.map((k) => [k.label, k.apiKey])).toEqual([
      ['team', 'sk-pasted-here'],
    ]);
    expect(providers['openai-hq']).toMatchObject({ baseUrl: 'https://hq.example/v1' });
    // A second sync finds the same entry again instead of making openai-hq-2.
    expect((await service().sync()).unchanged).toEqual([
      { providerId: 'openai-hq', profileId: 'openai' },
    ]);
  });

  it('sync mirrors HQ edits and key replacements, keeps keys added here, removes what HQ withdraws', async () => {
    await admin('/api/vault/profiles', PROXY);
    const deviceId = await enroll();
    await grant('team-proxy', deviceId);
    await service().importKeys();
    // A key added on this machine to the HQ profile.
    await mutateConfigProviders(configPath, vault, (all) => {
      all['team-proxy']!.apiKeys!.push({ label: 'mine', apiKey: 'sk-mine', createdAt: 'x' });
    });

    await admin('/api/vault/profiles/team-proxy/keys', { label: 'team', apiKey: 'sk-rotated' });
    await admin('/api/vault/profiles/team-proxy', { models: ['gpt-team', 'gpt-next'] }, 'PATCH');
    const changed = await service().sync();
    expect(changed.updated).toEqual([{ providerId: 'team-proxy', profileId: 'team-proxy' }]);
    let provider = (await loadConfigProviders(configPath, vault))['team-proxy']!;
    expect(provider.models).toEqual(['gpt-team', 'gpt-next']);
    expect(provider.apiKeys!.map((k) => [k.label, k.apiKey])).toEqual([
      ['team', 'sk-rotated'],
      ['mine', 'sk-mine'],
    ]);

    expect((await service().sync()).unchanged).toHaveLength(1);

    await grant('team-proxy', deviceId, false);
    const withdrawn = await service().sync();
    expect(withdrawn.removed).toEqual([{ providerId: 'team-proxy', profileId: 'team-proxy' }]);
    provider = (await loadConfigProviders(configPath, vault))['team-proxy']!;
    expect(provider).toBeUndefined();
  });

  it('keeps a local key switch through HQ key replacements, and follows a new HQ choice', async () => {
    await admin('/api/vault/profiles', PROXY);
    await admin('/api/vault/profiles/team-proxy/keys', { label: 'backup', apiKey: 'sk-backup-1' });
    const deviceId = await enroll();
    await grant('team-proxy', deviceId);
    await service().importKeys();
    const active = async () =>
      (await loadConfigProviders(configPath, vault))['team-proxy']!.activeKey;
    expect(await active()).toBe('team');

    await mutateConfigProviders(configPath, vault, (all) => {
      all['team-proxy']!.activeKey = 'backup';
    });
    await service().sync();
    expect(await active()).toBe('backup');

    // HQ replaces the value of its active key (what an OAuth refresh does):
    // the profile changes, but HQ's choice did not — the local switch stays.
    await admin('/api/vault/profiles/team-proxy/keys', { label: 'team', apiKey: 'sk-team-2' });
    await service().sync();
    expect(await active()).toBe('backup');

    // HQ picks another key: that is a new choice, and it wins.
    await mutateConfigProviders(configPath, vault, (all) => {
      all['team-proxy']!.activeKey = 'team';
    });
    await admin('/api/vault/profiles/team-proxy', { activeKey: 'backup' }, 'PATCH');
    await service().sync();
    expect(await active()).toBe('backup');
  });

  it('moves a key entered here aside when HQ starts using its name', async () => {
    await admin('/api/vault/profiles', PROXY);
    const deviceId = await enroll();
    await grant('team-proxy', deviceId);
    await service().importKeys();
    await mutateConfigProviders(configPath, vault, (all) => {
      all['team-proxy']!.apiKeys!.push({ label: 'backup', apiKey: 'sk-mine', createdAt: 'x' });
    });
    await admin('/api/vault/profiles/team-proxy/keys', { label: 'backup', apiKey: 'sk-hq-backup' });
    const report = await service().sync();
    expect(report.renamed).toEqual([
      { providerId: 'team-proxy', profileId: 'team-proxy', key: 'backup', to: 'backup-local' },
    ]);
    const keys = (await loadConfigProviders(configPath, vault))['team-proxy']!.apiKeys!;
    expect(keys.map((k) => [k.label, k.apiKey])).toEqual([
      ['team', OPENAI_KEY],
      ['backup', 'sk-hq-backup'],
      ['backup-local', 'sk-mine'],
    ]);
  });

  it('removes keys a version-1 import put into a local provider', async () => {
    const device = { hqId: '' };
    await admin('/api/vault/profiles', PROXY);
    const deviceId = await enroll();
    device.hqId = (await service().device())!.hq.hqId;
    await mutateConfigProviders(configPath, vault, (all) => {
      all.openai = {
        type: 'openai',
        apiKeys: [
          { label: 'mine', apiKey: 'sk-mine', createdAt: 'x' },
          {
            label: 'team',
            apiKey: 'sk-old-import',
            createdAt: 'x',
            source: { kind: 'hq', hqId: device.hqId, keyId: 'k', version: 1 },
          },
        ],
      };
    });
    await grant('team-proxy', deviceId);
    const report = await service().sync();
    expect(report.removed).toEqual([{ providerId: 'openai', profileId: 'openai', key: 'team' }]);
    const providers = await loadConfigProviders(configPath, vault);
    expect(providers.openai!.apiKeys!.map((k) => k.label)).toEqual(['mine']);
  });

  it('a pending device is told to wait; unenroll can remove what HQ delivered', async () => {
    await admin('/api/vault/profiles', PROXY);
    const deviceId = await enroll(false);
    await expect(service().importKeys()).rejects.toThrow(/waiting for approval/);
    await admin(`/api/vault/devices/${deviceId}/approve`, {});
    await grant('team-proxy', deviceId);
    await service().importKeys();
    expect((await service().device())?.status).toBe('approved');

    const { removed } = await service().unenroll({ removeKeys: true });
    expect(removed).toEqual([{ providerId: 'team-proxy', profileId: 'team-proxy' }]);
    expect(await service().device()).toBeUndefined();
    expect(await loadConfigProviders(configPath, vault)).toEqual({});
  });

  it('renews one HQ key on request without writing config, and refuses one HQ took back', async () => {
    await admin('/api/vault/profiles', PROXY);
    const deviceId = await enroll();
    await grant('team-proxy', deviceId);
    await service().importKeys();
    const stored = (await loadConfigProviders(configPath, vault))['team-proxy']!.apiKeys![0]!;
    expect(stored.source).toMatchObject({ kind: 'hq', profileId: 'team-proxy' });

    await admin('/api/vault/profiles/team-proxy/keys', { label: 'team', apiKey: 'sk-renewed' });
    const renewed = await service().renewKey(stored);
    expect(renewed).toMatchObject({ label: 'team', apiKey: 'sk-renewed', source: { version: 2 } });
    expect(renewed.refreshToken).toBeUndefined();
    // The caller (refresh transaction / persister) stores it; renewKey does not.
    expect((await loadConfigProviders(configPath, vault))['team-proxy']!.apiKeys![0]!.apiKey).toBe(
      OPENAI_KEY,
    );

    await grant('team-proxy', deviceId, false);
    await expect(service().renewKey(stored)).rejects.toThrow(/no longer grants/);
    await expect(
      service().renewKey({ ...stored, source: { ...stored.source!, hqId: 'other' } }),
    ).rejects.toThrow(/did not come from/);
  });

  it('gives up on an HQ that accepts the request and never answers', async () => {
    await admin('/api/vault/profiles', PROXY);
    const deviceId = await enroll();
    await grant('team-proxy', deviceId);
    await service().importKeys();
    const stored = (await loadConfigProviders(configPath, vault))['team-proxy']!.apiKeys![0]!;
    // Like a real fetch, the stalled one only ends when its signal aborts.
    const stalled = new HqCredentialService({
      globalRoot: root,
      vault,
      profileConfigPath: configPath,
      requestTimeoutMs: 200,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) reject(init.signal.reason);
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        })) as typeof fetch,
    });
    const started = Date.now();
    await expect(stalled.renewKey(stored)).rejects.toThrow(/no answer within/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // A caller's own signal ends it too.
    const caller = new AbortController();
    const pending = stalled.renewKey(stored, caller.signal);
    caller.abort();
    await expect(pending).rejects.toThrow(/Cannot reach HQ/);
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
  it('enrolls on first use, lists the granted providers and imports on Enter', async () => {
    await admin('/api/vault/profiles', PROXY);
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
      vault,
      profileConfigPath: configPath,
    } as never;
    // First run enrolls; nothing is granted yet.
    expect(await runHqImportFlow(deps)).toBe(0);
    expect(out.join('')).toContain('Enrolled with');
    expect(out.join('')).toContain('grants this device no providers yet');

    const deviceId = (await service().device())!.deviceId;
    await grant('team-proxy', deviceId);
    out.length = 0;
    expect(await runHqImportFlow(deps)).toBe(0);
    expect(out.join('')).toContain(
      'team-proxy [openai-compatible] https://llm.internal.example/v1',
    );
    expect(out.join('')).toContain('+ added    team-proxy');
    const providers = await loadConfigProviders(configPath, vault);
    expect(providers['team-proxy']!.apiKeys![0]!.apiKey).toBe(OPENAI_KEY);
  });
});

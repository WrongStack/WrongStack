/**
 * HQ key vault uploads (`wstack hq keys push`) against a real HQ server: a
 * provider of this machine is sealed to HQ and waits for an operator; once
 * approved, the next sync makes the original provider HQ's — same id, HQ's
 * keys, no `-hq` copy and no `-local` leftovers. Uploads are signed for their
 * own purpose, bound to their nonce, and only an approved device may send one.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderConfig } from '@wrongstack/contracts/types';
import { DefaultSecretVault } from '@wrongstack/core/security';
import {
  buildHqVaultUploadRequest,
  HQ_AUTH_FILE_VERSION,
  HQ_LEASED_KEY_MARKER,
  HQ_VAULT_FETCH_PURPOSE,
  hashHqPassword,
  hqVaultSign,
  mintHqCookieSecret,
  readHqDevice,
  writeHqAuthFile,
} from '@wrongstack/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { HqCredentialService } from '../src/hq-vault/service.js';
import { loadConfigProviders, mutateConfigProviders } from '../src/provider-config-utils.js';

const ADMIN = 'f'.repeat(64);
const PASSWORD = 'operator-password-5';
const VALUE = 'sk-uploaded-value-0123456789abcd';
const SECOND = 'sk-second-value-9876543210zyxw';

let handle: HqServerHandle | null = null;
let root: string;
let hqDir: string;
let configPath: string;
let vault: DefaultSecretVault;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-vault-upload-'));
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

async function call(pathname: string, body?: unknown, method?: string) {
  const res = await fetch(`${origin()}${pathname}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function admin(pathname: string, body?: unknown, method?: string) {
  const { status, json } = await call(pathname, body, method);
  if (status >= 400) throw new Error(`${pathname}: ${status} ${JSON.stringify(json)}`);
  return json;
}

/** A device route, as a device sends it: no browser credential. */
async function asDevice(pathname: string, body: unknown) {
  const res = await fetch(`${origin()}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

function service(): HqCredentialService {
  return new HqCredentialService({ globalRoot: root, vault, profileConfigPath: configPath });
}

async function enroll(autoApprove = true): Promise<string> {
  const minted = await admin('/api/vault/enrollment-codes', { autoApprove });
  const { device } = await service().enroll(origin(), minted.enrollmentToken);
  return device.deviceId;
}

async function addLocal(id: string, provider: Partial<ProviderConfig> = {}): Promise<void> {
  await mutateConfigProviders(configPath, vault, (all) => {
    all[id] = {
      type: 'openai',
      family: 'openai-compatible',
      baseUrl: 'https://llm.local.example/v1',
      models: ['model-a', 'model-b'],
      apiKeys: [
        { label: 'main', apiKey: VALUE, createdAt: '2026-01-01T00:00:00.000Z' },
        { label: 'spare', apiKey: SECOND, createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      activeKey: 'spare',
      ...provider,
    } as ProviderConfig;
  });
}

const providers = () => loadConfigProviders(configPath, vault);

async function onlyUpload(): Promise<Record<string, any>> {
  const { uploads } = await admin('/api/vault/uploads');
  expect(uploads).toHaveLength(1);
  return uploads[0];
}

describe('HQ uploads', () => {
  it('push → approve → sync: the original provider becomes HQ’s, nothing duplicated', async () => {
    const deviceId = await enroll();
    await addLocal('myco');
    const before = await providers();

    const report = await service().push(['myco']);
    expect(report.sent.map((s) => s.providerId)).toEqual(['myco']);
    expect(report.skipped).toEqual([]);
    // Nothing local changes until HQ approves.
    expect(await providers()).toEqual(before);

    const upload = await onlyUpload();
    expect(upload).toMatchObject({
      deviceId,
      localId: 'myco',
      conflict: false,
      profile: { id: 'myco', type: 'openai', baseUrl: 'https://llm.local.example/v1' },
    });
    expect(upload.keys.map((k: { label: string }) => k.label)).toEqual(['main', 'spare']);
    // The operator sees hints, never a value.
    expect(JSON.stringify(upload)).not.toContain(VALUE);
    expect(JSON.stringify(upload)).not.toContain(SECOND);

    const { profile } = await admin(`/api/vault/uploads/${upload.id}/approve`, {});
    expect(profile).toMatchObject({ id: 'myco', activeKey: 'spare', deviceIds: [deviceId] });
    expect((await admin('/api/vault/uploads')).uploads).toEqual([]);

    await service().sync();
    const after = await providers();
    expect(Object.keys(after)).toEqual(['myco']);
    const adopted = after['myco']!;
    expect(adopted.source).toMatchObject({ kind: 'hq', profileId: 'myco' });
    expect(adopted.baseUrl).toBe('https://llm.local.example/v1');
    expect(adopted.models).toEqual(['model-a', 'model-b']);
    expect(adopted.activeKey).toBe('spare');
    const keys = adopted.apiKeys!;
    expect(keys.map((k) => k.label).sort()).toEqual(['main', 'spare']);
    expect(keys.every((k) => k.source?.kind === 'hq')).toBe(true);
    expect(keys.find((k) => k.label === 'main')!.apiKey).toBe(VALUE);
    expect(keys.every((k) => k.refreshToken === undefined)).toBe(true);
    expect((await readHqDevice(root, vault))?.pendingUploads).toBeUndefined();

    // A later sync leaves it as it is.
    const again = await service().sync();
    expect(again.added).toEqual([]);
    expect(Object.keys(await providers())).toEqual(['myco']);
  });

  it('approved memory-only: the machine keeps only the marker on disk', async () => {
    await enroll();
    await addLocal('myco');
    await service().push(['myco']);
    const upload = await onlyUpload();
    await admin(`/api/vault/uploads/${upload.id}/approve`, { lease: true });
    await service().sync();
    const adopted = (await providers())['myco']!;
    expect(adopted.apiKeys!.every((k) => k.apiKey === HQ_LEASED_KEY_MARKER)).toBe(true);
    expect(JSON.stringify(await providers())).not.toContain(VALUE);
  });

  it('an id taken on HQ is approved under another; the machine still adopts its own provider', async () => {
    await admin('/api/vault/profiles', { id: 'myco', type: 'openai' });
    await enroll();
    await addLocal('myco');
    await service().push(['myco']);
    const upload = await onlyUpload();
    expect(upload.conflict).toBe(true);
    const clash = await call(`/api/vault/uploads/${upload.id}/approve`, {});
    expect(clash.status).toBe(409);
    await admin(`/api/vault/uploads/${upload.id}/approve`, { profileId: 'myco-team' });
    await service().sync();
    const after = await providers();
    expect(Object.keys(after)).toEqual(['myco']);
    expect(after['myco']!.source).toMatchObject({ kind: 'hq', profileId: 'myco-team' });
  });

  it('refuses what cannot move: a sign-in, an HQ provider, an unknown id, a pending upload', async () => {
    await enroll();
    await addLocal('signed', {
      apiKeys: [
        {
          label: 'acct',
          apiKey: 'access-token',
          refreshToken: 'refresh-token',
          authMethod: 'oauth',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      activeKey: 'acct',
    });
    await addLocal('myco');
    const first = await service().push(['signed', 'nope', 'myco']);
    expect(first.sent.map((s) => s.providerId)).toEqual(['myco']);
    expect(first.skipped.map((s) => s.providerId)).toEqual(['signed', 'nope']);
    expect(first.skipped[0]!.reason).toContain('sign in on HQ');
    const second = await service().push(['myco']);
    expect(second.sent).toEqual([]);
    expect(second.skipped[0]!.reason).toContain('--again');
    expect((await service().push(['myco'], { again: true })).sent).toHaveLength(1);
    // Nothing from the sign-in ever reached HQ.
    const { uploads } = await admin('/api/vault/uploads');
    expect(uploads.map((u: { localId: string }) => u.localId)).toEqual(['myco', 'myco']);
  });

  it('a rejected upload is dropped and audited', async () => {
    await enroll();
    await addLocal('myco');
    await service().push(['myco']);
    const upload = await onlyUpload();
    await admin(`/api/vault/uploads/${upload.id}`, undefined, 'DELETE');
    expect((await admin('/api/vault/uploads')).uploads).toEqual([]);
    const { entries } = await admin('/api/vault/audit');
    expect(entries.map((e: { kind: string }) => e.kind)).toEqual(
      expect.arrayContaining(['upload.receive', 'upload.reject']),
    );
  });
});

describe('HQ upload requests', () => {
  async function device() {
    await enroll();
    return (await readHqDevice(root, vault))!;
  }
  const payload = (id = 'raw') => ({
    localId: id,
    profile: { id, type: 'openai' },
    keys: [{ label: 'main', apiKey: VALUE }],
  });

  it('a valid request is taken once; its replay is refused', async () => {
    const d = await device();
    const request = buildHqVaultUploadRequest(d.keys, d.hq, payload());
    expect((await asDevice('/api/vault/upload', request)).status).toBe(200);
    const replay = await asDevice('/api/vault/upload', request);
    expect(replay.status).toBe(403);
  });

  it('a fetch signature does not pass as an upload', async () => {
    const d = await device();
    const request = buildHqVaultUploadRequest(d.keys, d.hq, payload());
    const { sig: _sig, ...body } = request;
    const forged = {
      ...body,
      sig: hqVaultSign({ ...body, purpose: HQ_VAULT_FETCH_PURPOSE }, d.keys),
    };
    const answer = await asDevice('/api/vault/upload', forged);
    expect(answer.status).toBe(403);
    expect(answer.json.error.code).toBe('VAULT_DENIED');
  });

  it('the signature covers the seal, and the seal is bound to the request', async () => {
    const d = await device();
    const a = buildHqVaultUploadRequest(d.keys, d.hq, payload('a'));
    const b = buildHqVaultUploadRequest(d.keys, d.hq, payload('b'));
    // Swapped seal, signature left as it was: the signature no longer matches.
    expect((await asDevice('/api/vault/upload', { ...a, sealed: b.sealed })).status).toBe(403);
    // Swapped seal, signed again by the device: the seal does not open under a's nonce and id.
    const { sig: _sig, ...body } = { ...a, sealed: b.sealed };
    const resigned = {
      ...body,
      sig: hqVaultSign({ ...body, purpose: 'wstack-hq-vault/v2/upload' }, d.keys),
    };
    const answer = await asDevice('/api/vault/upload', resigned);
    expect(answer.status).toBe(400);
    expect(answer.json.error.code).toBe('VAULT_INVALID');
    expect((await admin('/api/vault/uploads')).uploads).toEqual([]);
  });

  it('a device waiting for approval cannot upload', async () => {
    await enroll(false);
    const d = (await readHqDevice(root, vault))!;
    const answer = await asDevice(
      '/api/vault/upload',
      buildHqVaultUploadRequest(d.keys, d.hq, payload()),
    );
    expect(answer.status).toBe(403);
  });

  it('caps the uploads one device may leave waiting', async () => {
    const d = await device();
    for (let i = 0; i < 8; i++) {
      const ok = await asDevice(
        '/api/vault/upload',
        buildHqVaultUploadRequest(d.keys, d.hq, payload(`p${i}`)),
      );
      expect(ok.status).toBe(200);
    }
    const over = await asDevice(
      '/api/vault/upload',
      buildHqVaultUploadRequest(d.keys, d.hq, payload('p9')),
    );
    expect(over.status).toBe(409);
  });
});

/**
 * HQ key vault: secrets encrypted at rest, devices enrolled with a one-time
 * code, values sealed to one device and signed by HQ.
 *
 * Every test drives the real store and the real device-side helpers end to
 * end; nothing in the crypto path is mocked.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactHqValue } from '../src/redaction.js';
import {
  buildHqVaultEnrollRequest,
  buildHqVaultFetchRequest,
  formatHqVaultEnrollmentToken,
  generateHqVaultKeyPair,
  HQ_VAULT_AUDIT_FILE,
  HQ_VAULT_FILE,
  HQ_VAULT_MASTER_KEY_FILE,
  type HqVaultKeyPair,
  HqVaultStore,
  hqVaultDecrypt,
  hqVaultEncrypt,
  hqVaultKeyId,
  hqVaultOpen,
  hqVaultSeal,
  hqVaultSign,
  hqVaultVerify,
  openHqVaultBundle,
  verifyHqVaultEnrollResponse,
} from '../src/vault/index.js';
import { decodeHqVaultMasterKey, encodeHqVaultMasterKey } from '../src/vault/master-key.js';

const API_KEY = 'sk-test-vault-0123456789abcdef';
const ADMIN = 'test-admin';

let dataDir: string;
let clock: number;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-vault-'));
  clock = Date.parse('2026-11-23T12:00:00.000Z');
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function openStore(passphrase?: string): Promise<HqVaultStore> {
  return HqVaultStore.open(dataDir, passphrase, { now: () => clock });
}

async function enroll(
  store: HqVaultStore,
  options: { autoApprove?: boolean } = {},
): Promise<{
  keys: HqVaultKeyPair;
  deviceId: string;
  pinned: ReturnType<typeof verifyHqVaultEnrollResponse>;
}> {
  const minted = await store.mintEnrollmentCode(
    { autoApprove: options.autoApprove ?? true },
    ADMIN,
  );
  const keys = generateHqVaultKeyPair();
  const { request, code } = buildHqVaultEnrollRequest(
    keys,
    formatHqVaultEnrollmentToken(minted.codeId, minted.code),
    { hostname: 'LAB-02' },
  );
  const response = await store.enroll(request);
  const pinned = verifyHqVaultEnrollResponse(response, request, code);
  return { keys, deviceId: response.deviceId, pinned };
}

describe('vault crypto primitives', () => {
  it('seals to one recipient and rejects a different aad or recipient', () => {
    const a = generateHqVaultKeyPair();
    const b = generateHqVaultKeyPair();
    const box = hqVaultSeal(API_KEY, a.encPublic, 'aad-1');
    expect(hqVaultOpen(box, a, 'aad-1')).toBe(API_KEY);
    expect(() => hqVaultOpen(box, a, 'aad-2')).toThrow(/authentication/);
    expect(() => hqVaultOpen(box, b, 'aad-1')).toThrow(/authentication/);
    expect(JSON.stringify(box)).not.toContain(API_KEY);
  });

  it('signs canonical JSON independent of key order', () => {
    const k = generateHqVaultKeyPair();
    const sig = hqVaultSign({ b: 1, a: { d: 2, c: 3 } }, k);
    expect(hqVaultVerify({ a: { c: 3, d: 2 }, b: 1 }, sig, k.signPublic)).toBe(true);
    expect(hqVaultVerify({ a: { c: 3, d: 2 }, b: 2 }, sig, k.signPublic)).toBe(false);
    expect(hqVaultVerify({ b: 1 }, 'not-a-signature', k.signPublic)).toBe(false);
  });

  it('envelope encryption binds the aad', () => {
    const key = Buffer.alloc(32, 7);
    const box = hqVaultEncrypt(key, Buffer.from(API_KEY), 'secret|x|1');
    expect(hqVaultDecrypt(key, box, 'secret|x|1').toString()).toBe(API_KEY);
    expect(() => hqVaultDecrypt(key, box, 'secret|x|2')).toThrow();
  });
});

describe('vault master key', () => {
  it('a passphrase-wrapped key is sealed without the passphrase and opens with it', () => {
    const key = Buffer.alloc(32, 9);
    const wrapped = encodeHqVaultMasterKey(key, 'correct horse', 14);
    expect(wrapped.includes(key)).toBe(false);
    expect(decodeHqVaultMasterKey(wrapped, undefined)).toEqual({ state: 'sealed' });
    const opened = decodeHqVaultMasterKey(wrapped, 'correct horse');
    expect(opened.state === 'unsealed' && opened.key.equals(key)).toBe(true);
    expect(() => decodeHqVaultMasterKey(wrapped, 'wrong')).toThrow(/wrong vault passphrase/);
  });

  it('refuses an out-of-range scrypt cost read from the file', () => {
    const wrapped = encodeHqVaultMasterKey(Buffer.alloc(32, 1), 'p', 14);
    wrapped[5] = 30; // 2^30 would be an allocation bomb on every unseal attempt
    expect(() => decodeHqVaultMasterKey(wrapped, 'p')).toThrow(/out-of-range/);
  });
});

describe('HqVaultStore', () => {
  it('stores no credential or private key in the clear', async () => {
    const store = await openStore();
    await store.createSecret({ providerId: 'openai', label: 'team', apiKey: API_KEY }, ADMIN);
    const raw = await fs.readFile(path.join(dataDir, HQ_VAULT_FILE), 'utf8');
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toMatch(/encPrivate|signPrivate/);
    const audit = await fs.readFile(path.join(dataDir, HQ_VAULT_AUDIT_FILE), 'utf8');
    expect(audit).toContain('secret.create');
    expect(audit).not.toContain(API_KEY);
    expect(store.listSecrets()[0]).not.toHaveProperty('payload');
  });

  it('delivers a granted key end to end, sealed to the device and signed by HQ', async () => {
    const store = await openStore();
    const secret = await store.createSecret(
      { providerId: 'openai', label: 'team', apiKey: API_KEY },
      ADMIN,
    );
    const { keys, deviceId, pinned } = await enroll(store);
    expect(deviceId).toBe(hqVaultKeyId(keys));
    expect(pinned).toEqual(store.identity());
    await store.createGrant({ secretId: secret.id, deviceId, setActive: true }, ADMIN);

    const listReq = buildHqVaultFetchRequest(keys, { mode: 'list', now: clock });
    const list = await store.fetch(listReq);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.sealed).toBeUndefined();

    const req = buildHqVaultFetchRequest(keys, { mode: 'fetch', now: clock });
    const bundle = await store.fetch(req);
    expect(JSON.stringify(bundle)).not.toContain(API_KEY);
    const opened = openHqVaultBundle(bundle, keys, pinned, req);
    expect(opened).toEqual([
      expect.objectContaining({
        secretId: secret.id,
        providerId: 'openai',
        apiKey: API_KEY,
        version: 1,
        policy: 'local',
        setActive: true,
      }),
    ]);
    expect(store.listDevices()[0]!.lastFetchAt).toBeDefined();
  });

  it('a bundle altered in transit is rejected by the device', async () => {
    const store = await openStore();
    const secret = await store.createSecret(
      { providerId: 'openai', label: 't', apiKey: API_KEY },
      ADMIN,
    );
    const { keys, deviceId, pinned } = await enroll(store);
    await store.createGrant({ secretId: secret.id, deviceId }, ADMIN);
    const req = buildHqVaultFetchRequest(keys, { mode: 'fetch', now: clock });
    const bundle = await store.fetch(req);
    const tampered = { ...bundle, items: [{ ...bundle.items[0]!, providerId: 'evil' }] };
    expect(() => openHqVaultBundle(tampered, keys, pinned, req)).toThrow(/signature/);
    const otherHq = { ...pinned, signPublic: generateHqVaultKeyPair().signPublic };
    expect(() => openHqVaultBundle(bundle, keys, otherHq, req)).toThrow(/signature/);
  });

  it('enrollment cannot be hijacked: a swapped device key fails the MAC and leaves the code usable', async () => {
    const store = await openStore();
    const minted = await store.mintEnrollmentCode({}, ADMIN);
    const token = formatHqVaultEnrollmentToken(minted.codeId, minted.code);
    const victim = generateHqVaultKeyPair();
    const { request } = buildHqVaultEnrollRequest(victim, token, { hostname: 'LAB-02' });
    const attacker = generateHqVaultKeyPair();
    const swapped = {
      ...request,
      device: { ...request.device, encPublic: attacker.encPublic, signPublic: attacker.signPublic },
    };
    await expect(store.enroll(swapped)).rejects.toMatchObject({ code: 'VAULT_DENIED' });
    // The failed attempt did not burn the code; the genuine request still works, once.
    await expect(store.enroll(request)).resolves.toMatchObject({ status: 'approved' });
    await expect(store.enroll(request)).rejects.toMatchObject({ code: 'VAULT_DENIED' });
    expect(store.listDevices().map((d) => d.id)).toEqual([hqVaultKeyId(victim)]);
  });

  it('an HQ answer forged without the code is rejected by the device', async () => {
    const store = await openStore();
    const minted = await store.mintEnrollmentCode({}, ADMIN);
    const keys = generateHqVaultKeyPair();
    const { request, code } = buildHqVaultEnrollRequest(
      keys,
      formatHqVaultEnrollmentToken(minted.codeId, minted.code),
      { hostname: 'h' },
    );
    const response = await store.enroll(request);
    const fake = generateHqVaultKeyPair();
    const forged = { ...response, hq: { ...response.hq, signPublic: fake.signPublic } };
    expect(() => verifyHqVaultEnrollResponse(forged, request, code)).toThrow(/verification/);
  });

  it('enrollment codes expire', async () => {
    const store = await openStore();
    const minted = await store.mintEnrollmentCode({}, ADMIN);
    clock += 11 * 60_000;
    const { request } = buildHqVaultEnrollRequest(
      generateHqVaultKeyPair(),
      formatHqVaultEnrollmentToken(minted.codeId, minted.code),
      { hostname: 'h' },
    );
    await expect(store.enroll(request)).rejects.toMatchObject({ code: 'VAULT_DENIED' });
  });

  it('a pending device gets nothing until approved; a revoked one loses its grants', async () => {
    const store = await openStore();
    const secret = await store.createSecret(
      { providerId: 'openai', label: 't', apiKey: API_KEY },
      ADMIN,
    );
    const { keys, deviceId } = await enroll(store, { autoApprove: false });
    expect(store.listDevices()[0]!.status).toBe('pending');
    await store.createGrant({ secretId: secret.id, deviceId }, ADMIN);
    await expect(
      store.fetch(buildHqVaultFetchRequest(keys, { mode: 'fetch', now: clock })),
    ).rejects.toThrow(/waiting for approval/);
    await store.setDeviceStatus(deviceId, 'approved', ADMIN);
    await expect(
      store.fetch(buildHqVaultFetchRequest(keys, { mode: 'fetch', now: clock })),
    ).resolves.toMatchObject({ items: [expect.objectContaining({ secretId: secret.id })] });
    await store.setDeviceStatus(deviceId, 'revoked', ADMIN);
    expect(store.listGrants()).toEqual([]);
    await expect(
      store.fetch(buildHqVaultFetchRequest(keys, { mode: 'fetch', now: clock })),
    ).rejects.toThrow(/revoked/);
  });

  it('rejects an unsigned, replayed or stale fetch', async () => {
    const store = await openStore();
    const { keys } = await enroll(store);
    const stranger = generateHqVaultKeyPair();
    const forged = {
      ...buildHqVaultFetchRequest(stranger, { mode: 'fetch', now: clock }),
      deviceId: hqVaultKeyId(keys),
    };
    await expect(store.fetch(forged)).rejects.toThrow(/authentication failed/);

    const req = buildHqVaultFetchRequest(keys, { mode: 'list', now: clock });
    await store.fetch(req);
    await expect(store.fetch(req)).rejects.toThrow(/replayed/);

    const stale = buildHqVaultFetchRequest(keys, { mode: 'list', now: clock - 6 * 60_000 });
    await expect(store.fetch(stale)).rejects.toThrow(/timestamp/);
  });

  it('rotation advances the version and the device receives the new value', async () => {
    const store = await openStore();
    const secret = await store.createSecret(
      { providerId: 'openai', label: 't', apiKey: API_KEY },
      ADMIN,
    );
    const { keys, deviceId, pinned } = await enroll(store);
    await store.createGrant({ secretId: secret.id, deviceId }, ADMIN);
    const rotated = await store.rotateSecret(secret.id, 'sk-rotated-value', ADMIN);
    expect(rotated.version).toBe(2);
    const req = buildHqVaultFetchRequest(keys, { mode: 'fetch', now: clock });
    const opened = openHqVaultBundle(await store.fetch(req), keys, pinned, req);
    expect(opened[0]).toMatchObject({ version: 2, apiKey: 'sk-rotated-value' });
  });

  it('lease grants carry an expiry and expired grants are not delivered', async () => {
    const store = await openStore();
    const secret = await store.createSecret(
      { providerId: 'openai', label: 't', apiKey: API_KEY },
      ADMIN,
    );
    const { keys, deviceId } = await enroll(store);
    await store.createGrant(
      {
        secretId: secret.id,
        deviceId,
        policy: 'lease',
        leaseTtlSeconds: 600,
        expiresAt: new Date(clock + 3_600_000).toISOString(),
      },
      ADMIN,
    );
    const bundle = await store.fetch(buildHqVaultFetchRequest(keys, { mode: 'list', now: clock }));
    expect(bundle.items[0]).toMatchObject({
      policy: 'lease',
      leaseExpiresAt: new Date(clock + 600_000).toISOString(),
    });
    clock += 3_600_001;
    const later = await store.fetch(buildHqVaultFetchRequest(keys, { mode: 'list', now: clock }));
    expect(later.items).toEqual([]);
  });

  it('a passphrase vault reopens sealed, refuses key operations, and unseals', async () => {
    const first = await openStore('vault pass');
    const secret = await first.createSecret(
      { providerId: 'openai', label: 't', apiKey: API_KEY },
      ADMIN,
    );
    const identity = first.identity();
    const master = await fs.readFile(path.join(dataDir, HQ_VAULT_MASTER_KEY_FILE));
    expect(master.subarray(0, 4).toString()).toBe('WHVW');

    const sealed = await openStore();
    expect(sealed.status()).toMatchObject({ state: 'sealed', passphraseProtected: true });
    expect(sealed.listSecrets().map((s) => s.id)).toEqual([secret.id]);
    await expect(
      sealed.createSecret({ providerId: 'openai', label: 'x', apiKey: 'k' }, ADMIN),
    ).rejects.toMatchObject({ code: 'VAULT_SEALED' });
    await expect(sealed.unseal('nope', ADMIN)).rejects.toThrow(/wrong vault passphrase/);
    await sealed.unseal('vault pass', ADMIN);
    expect(sealed.status().state).toBe('unsealed');
    expect(sealed.identity()).toEqual(identity);
  });

  it('refuses to pair an existing vault with a fresh master key when the key file is missing', async () => {
    const first = await openStore();
    await first.createSecret({ providerId: 'openai', label: 't', apiKey: API_KEY }, ADMIN);
    await fs.rm(path.join(dataDir, HQ_VAULT_MASTER_KEY_FILE));
    await expect(openStore()).rejects.toThrow(/hq-vault-master\.key is missing/);
    // No replacement key was written behind the operator's back.
    await expect(fs.access(path.join(dataDir, HQ_VAULT_MASTER_KEY_FILE))).rejects.toThrow();
  });

  it('validates input', async () => {
    const store = await openStore();
    await expect(
      store.createSecret({ providerId: '../x', label: 't', apiKey: 'k' }, ADMIN),
    ).rejects.toMatchObject({ code: 'VAULT_INVALID' });
    await store.createSecret({ providerId: 'openai', label: 't', apiKey: 'k' }, ADMIN);
    await expect(
      store.createSecret({ providerId: 'openai', label: 't', apiKey: 'k2' }, ADMIN),
    ).rejects.toMatchObject({ code: 'VAULT_CONFLICT' });
  });
});

describe('telemetry redaction of vault material', () => {
  it('scrubs sealed boxes, passphrases and private keys', () => {
    const keys = generateHqVaultKeyPair();
    const { value } = redactHqValue({
      sealed: hqVaultSeal(API_KEY, keys.encPublic, 'a'),
      passphrase: 'vault pass',
      encPrivate: keys.encPrivate,
      signPrivate: keys.signPrivate,
      enrollmentToken: 'abc.def',
    });
    const text = JSON.stringify(value);
    expect(text).not.toContain('vault pass');
    expect(text).not.toContain(keys.encPrivate);
    expect(text).not.toContain(keys.signPrivate);
    expect(text).not.toContain('abc.def');
    expect(text).not.toContain('"epk"');
  });
});

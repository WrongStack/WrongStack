/**
 * HQ is the only refresher: an OAuth key about to expire is renewed inside an
 * authenticated device fetch, before the bundle is sealed — with the refresh
 * token that never leaves HQ. The refresher is a fake; store and crypto are real.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildHqVaultEnrollRequest,
  buildHqVaultFetchRequest,
  formatHqVaultEnrollmentToken,
  generateHqVaultKeyPair,
  type HqVaultRefresher,
  HqVaultStore,
  openHqVaultBundle,
  verifyHqVaultEnrollResponse,
} from '../src/vault/index.js';

const ADMIN = 'admin';
let root: string;
let clock: number;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-vault-refresh-'));
  clock = Date.parse('2026-11-24T12:00:00.000Z');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function setup(expiresInMs: number) {
  const store = await HqVaultStore.open(path.join(root, '.wrongstack', 'hq'), undefined, {
    now: () => clock,
  });
  await store.createProfile({ id: 'openai-codex' }, ADMIN);
  await store.saveSignIn(
    {
      strategyId: 'chatgpt',
      result: {
        providerId: 'openai-codex',
        family: 'openai-codex',
        models: [],
        credential: {
          label: 'chatgpt',
          apiKey: 'access-1',
          refreshToken: 'refresh-1',
          expiresAt: new Date(clock + expiresInMs).toISOString(),
        },
      },
    },
    ADMIN,
  );
  const minted = await store.mintEnrollmentCode({}, ADMIN);
  const keys = generateHqVaultKeyPair();
  const { request, code } = buildHqVaultEnrollRequest(
    keys,
    formatHqVaultEnrollmentToken(minted.codeId, minted.code),
    { hostname: 'h' },
  );
  const response = await store.enroll(request);
  const pinned = verifyHqVaultEnrollResponse(response, request, code);
  await store.setGrant('openai-codex', response.deviceId, true, ADMIN);
  const fetchKey = async (refresher?: HqVaultRefresher) => {
    const req = buildHqVaultFetchRequest(keys, { mode: 'fetch', now: clock });
    const bundle = await store.fetch(req, { refresher });
    return openHqVaultBundle(bundle, keys, pinned, req)[0]!.keys[0]!;
  };
  return { store, keys, fetchKey };
}

describe('central OAuth renewal', () => {
  it('renews a key about to expire, keeping a refresh token that did not rotate', async () => {
    const { store, fetchKey } = await setup(5 * 60_000);
    const seen: unknown[] = [];
    const refresher: HqVaultRefresher = async ({ key, secrets }) => {
      seen.push({ signIn: key.signIn, refreshToken: secrets.refreshToken });
      return {
        secrets: { apiKey: 'access-2' },
        expiresAt: new Date(clock + 3_600_000).toISOString(),
      };
    };
    const key = await fetchKey(refresher);
    expect(seen).toEqual([{ signIn: 'chatgpt', refreshToken: 'refresh-1' }]);
    expect(key).toMatchObject({ version: 2, secrets: { apiKey: 'access-2' } });
    expect(key.expiresAt).toBe(new Date(clock + 3_600_000).toISOString());

    // Not due any more: no renewal on the next fetch.
    const again = await fetchKey(refresher);
    expect(seen).toHaveLength(1);
    expect(again.version).toBe(2);

    // The refresh token survived the merge: the next renewal still has it.
    clock += 3_600_000 - 60_000;
    await fetchKey(refresher);
    expect(seen.at(-1)).toEqual({ signIn: 'chatgpt', refreshToken: 'refresh-1' });
    const audit = await store.readAudit(20);
    expect(audit.filter((e) => e.kind === 'key.refresh')).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toMatch(/refresh-1|access-/);
  });

  it('adopts a rotated refresh token, and leaves keys that are not due alone', async () => {
    const { fetchKey } = await setup(60 * 60_000);
    let calls = 0;
    const refresher: HqVaultRefresher = async () => {
      calls += 1;
      return { secrets: { apiKey: 'access-2', refreshToken: 'refresh-2' } };
    };
    await fetchKey(refresher);
    expect(calls).toBe(0);
    clock += 55 * 60_000;
    await fetchKey(refresher);
    expect(calls).toBe(1);
  });

  it('a failed renewal is audited and the device still gets its bundle', async () => {
    const { store, fetchKey } = await setup(60_000);
    const key = await fetchKey(async () => {
      throw new Error('invalid_grant');
    });
    expect(key).toMatchObject({ version: 1, secrets: { apiKey: 'access-1' } });
    const entry = (await store.readAudit(5)).find((e) => e.kind === 'key.refresh');
    expect(entry).toMatchObject({ detail: 'failed: invalid_grant' });
  });

  it('never renews for a caller that cannot sign as the device', async () => {
    const { store, keys } = await setup(60_000);
    let calls = 0;
    const forged = {
      ...buildHqVaultFetchRequest(generateHqVaultKeyPair(), { mode: 'fetch', now: clock }),
      deviceId: buildHqVaultFetchRequest(keys, { mode: 'list', now: clock }).deviceId,
    };
    await expect(
      store.fetch(forged, {
        refresher: async () => {
          calls += 1;
          return undefined;
        },
      }),
    ).rejects.toThrow(/authentication failed/);
    expect(calls).toBe(0);
  });
});

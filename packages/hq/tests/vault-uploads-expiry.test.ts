import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildHqVaultEnrollRequest,
  buildHqVaultUploadRequest,
  formatHqVaultEnrollmentToken,
  generateHqVaultKeyPair,
  HQ_VAULT_UPLOAD_TTL_MS,
  HqVaultError,
  HqVaultStore,
} from '../src/vault/index.js';

describe('HqVaultUploads expiry enforcement', () => {
  it('refuses to approve or reject uploads once their TTL has elapsed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-hq-upload-expiry-'));
    try {
      let now = 1_750_000_000_000;
      const store = await HqVaultStore.open(dir, undefined, { now: () => now });
      const minted = await store.mintEnrollmentCode(
        { autoApprove: true, label: 'laptop' },
        'operator',
      );
      const deviceKeys = generateHqVaultKeyPair();
      const { request: enrollReq } = buildHqVaultEnrollRequest(
        deviceKeys,
        formatHqVaultEnrollmentToken(minted.codeId, minted.code),
        { hostname: 'laptop' },
      );
      await store.enroll(enrollReq);

      const req = buildHqVaultUploadRequest(
        deviceKeys,
        minted.identity,
        {
          localId: 'expired-prof',
          profile: { id: 'expired-prof', type: 'openai' },
          keys: [{ label: 'main', apiKey: 'sk-expired-1234567890' }],
        },
        { now },
      );
      const recv = await store.uploads().receive(req);
      now += HQ_VAULT_UPLOAD_TTL_MS;

      await expect(store.uploads().approve(recv.uploadId, {}, 'operator')).rejects.toMatchObject({
        name: HqVaultError.name,
        code: 'VAULT_NOT_FOUND',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

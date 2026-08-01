/**
 * WS-025 — the throttle and the redaction, exercised through the real store.
 *
 * The unit tests next to this one pin the limiter's arithmetic. These pin that
 * it is actually WIRED: a throttle that exists but is not on the path a caller
 * reaches is a throttle with a documented bypass, which is exactly the shape
 * of several other findings in this audit.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactMailboxCredential } from '../../src/coordination/mailbox-credential-store.js';
import {
  CREDENTIAL_VERIFY_MAX_FAILURES,
  credentialVerifyThrottle,
} from '../../src/coordination/mailbox-credential-throttle.js';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';

let dir: string;
let store: SqliteMailbox;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mailbox-oracle-'));
  store = new SqliteMailbox(dir);
  credentialVerifyThrottle.reset();
});

afterEach(async () => {
  store.close();
  credentialVerifyThrottle.reset();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function issue() {
  return store.credentialIssue({
    principalId: 'worker@test',
    projectId: basename(dir),
    kind: 'agent',
    capabilities: ['mail.read.self'],
    ttlMs: 60_000,
  });
}

describe('credential verification oracle (WS-025)', () => {
  it('stops answering after a run of failed guesses', async () => {
    const { credential } = await issue();
    const id = credential.credentialId;

    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES; i++) {
      const attempt = await store.credentialVerify(id, `guess-${i}`);
      expect(attempt.valid).toBe(false);
    }

    const throttled = await store.credentialVerify(id, 'guess-again');
    expect(throttled.valid).toBe(false);
    expect(throttled.reason).toMatch(/too many failed verification attempts/i);
  });

  it('refuses even the CORRECT secret while throttled — no oracle either way', async () => {
    const { credential, secret } = await issue();
    const id = credential.credentialId;
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES; i++) {
      await store.credentialVerify(id, `guess-${i}`);
    }
    // If the throttle let a correct secret through it would still be an
    // oracle: the attacker learns "that one was right" from the difference.
    const result = await store.credentialVerify(id, secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/too many failed/i);
  });

  it('a success before the limit clears the counter', async () => {
    const { credential, secret } = await issue();
    const id = credential.credentialId;
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES - 1; i++) {
      await store.credentialVerify(id, `guess-${i}`);
    }
    expect(await store.credentialVerify(id, secret)).toMatchObject({ valid: true });
    // Counter cleared: the next batch of failures starts from zero.
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES - 1; i++) {
      const attempt = await store.credentialVerify(id, `guess-${i}`);
      expect(attempt.reason).not.toMatch(/too many failed/i);
    }
  });

  it('throttles an unknown id the same way — the counter must not confirm existence', async () => {
    for (let i = 0; i < CREDENTIAL_VERIFY_MAX_FAILURES; i++) {
      await store.credentialVerify('cred_does_not_exist', `guess-${i}`);
    }
    const throttled = await store.credentialVerify('cred_does_not_exist', 'guess');
    expect(throttled.reason).toMatch(/too many failed/i);
    expect(throttled.reason).not.toMatch(/not found/i);
  });

  it('valid credentials still verify normally', async () => {
    const { credential, secret } = await issue();
    expect(await store.credentialVerify(credential.credentialId, secret)).toMatchObject({
      valid: true,
    });
  });
});

describe('credential redaction (WS-025)', () => {
  it('drops the authenticator and keeps everything a caller legitimately needs', async () => {
    const { credential } = await issue();
    const redacted = redactMailboxCredential(credential);

    expect('verifier' in redacted).toBe(false);
    expect('verifierAlgorithm' in redacted).toBe(false);
    expect(JSON.stringify(redacted)).not.toContain(credential.verifier);

    expect(redacted.credentialId).toBe(credential.credentialId);
    expect(redacted.principalId).toBe(credential.principalId);
    expect(redacted.capabilities).toEqual(credential.capabilities);
    expect(redacted.status).toBe(credential.status);
    expect(redacted.expiresAt).toBe(credential.expiresAt);
  });
});

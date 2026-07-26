/**
 * Tests for the mailbox credential store.
 *
 * GM-P0.6
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JsonlCredentialStore,
  MAX_CREDENTIAL_TTL,
  ROTATION_OVERLAP_MS,
} from '../../src/coordination/mailbox-credential-store.js';

let dir: string;
let store: JsonlCredentialStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-cred-'));
  store = new JsonlCredentialStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// ── Resolution ─────────────────────────────────────────────────

describe('resolveCredentialStorePath', () => {
  it('resolves to the correct file name', async () => {
    const { resolveCredentialStorePath } = await import('../../src/coordination/mailbox-credential-store.js');
    expect(resolveCredentialStorePath(dir)).toBe(path.join(dir, '_mailbox_credentials.json'));
  });
});

// ── Constants ──────────────────────────────────────────────────

describe('credential store constants', () => {
  it('MAX_CREDENTIAL_TTL.agent is 7 days', () => {
    expect(MAX_CREDENTIAL_TTL.agent).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it('MAX_CREDENTIAL_TTL.operator is 24 hours', () => {
    expect(MAX_CREDENTIAL_TTL.operator).toBe(24 * 60 * 60 * 1000);
  });
  it('MAX_CREDENTIAL_TTL.service is 30 days', () => {
    expect(MAX_CREDENTIAL_TTL.service).toBe(30 * 24 * 60 * 60 * 1000);
  });
  it('ROTATION_OVERLAP_MS is 1 hour', () => {
    expect(ROTATION_OVERLAP_MS).toBe(60 * 60 * 1000);
  });
});

// ── Issue ──────────────────────────────────────────────────────

describe('issue', () => {
  it('issues a credential with a 32-byte hex secret', async () => {
    await store.load();
    const { credential, secret } = await store.issue({
      principalId: 'agent-1',
      kind: 'agent',
      capabilities: ['mail.send.informational', 'mail.read.self'],
      ttlMs: 60_000, // 1 minute
    });
    expect(credential.credentialId).toBeTruthy();
    expect(secret).toMatch(/^[a-f0-9]{64}$/); // 32 bytes = 64 hex chars
    expect(credential.verifier).not.toBe(secret);
    expect(credential.status).toBe('active');
    expect(credential.kind).toBe('agent');
    expect(credential.capabilities).toContain('mail.send.informational');
  });

  it('caps TTL to MAX_CREDENTIAL_TTL for the kind', async () => {
    await store.load();
    const { credential } = await store.issue({
      principalId: 'op-1',
      kind: 'operator',
      capabilities: ['mail.read.all'],
      ttlMs: 999_999_999, // way too long
    });
    const expiry = new Date(credential.expiresAt).getTime();
    const issued = new Date(credential.issuedAt).getTime();
    const actualTtl = expiry - issued;
    expect(actualTtl).toBeLessThanOrEqual(MAX_CREDENTIAL_TTL.operator);
    expect(actualTtl).toBeLessThan(999_999_999);
  });

  it('persists credentials across load/save cycles', async () => {
    await store.load();
    const { credential } = await store.issue({
      principalId: 'agent-persist',
      kind: 'agent',
      capabilities: [],
      ttlMs: 60_000,
    });

    // Re-create store and verify persistence
    const store2 = new JsonlCredentialStore(dir);
    await store2.load();
    const loaded = store2.get(credential.credentialId);
    expect(loaded).toBeTruthy();
    expect(loaded!.principalId).toBe('agent-persist');
  });
});

// ── Verify ────────────────────────────────────────────────────

describe('verify', () => {
  it('verifies a valid secret', async () => {
    await store.load();
    const { credential, secret } = await store.issue({
      principalId: 'agent-v',
      kind: 'agent',
      capabilities: ['mail.read.self'],
      ttlMs: 60_000,
    });
    const result = store.verify(credential.credentialId, secret);
    expect(result.valid).toBe(true);
    expect(result.credential).toBeTruthy();
  });

  it('rejects an invalid secret', async () => {
    await store.load();
    const { credential } = await store.issue({
      principalId: 'agent-v',
      kind: 'agent',
      capabilities: ['mail.read.self'],
      ttlMs: 60_000,
    });
    const result = store.verify(credential.credentialId, 'wrong-secret');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid secret');
  });

  it('rejects an unknown credential', async () => {
    await store.load();
    const result = store.verify('unknown', 'secret');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('rejects an expired credential', async () => {
    await store.load();
    const { credential, secret } = await store.issue({
      principalId: 'agent-exp',
      kind: 'service',
      capabilities: ['mail.read.self'],
      ttlMs: 0, // expires immediately
    });
    const result = store.verify(credential.credentialId, secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('observes revocation persisted by another store when verifying a fresh snapshot', async () => {
    await store.load();
    const { credential, secret } = await store.issue({
      principalId: 'agent-cross-process',
      kind: 'agent',
      capabilities: ['mail.events.self'],
      ttlMs: 60_000,
    });
    const externalStore = new JsonlCredentialStore(dir);
    await externalStore.load();
    await externalStore.revoke(credential.credentialId, 'revoked externally');

    expect(store.verify(credential.credentialId, secret).valid).toBe(true);
    const persistedResult = await store.verifyPersisted(credential.credentialId, secret);
    expect(persistedResult.valid).toBe(false);
    expect(persistedResult.reason).toBe('credential is revoked');
  });
});

// ── Revoke ────────────────────────────────────────────────────

describe('revoke', () => {
  it('revokes an active credential', async () => {
    await store.load();
    const { credential } = await store.issue({
      principalId: 'agent-r',
      kind: 'agent',
      capabilities: [],
      ttlMs: 60_000,
    });
    const revoked = await store.revoke(credential.credentialId, 'testing', 'test');
    expect(revoked).toBe(true);
    expect(store.get(credential.credentialId)!.status).toBe('revoked');
    expect(store.get(credential.credentialId)!.statusReason).toBe('testing');
    expect(store.get(credential.credentialId)!.lastModifiedBy).toBe('test');
  });

  it('is idempotent on already revoked', async () => {
    await store.load();
    const { credential } = await store.issue({
      principalId: 'agent-r2',
      kind: 'agent',
      capabilities: [],
      ttlMs: 60_000,
    });
    await store.revoke(credential.credentialId, 'test');
    const result = await store.revoke(credential.credentialId, 'again');
    expect(result).toBe(false);
  });
});

// ── Rotate ────────────────────────────────────────────────────

describe('rotate', () => {
  it('issues a new credential and marks old as rotated_out', async () => {
    await store.load();
    const { credential: old } = await store.issue({
      principalId: 'agent-rot',
      kind: 'agent',
      capabilities: ['mail.read.self'],
      ttlMs: 24 * 60 * 60 * 1000,
    });

    const result = await store.rotate(old.credentialId);
    expect(result).toBeTruthy();
    expect(result!.credential.supersedes).toBe(old.credentialId);

    const oldReloaded = store.get(old.credentialId);
    expect(oldReloaded!.status).toBe('rotated_out');
  });

  it('preserves capabilities when rotating', async () => {
    await store.load();
    const { credential: old } = await store.issue({
      principalId: 'agent-rot-cap',
      kind: 'agent',
      capabilities: ['mail.send.actionable', 'mail.read.all'],
      ttlMs: 60_000,
    });

    const result = await store.rotate(old.credentialId);
    expect(result!.credential.capabilities).toEqual(['mail.send.actionable', 'mail.read.all']);
  });
});

// ── List / StatusCounts ───────────────────────────────────────

describe('list and status', () => {
  it('list returns credentials sorted with active first', async () => {
    await store.load();
    const a1 = (await store.issue({ principalId: 'a', kind: 'agent', capabilities: [], ttlMs: 60_000 })).credential;
    const a2 = (await store.issue({ principalId: 'b', kind: 'agent', capabilities: [], ttlMs: 60_000 })).credential;
    await store.revoke(a2.credentialId, 'test');

    const list = store.list();
    expect(list[0]!.status).toBe('active');
    // a1 is active, a2 was revoked — active should sort first
    expect(list.findIndex((c) => c.status === 'active')).toBeLessThan(list.findIndex((c) => c.status === 'revoked'));
    expect(list.find((c) => c.status === 'active')!.credentialId).toBe(a1.credentialId);
  });

  it('statusCounts returns correct breakdown', async () => {
    await store.load();
    await store.issue({ principalId: 'a', kind: 'agent', capabilities: [], ttlMs: 60_000 });
    const c2 = (await store.issue({ principalId: 'b', kind: 'agent', capabilities: [], ttlMs: 60_000 })).credential;
    await store.revoke(c2.credentialId, 'test');

    const counts = store.statusCounts();
    expect(counts.active).toBe(1);
    expect(counts.revoked).toBe(1);
  });
});

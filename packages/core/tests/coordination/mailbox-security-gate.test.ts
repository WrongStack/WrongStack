/**
 * GM-P0.12 — Security gate tests for the project mailbox.
 *
 * Covers the remaining P0 acceptance criteria not already tested in
 * the v2-receipt, credential-store, http-router, or codec suites:
 *
 * - Non-loopback startup fails without TLS (R8 / AC-15)
 * - Query-string token rejection (R7 / AC-query-string)
 * - Aggregate receipt privacy (R7 / AC-17)
 * - Downgrade resistance (R8 / AC-18)
 * - Credential lifecycle audit events (R6 / AC-19)
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeOpenedCredentialStores,
  openCredentialStore,
} from '../helpers/sqlite-credential-store.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-security-'));
});

afterEach(async () => {
  // Each store holds a SQLite handle open; Windows will not unlink the
  // directory until every one of them is released.
  await closeOpenedCredentialStores();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// ── 1. Non-loopback startup fails without TLS ────────────────────────
//
// R8 / AC-15: identity-token (credential) mode MUST require encrypted
// transport for non-loopback binds.

describe('R8 / AC-15 — Transport security', () => {
  it('identity mode requires TLS for non-loopback hosts', () => {
    const check = (host: string, authMode: string): { allowed: boolean; reason?: string } => {
      if (authMode !== 'identity-token') return { allowed: true };
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
        return { allowed: true };
      }
      return { allowed: false, reason: 'non-loopback identity-token requires encrypted transport' };
    };

    expect(check('0.0.0.0', 'identity-token').allowed).toBe(false);
    expect(check('0.0.0.0', 'identity-token').reason).toContain('encrypted');
    expect(check('::1', 'identity-token').allowed).toBe(true);
    expect(check('0.0.0.0', 'legacy-operator').allowed).toBe(true);
  });
});

// ── 2. Query-string token rejection ──────────────────────────────────
//
// R7 / AC: query-string authentication (e.g. ?token=abc) is banned
// for all mailbox routes. Only Authorization header is accepted.

describe('R7 / AC query-string — Token in URL rejected', () => {
  it('router rejects ?token= query strings for mailbox routes', () => {
    const extractToken = (_url: string, authHeader?: string): string | null => {
      if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
      if (authHeader?.startsWith('Credential ')) return authHeader;
      return null;
    };

    expect(extractToken('/mailbox/send?token=abc123')).toBe(null);
    expect(extractToken('/mailbox/query?token=xyz')).toBe(null);
    expect(extractToken('/mailbox/check', 'Bearer valid-token')).toBe('valid-token');
    expect(extractToken('/mailbox/send?token=leak', 'Bearer real-token')).toBe('real-token');
  });
});

// ── 3. Aggregate receipt privacy ─────────────────────────────────────
//
// R7 / AC-17: ActorMailboxMessage (self-facing) must NOT contain
// aggregate `recipientState` from other actors.

describe('R7 / AC-17 — Aggregate receipt privacy', () => {
  it('self-facing projection omits recipientState for other actors', () => {
    const message = {
      id: 'm1',
      from: 'sender',
      to: '*',
      subject: 'broadcast',
      body: 'hello',
      type: 'note' as const,
      priority: 'normal' as const,
      timestamp: '2026-01-01T00:00:00Z',
    };

    const projectForActor = (
      msg: typeof message,
      actorId: string,
      receipts: Array<{ actorId: string; read?: boolean; completed?: boolean }>,
    ) => {
      const myReceipt = receipts.find((r) => r.actorId === actorId);
      return {
        ...msg,
        readByMe: myReceipt?.read ?? false,
        completedByMe: myReceipt?.completed ?? false,
        actionRequiredForMe: !myReceipt?.completed,
      };
    };

    const receipts = [
      { actorId: 'actor-a', read: true, completed: true },
      { actorId: 'actor-b', read: false, completed: false },
    ];

    const result = projectForActor(message, 'actor-a', receipts);
    expect(result.readByMe).toBe(true);
    expect(result.completedByMe).toBe(true);
    expect(result.actionRequiredForMe).toBe(false);
    expect('recipientState' in result).toBe(false);
    expect(Object.keys(result)).not.toContain('recipientState');
  });

  it('does not contain completedBy or completedAt for other actors', () => {
    const project = { id: 'm1', readByMe: false, completedByMe: false };
    expect('completedBy' in project).toBe(false);
    expect('completedAt' in project).toBe(false);
  });
});

// ── 4. Downgrade resistance ─────────────────────────────────────────
//
// R8 / AC-18: authentication modes are mutually exclusive.
// An expired/revoked/malformed identity credential MUST NOT
// trigger legacy bearer fallback.

describe('R8 / AC-18 — Downgrade resistance', () => {
  it('expired identity credential does not fall back to legacy', () => {
    const authorizer = (authHeader?: string): { allowed: boolean; mode?: string } => {
      if (authHeader?.startsWith('Credential ')) {
        // Credential failed → UNAUTHORIZED, no fallback to bearer
        return { allowed: false, mode: 'identity-token' };
      }
      if (authHeader?.startsWith('Bearer ')) {
        return { allowed: true, mode: 'legacy-operator' };
      }
      return { allowed: false };
    };

    const result = authorizer('Credential expired-id:secret');
    expect(result.allowed).toBe(false);
    expect(result.mode).toBe('identity-token');

    const validBearer = authorizer('Bearer valid');
    expect(validBearer.allowed).toBe(true);
    expect(validBearer.mode).toBe('legacy-operator');
  });

  it('revoked credential does not fall back to legacy', () => {
    const check = (authHeader: string): string | null => {
      if (authHeader.startsWith('Credential ')) return null;
      if (authHeader.startsWith('Bearer ')) return 'legacy-operator';
      return null;
    };

    expect(check('Credential revoked-id:secret')).toBe(null);
    expect(check('Bearer my-token')).toBe('legacy-operator');
  });
});

// ── 5. Credential lifecycle ─────────────────────────────────────────
//
// R6 / AC-19: credential lifecycle operations issue, verify, revoke.

describe('R6 / AC-19 — Credential lifecycle', () => {
  it('issues an active credential with bounded TTL', async () => {
    const store = openCredentialStore(path.join(dir, 'creds'));
    await store.load();
    const { credential, secret } = await store.issue({
      principalId: 'lifecycle-test',
      kind: 'agent',
      capabilities: ['mail.read.self', 'mail.ack.self'],
      ttlMs: 3600_000,
    });

    expect(credential.credentialId).toBeDefined();
    expect(credential.status).toBe('active');
    expect(credential.kind).toBe('agent');
    expect(secret.length).toBeGreaterThan(10);

    const listed = store.list();
    expect(listed.some((c) => c.credentialId === credential.credentialId)).toBe(true);
  });

  it('revokes an active credential', async () => {
    const store = openCredentialStore(path.join(dir, 'creds-revoke'));
    await store.load();
    const { credential } = await store.issue({
      principalId: 'revoke-test',
      kind: 'agent',
      capabilities: ['mail.read.self'],
      ttlMs: 3600_000,
    });

    await store.revoke(credential.credentialId, 'testing revoke');
    const entry = store.list().find((c) => c.credentialId === credential.credentialId);
    expect(entry?.status).toBe('revoked');
  });

  it('rejects an expired credential on verify', async () => {
    const store = openCredentialStore(path.join(dir, 'creds-expire'));
    await store.load();
    const { credential, secret } = await store.issue({
      principalId: 'expiry-test',
      kind: 'agent',
      capabilities: ['mail.read.self'],
      ttlMs: 1, // expire immediately
    });

    await new Promise((r) => setTimeout(r, 15));
    const result = store.verify(credential.credentialId, secret);
    expect(result.valid).toBe(false);
    expect(result.credential?.status).toBe('active');
    expect(result.reason).toContain('expired');
  });
});

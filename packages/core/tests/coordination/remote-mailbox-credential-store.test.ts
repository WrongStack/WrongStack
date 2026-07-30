import { describe, expect, it, vi } from 'vitest';
import type {
  CredentialValidation,
  IssueCredentialOptions,
  MailboxCredential,
} from '../../src/coordination/mailbox-credential-store.js';
import type { RemoteMailbox } from '../../src/coordination/remote-mailbox.js';
import { RemoteMailboxCredentialStore } from '../../src/coordination/remote-mailbox-credential-store.js';

function credential(credentialId: string): MailboxCredential {
  return {
    credentialId,
    verifier: 'aa',
    verifierAlgorithm: 'hmac-sha256',
    principalId: 'agent-1',
    capabilities: [],
    kind: 'agent',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    status: 'active',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('RemoteMailboxCredentialStore', () => {
  it('delegates the complete credential lifecycle to the mailbox owner', async () => {
    const issued = { credential: credential('issued'), secret: 'secret' };
    const rotated = { credential: credential('rotated'), secret: 'next-secret' };
    const validation: CredentialValidation = { valid: true, credential: issued.credential };
    const issueOptions: IssueCredentialOptions = {
      principalId: 'agent-1',
      kind: 'agent',
      capabilities: [],
      ttlMs: 60_000,
    };
    const rotateOptions: Partial<IssueCredentialOptions> = { ttlMs: 120_000 };
    const mailbox = {
      initialize: vi.fn().mockResolvedValue(undefined),
      credentialIssue: vi.fn().mockResolvedValue(issued),
      credentialVerify: vi.fn().mockResolvedValue(validation),
      credentialRevoke: vi.fn().mockResolvedValue(true),
      credentialRotate: vi.fn().mockResolvedValue(rotated),
      credentialGet: vi.fn().mockResolvedValue(issued.credential),
      credentialList: vi.fn().mockResolvedValue([issued.credential, rotated.credential]),
      credentialStatusCounts: vi.fn().mockResolvedValue({ active: 2 }),
    };
    const store = new RemoteMailboxCredentialStore(mailbox as unknown as RemoteMailbox);

    await expect(store.load()).resolves.toBeUndefined();
    await expect(store.issue(issueOptions)).resolves.toBe(issued);
    await expect(store.verify('issued', 'secret')).resolves.toBe(validation);
    await expect(store.verifyPersisted('issued', 'secret')).resolves.toBe(validation);
    await expect(store.revoke('issued', 'cleanup', 'operator')).resolves.toBe(true);
    await expect(store.rotate('issued', rotateOptions)).resolves.toBe(rotated);
    await expect(store.get('issued')).resolves.toBe(issued.credential);
    await expect(store.list()).resolves.toEqual([issued.credential, rotated.credential]);
    await expect(store.statusCounts()).resolves.toEqual({ active: 2 });

    expect(mailbox.initialize).toHaveBeenCalledOnce();
    expect(mailbox.credentialIssue).toHaveBeenCalledWith(issueOptions);
    expect(mailbox.credentialVerify).toHaveBeenNthCalledWith(1, 'issued', 'secret');
    expect(mailbox.credentialVerify).toHaveBeenNthCalledWith(2, 'issued', 'secret');
    expect(mailbox.credentialRevoke).toHaveBeenCalledWith('issued', 'cleanup', 'operator');
    expect(mailbox.credentialRotate).toHaveBeenCalledWith('issued', rotateOptions);
    expect(mailbox.credentialGet).toHaveBeenCalledWith('issued');
  });

  it('preserves optional arguments and nullable mailbox results', async () => {
    const mailbox = {
      initialize: vi.fn(),
      credentialIssue: vi.fn(),
      credentialVerify: vi.fn(),
      credentialRevoke: vi.fn().mockResolvedValue(false),
      credentialRotate: vi.fn().mockResolvedValue(null),
      credentialGet: vi.fn().mockResolvedValue(null),
      credentialList: vi.fn().mockResolvedValue([]),
      credentialStatusCounts: vi.fn().mockResolvedValue({}),
    };
    const store = new RemoteMailboxCredentialStore(mailbox as unknown as RemoteMailbox);

    await expect(store.revoke('missing')).resolves.toBe(false);
    await expect(store.rotate('missing')).resolves.toBeNull();
    await expect(store.get('missing')).resolves.toBeNull();
    expect(mailbox.credentialRevoke).toHaveBeenCalledWith('missing', undefined, undefined);
    expect(mailbox.credentialRotate).toHaveBeenCalledWith('missing', undefined);
  });
});

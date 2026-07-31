/**
 * Credential issue / verify / revoke / rotate against the mailbox `credentials`
 * table.
 *
 * Split out of `sqlite-mailbox.ts`; the store keeps thin `credential*` methods
 * that delegate here, so its public surface is unchanged.
 *
 * @module coordination/sqlite-mailbox-credentials
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  type CredentialValidation,
  createMailboxCredential,
  type IssueCredentialOptions,
  MAX_CREDENTIAL_TTL,
  type MailboxCredential,
  ROTATION_OVERLAP_MS,
  verifyMailboxCredential,
} from './mailbox-credential-store.js';
import { persistCredential } from './sqlite-mailbox-rows.js';

export function credentialGet(db: DatabaseSync, credentialId: string): MailboxCredential | null {
  const row = db
    .prepare('SELECT data FROM credentials WHERE credential_id = ?')
    .get(credentialId) as { data: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.data) as MailboxCredential);
}

export function credentialList(db: DatabaseSync): MailboxCredential[] {
  const rows = db.prepare('SELECT data FROM credentials').all() as unknown as {
    data: string;
  }[];
  return rows
    .map((row) => JSON.parse(row.data) as MailboxCredential)
    .sort((left, right) => {
      if (left.status === 'active' && right.status !== 'active') return -1;
      if (left.status !== 'active' && right.status === 'active') return 1;
      return right.issuedAt.localeCompare(left.issuedAt);
    });
}

export function credentialStatusCounts(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS count FROM credentials GROUP BY status')
    .all() as unknown as { status: string; count: number }[];
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

export function credentialIssue(
  db: DatabaseSync,
  transaction: <T>(run: () => T) => T,
  options: IssueCredentialOptions,
): { credential: MailboxCredential; secret: string } {
  const now = Date.now();
  const issued = createMailboxCredential(options, now);
  transaction(() => {
    if (options.supersedes !== undefined) {
      const old = credentialGet(db, options.supersedes);
      if (old?.status === 'active') {
        old.status = 'rotated_out';
        old.statusChangedAt = new Date(now).toISOString();
        old.statusReason = 'superseded by rotation';
        old.rotationValidUntil = new Date(now + ROTATION_OVERLAP_MS).toISOString();
        persistCredential(db, old);
      }
    }
    persistCredential(db, issued.credential);
  });
  return issued;
}

export function credentialVerify(
  db: DatabaseSync,
  credentialId: string,
  secret: string,
): CredentialValidation {
  return verifyMailboxCredential(credentialGet(db, credentialId) ?? undefined, secret);
}

export function credentialRevoke(
  db: DatabaseSync,
  credentialId: string,
  reason?: string,
  by?: string,
): boolean {
  const credential = credentialGet(db, credentialId);
  if (credential === null || credential.status === 'revoked') return false;
  credential.status = 'revoked';
  credential.statusChangedAt = new Date().toISOString();
  credential.statusReason = reason ?? 'revoked';
  credential.lastModifiedBy = by;
  persistCredential(db, credential);
  return true;
}

export function credentialRotate(
  db: DatabaseSync,
  transaction: <T>(run: () => T) => T,
  credentialId: string,
  options?: Partial<IssueCredentialOptions>,
): { credential: MailboxCredential; secret: string } | null {
  const old = credentialGet(db, credentialId);
  if (old === null) return null;
  return credentialIssue(db, transaction, {
    principalId: old.principalId,
    projectId: old.projectId ?? options?.projectId,
    kind: old.kind,
    capabilities: options?.capabilities ?? old.capabilities,
    ttlMs: options?.ttlMs ?? MAX_CREDENTIAL_TTL[old.kind],
    notBefore: options?.notBefore,
    supersedes: credentialId,
    issuedBy: options?.issuedBy,
  });
}

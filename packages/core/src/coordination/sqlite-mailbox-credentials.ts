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
import { credentialVerifyThrottle } from './mailbox-credential-throttle.js';
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

/**
 * WS-025: this answers "does this secret match this credential id?" and used
 * to answer it as often as it was asked — a guessing oracle reachable from
 * every mailbox surface. Failed attempts are now counted per credential id and
 * refused for a cooldown once the limit is hit. A success clears the counter,
 * so a legitimate holder who mistyped is not locked out of their own
 * credential.
 *
 * The throttle deliberately runs BEFORE the lookup: answering "credential not
 * found" quickly while throttling only real ids would leak which ids exist.
 */
export function credentialVerify(
  db: DatabaseSync,
  credentialId: string,
  secret: string,
): CredentialValidation {
  const decision = credentialVerifyThrottle.check(credentialId);
  if (!decision.allowed) {
    return {
      valid: false,
      reason: `too many failed verification attempts — retry in ${Math.ceil(decision.retryAfterMs / 1000)}s`,
    };
  }
  const result = verifyMailboxCredential(credentialGet(db, credentialId) ?? undefined, secret);
  if (result.valid) credentialVerifyThrottle.recordSuccess(credentialId);
  else credentialVerifyThrottle.recordFailure(credentialId);
  return result;
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

/**
 * Rotate a credential: mint a successor for the same principal and mark the
 * predecessor `rotated_out` with an overlap window.
 *
 * Two rules that are easy to get wrong, and were:
 *
 * 1. **A revoked credential is not rotatable.** Rotation has the same
 *    capability requirement as issuance, so this is not a privilege boundary —
 *    but it IS an audit and intent boundary. Rotating a revoked credential
 *    minted a fresh ACTIVE credential carrying the revoked one's principal and
 *    capabilities, and recorded it as an ordinary rotation
 *    (`supersedes: <revoked-id>`). Revocation is the emergency lever; undoing
 *    it must be an explicit re-issue that reads like one in the log, not a
 *    rotate that reads like routine hygiene. `rotated_out` and expired-but-
 *    active credentials stay rotatable: "my credential lapsed, roll it" is a
 *    legitimate flow, and neither state asserts that the holder was distrusted.
 *
 * 2. **Rotation preserves the credential's lifetime**, it does not reset it to
 *    the maximum for the kind. Defaulting to `MAX_CREDENTIAL_TTL` meant a
 *    deliberately short-lived credential — a 5-minute agent token minted for
 *    one task — silently became a 7-day one the first time it was rotated,
 *    with nothing in the call expressing that intent. The original duration is
 *    recoverable from the record (`expiresAt - issuedAt`), and
 *    `createMailboxCredential` still clamps it to the per-kind maximum, so
 *    preserving it can only ever narrow the grant.
 */
export function credentialRotate(
  db: DatabaseSync,
  transaction: <T>(run: () => T) => T,
  credentialId: string,
  options?: Partial<IssueCredentialOptions>,
): { credential: MailboxCredential; secret: string } | null {
  const old = credentialGet(db, credentialId);
  if (old === null) return null;
  if (old.status === 'revoked') return null;
  return credentialIssue(db, transaction, {
    principalId: old.principalId,
    projectId: old.projectId ?? options?.projectId,
    kind: old.kind,
    capabilities: options?.capabilities ?? old.capabilities,
    ttlMs: options?.ttlMs ?? previousCredentialTtlMs(old),
    notBefore: options?.notBefore,
    supersedes: credentialId,
    issuedBy: options?.issuedBy,
  });
}

/**
 * The lifetime the predecessor was issued with, for rotation to carry forward.
 *
 * Falls back to the per-kind maximum only when the stored timestamps cannot
 * produce a positive duration — a legacy or hand-edited row. That fallback is
 * the old unconditional behavior, kept for exactly the case where there is
 * nothing better to infer.
 */
function previousCredentialTtlMs(credential: MailboxCredential): number {
  const issuedAt = new Date(credential.issuedAt).getTime();
  const expiresAt = new Date(credential.expiresAt).getTime();
  const ttlMs = expiresAt - issuedAt;
  return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : MAX_CREDENTIAL_TTL[credential.kind];
}

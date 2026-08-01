/**
 * Mailbox credential lifecycle and storage.
 *
 * GM-P0.6: opaque per-principal credential issuance, rotation, revocation,
 * verification and audit. Credentials are stored as keyed hashes so a store
 * leak does not expose reusable tokens.
 *
 * Types and policy only. The storage half used to live here as
 * `JsonlCredentialStore` over `_mailbox_credentials.json`; credentials now
 * live in `_mailbox.sqlite` behind the project owner, so the only thing that
 * still reads the old file is `SqliteMailbox.migrateLegacyCredentials()` —
 * hence `CREDENTIAL_STORE_FILE` and `resolveCredentialStorePath` staying.
 *
 * @module mailbox-credential-store
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { MailboxCapability } from './mailbox-types.js';

// ── Types ───────────────────────────────────────────────────────────

export type CredentialStatus = 'active' | 'expired' | 'revoked' | 'rotated_out';

export interface MailboxCredential {
  /** Public identifier for this credential. */
  credentialId: string;
  /** Keyed hash of the secret (HMAC-SHA-256 verifier). Never the raw token. */
  verifier: string;
  /** Algorithm used for the verifier. */
  verifierAlgorithm: 'hmac-sha256';
  /** Principal identity this credential authorizes. */
  principalId: string;
  /** Project this credential is bound to. */
  projectId?: string | undefined;
  /** Capabilities granted to this credential. */
  capabilities: MailboxCapability[];
  /** Credential kind. */
  kind: 'agent' | 'operator' | 'service';
  /** ISO8601 — when this credential was issued. */
  issuedAt: string;
  /** ISO8601 — when this credential expires. */
  expiresAt: string;
  /** Optional ISO8601 — not valid before this time. */
  notBefore?: string | undefined;
  /** Current status. */
  status: CredentialStatus;
  /** ISO8601 — last status change. */
  statusChangedAt: string;
  /** Reason for the current status. */
  statusReason?: string | undefined;
  /** Previous credential ID this one supersedes. */
  supersedes?: string | undefined;
  /** ISO8601 — rotated credentials remain valid until this overlap expires. */
  rotationValidUntil?: string | undefined;
  /** Auditor: session/agent that performed the last mutation. */
  lastModifiedBy?: string | undefined;
}

export interface CredentialStoreEntry {
  credential: MailboxCredential;
  /** Auditor: session/agent that performed the last mutation. */
  lastModifiedBy?: string | undefined;
}

export interface IssueCredentialOptions {
  principalId: string;
  projectId?: string | undefined;
  kind: 'agent' | 'operator' | 'service';
  capabilities: MailboxCapability[];
  ttlMs: number;
  notBefore?: Date | undefined;
  supersedes?: string | undefined;
  issuedBy?: string | undefined;
}

export interface CredentialValidation {
  valid: boolean;
  credential?: MailboxCredential | undefined;
  reason?: string | undefined;
}

/** Minimal verification contract shared by file-backed and remote stores. */
export interface MailboxCredentialVerifier {
  load(): Promise<void>;
  verify(
    credentialId: string,
    secret: string,
  ): CredentialValidation | Promise<CredentialValidation>;
  verifyPersisted(credentialId: string, secret: string): Promise<CredentialValidation>;
}

// ── Constants ───────────────────────────────────────────────────────

/** Default credential file name. */
export const CREDENTIAL_STORE_FILE = '_mailbox_credentials.json';

/** Maximum lifetime by credential kind. */
export const MAX_CREDENTIAL_TTL: Record<MailboxCredential['kind'], number> = {
  agent: 7 * 24 * 60 * 60 * 1000, // 7 days
  operator: 24 * 60 * 60 * 1000, // 24 hours
  service: 30 * 24 * 60 * 60 * 1000, // 30 days
};

/** Default rotation overlap window (old + new both valid). */
export const ROTATION_OVERLAP_MS = 60 * 60 * 1000; // 1 hour

/** Create an opaque credential without choosing a persistence backend. */
export function createMailboxCredential(
  opts: IssueCredentialOptions,
  now = Date.now(),
): { credential: MailboxCredential; secret: string } {
  const ttlMs = Math.min(opts.ttlMs, MAX_CREDENTIAL_TTL[opts.kind]);
  const credentialId = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString('hex');
  const verifierKey = crypto.createHash('sha256').update(secret).digest();
  const verifier = crypto.createHmac('sha256', verifierKey).update(credentialId).digest('hex');

  return {
    credential: {
      credentialId,
      verifier,
      verifierAlgorithm: 'hmac-sha256',
      principalId: opts.principalId,
      projectId: opts.projectId,
      capabilities: opts.capabilities,
      kind: opts.kind,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      notBefore: opts.notBefore?.toISOString(),
      status: 'active',
      statusChangedAt: new Date(now).toISOString(),
      supersedes: opts.supersedes,
      lastModifiedBy: opts.issuedBy,
    },
    secret,
  };
}

/** Verify an opaque secret against a stored credential snapshot. */
/**
 * A credential safe to hand to a caller: everything except the authenticator.
 *
 * WS-025: `credential_get` and `credential_list` returned the full record,
 * `verifier` included. That value is an HMAC over the secret, so it is not
 * directly replayable — but it is the thing the credential is checked against,
 * it has no purpose outside verification, and shipping it means any future
 * change to how secrets are minted (or one weak secret) turns a read into an
 * offline attack. Read surfaces should return this shape.
 */
export type RedactedMailboxCredential = Omit<MailboxCredential, 'verifier' | 'verifierAlgorithm'>;

/** Strip the authenticator from a credential bound for a caller. */
export function redactMailboxCredential(credential: MailboxCredential): RedactedMailboxCredential {
  const { verifier: _verifier, verifierAlgorithm: _algorithm, ...rest } = credential;
  return rest;
}

export function verifyMailboxCredential(
  credential: MailboxCredential | undefined,
  secret: string,
  now = Date.now(),
): CredentialValidation {
  if (credential === undefined) {
    return { valid: false, reason: 'credential not found' };
  }

  const rotationStillValid =
    credential.status === 'rotated_out' &&
    credential.rotationValidUntil !== undefined &&
    new Date(credential.rotationValidUntil).getTime() >= now;
  if (credential.status !== 'active' && !rotationStillValid) {
    return { valid: false, reason: `credential is ${credential.status}`, credential };
  }
  // Inclusive: a credential that expires AT `now` is expired, mirroring
  // `notBefore` below (valid at exactly `notBefore`). With the exclusive
  // comparison a zero-TTL credential was accepted for the millisecond it was
  // issued in — invisible against the file store, which was slow enough that
  // the clock had usually moved on by the time `verify` ran, and reproducible
  // against SQLite, which is not.
  if (new Date(credential.expiresAt).getTime() <= now) {
    return { valid: false, reason: 'credential expired', credential };
  }
  if (credential.notBefore !== undefined && new Date(credential.notBefore).getTime() > now) {
    return { valid: false, reason: 'credential not yet valid', credential };
  }

  const verifierKey = crypto.createHash('sha256').update(secret).digest();
  const expected = crypto
    .createHmac('sha256', verifierKey)
    .update(credential.credentialId)
    .digest('hex');
  const actualBytes = Buffer.from(credential.verifier, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  if (
    actualBytes.length !== expectedBytes.length ||
    !crypto.timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return { valid: false, reason: 'invalid secret' };
  }

  return { valid: true, credential };
}

// ── Store ───────────────────────────────────────────────────────────

/**
 * Resolve the credential store file path from the project directory.
 */
export function resolveCredentialStorePath(projectDir: string): string {
  return path.join(projectDir, CREDENTIAL_STORE_FILE);
}

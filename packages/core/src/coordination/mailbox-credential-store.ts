/**
 * Mailbox credential lifecycle and storage.
 *
 * GM-P0.6: Implements opaque per-principal credential issuance, rotation,
 * revocation, verification, and audit. Credentials are stored as keyed
 * hashes so a store leak does not expose reusable tokens.
 *
 * @module mailbox-credential-store
 */

import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../utils/atomic-write.js';
import type { MailboxCapability } from './mailbox-types.js';
import { LINE_SEPARATOR } from './mailbox-constants.js';

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
  agent: 7 * 24 * 60 * 60 * 1000,    // 7 days
  operator: 24 * 60 * 60 * 1000,      // 24 hours
  service: 30 * 24 * 60 * 60 * 1000,  // 30 days
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
  if (new Date(credential.expiresAt).getTime() < now) {
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
    return { valid: false, reason: 'invalid secret', credential };
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

/**
 * In-memory credential store backed by a JSON file.
 *
 * Uses atomic writes + file locking (same pattern as mailbox registries).
 */
export class JsonlCredentialStore {
  private readonly filePath: string;
  private credentials: Map<string, MailboxCredential> = new Map();
  private _loaded = false;

  constructor(projectDir: string) {
    this.filePath = resolveCredentialStorePath(projectDir);
  }

  get storePath(): string {
    return this.filePath;
  }

  /**
   * Load credentials from the store file.
   */
  async load(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const lines = raw.split(LINE_SEPARATOR).filter((l) => l.trim().length > 0);
      this.credentials = new Map();
      for (const line of lines) {
        try {
          const cred = JSON.parse(line) as MailboxCredential;
          this.credentials.set(cred.credentialId, cred);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File doesn't exist yet
    }
    this._loaded = true;
  }

  /** Save the current state to disk atomically. */
  private async _persist(): Promise<void> {
    const lines = Array.from(this.credentials.values())
      .map((c) => JSON.stringify(c))
      .join(LINE_SEPARATOR);
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await atomicWrite(this.filePath, lines + LINE_SEPARATOR);
  }

  /**
   * Issue a new credential.
   * Returns the credential object with the raw secret (one-time exposure).
   */
  async issue(opts: IssueCredentialOptions): Promise<{ credential: MailboxCredential; secret: string }> {
    await this._ensureLoaded();

    const now = Date.now();
    const { credential, secret } = createMailboxCredential(opts, now);
    const credentialId = credential.credentialId;

    // Keep the superseded credential valid only for the documented overlap.
    if (opts.supersedes) {
      const old = this.credentials.get(opts.supersedes);
      if (old && old.status === 'active') {
        old.status = 'rotated_out';
        old.statusChangedAt = new Date(now).toISOString();
        old.statusReason = 'superseded by rotation';
        old.rotationValidUntil = new Date(now + ROTATION_OVERLAP_MS).toISOString();
      }
    }

    this.credentials.set(credentialId, credential);
    await this._persist();

    return { credential, secret };
  }

  /**
   * Verify a credential's secret against the stored verifier.
   */
  verify(credentialId: string, secret: string): CredentialValidation {
    if (!this._loaded) {
      return { valid: false, reason: 'store not loaded' };
    }

    return verifyMailboxCredential(this.credentials.get(credentialId), secret);
  }

  /** Verify against a fresh persisted snapshot without mutating this store's cache. */
  async verifyPersisted(credentialId: string, secret: string): Promise<CredentialValidation> {
    const snapshot = new JsonlCredentialStore(path.dirname(this.filePath));
    await snapshot.load();
    return snapshot.verify(credentialId, secret);
  }

  /**
   * Revoke a credential by ID.
   */
  async revoke(credentialId: string, reason?: string, by?: string): Promise<boolean> {
    await this._ensureLoaded();

    const credential = this.credentials.get(credentialId);
    if (!credential || credential.status === 'revoked') return false;

    credential.status = 'revoked';
    credential.statusChangedAt = new Date().toISOString();
    credential.statusReason = reason ?? 'revoked';
    credential.lastModifiedBy = by;
    await this._persist();
    return true;
  }

  /**
   * Rotate a credential: issue a new one with a rotation overlap window,
   * revoking the old one after the overlap expires (not immediately).
   */
  async rotate(
    credentialId: string,
    opts?: Partial<IssueCredentialOptions>,
  ): Promise<{ credential: MailboxCredential; secret: string } | null> {
    await this._ensureLoaded();

    const old = this.credentials.get(credentialId);
    if (!old) return null;

    return this.issue({
      principalId: old.principalId,
      projectId: old.projectId ?? opts?.projectId,
      kind: old.kind,
      capabilities: opts?.capabilities ?? old.capabilities,
      ttlMs: opts?.ttlMs ?? MAX_CREDENTIAL_TTL[old.kind],
      supersedes: credentialId,
      issuedBy: opts?.issuedBy,
    });
  }

  /** Get a credential (without exposing the secret). */
  get(credentialId: string): MailboxCredential | null {
    if (!this._loaded) return null;
    return this.credentials.get(credentialId) ?? null;
  }

  /** List all credentials (active first). */
  list(): MailboxCredential[] {
    if (!this._loaded) return [];
    return Array.from(this.credentials.values())
      .sort((a, b) => {
        if (a.status === 'active' && b.status !== 'active') return -1;
        if (a.status !== 'active' && b.status === 'active') return 1;
        return b.issuedAt.localeCompare(a.issuedAt);
      });
  }

  /** Count credentials by status. */
  statusCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const c of this.credentials.values()) {
      counts[c.status] = (counts[c.status] || 0) + 1;
    }
    return counts;
  }

  private async _ensureLoaded(): Promise<void> {
    if (!this._loaded) await this.load();
  }
}

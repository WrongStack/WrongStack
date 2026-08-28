import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  GOVERNANCE_SERVICE_CAPABILITIES,
  type GovernanceServiceCapability,
  type GovernanceServiceClientContext,
} from './service-protocol.js';

export const DEFAULT_GOVERNANCE_GRANT_MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_GOVERNANCE_MAX_GRANTS = 10_000;

type GovernanceCapabilityGrantStatus = 'active' | 'expired' | 'revoked';

export interface GovernanceCapabilityGrant {
  readonly grantId: string;
  readonly projectId: string;
  readonly clientId: string;
  readonly issuedBy: string;
  readonly capabilities: readonly GovernanceServiceCapability[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly status: GovernanceCapabilityGrantStatus;
  readonly revokedAt?: string | undefined;
  readonly revokedBy?: string | undefined;
  readonly revocationReason?: string | undefined;
}

export interface IssuedGovernanceCapabilityGrant {
  readonly token: string;
  readonly grant: GovernanceCapabilityGrant;
}

export interface IssueGovernanceCapabilityGrantOptions {
  readonly clientId: string;
  readonly issuedBy?: string | undefined;
  readonly capabilities: readonly GovernanceServiceCapability[];
  readonly ttlMs: number;
}

interface RotateGovernanceCapabilityGrantOptions {
  readonly rotatedBy?: string | undefined;
  readonly ttlMs: number;
  readonly reason?: string | undefined;
}

export interface GovernanceServiceCredential {
  readonly token: string;
  readonly projectId: string;
  readonly clientId: string;
}

type GovernanceCapabilityAuthenticationFailureCode =
  | 'invalid_token'
  | 'project_mismatch'
  | 'client_mismatch'
  | 'grant_expired'
  | 'grant_revoked';

type GovernanceCapabilityAuthenticationResult =
  | {
      readonly authenticated: true;
      readonly grant: GovernanceCapabilityGrant;
      readonly client: GovernanceServiceClientContext;
    }
  | {
      readonly authenticated: false;
      readonly code: GovernanceCapabilityAuthenticationFailureCode;
      readonly message: string;
    };

export type GovernanceGrantAuditEvent =
  | {
      readonly sequence: number;
      readonly type: 'grant_issued';
      readonly grantId: string;
      readonly projectId: string;
      readonly clientId: string;
      readonly issuedBy: string;
      readonly capabilities: readonly GovernanceServiceCapability[];
      readonly occurredAt: string;
      readonly expiresAt: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'grant_revoked';
      readonly grantId: string;
      readonly projectId: string;
      readonly clientId: string;
      readonly revokedBy: string;
      readonly occurredAt: string;
      readonly reason: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'grant_expired';
      readonly grantId: string;
      readonly projectId: string;
      readonly clientId: string;
      readonly occurredAt: string;
      readonly reason: string;
    }
  | {
      readonly sequence: number;
      readonly type: 'grant_rotated';
      readonly grantId: string;
      readonly previousGrantId: string;
      readonly projectId: string;
      readonly clientId: string;
      readonly rotatedBy: string;
      readonly capabilities: readonly GovernanceServiceCapability[];
      readonly occurredAt: string;
      readonly expiresAt: string;
      readonly reason: string;
    };

type WithoutSequence<T> = T extends unknown ? Omit<T, 'sequence'> : never;
type GovernanceGrantAuditEventInput = WithoutSequence<GovernanceGrantAuditEvent>;

export interface GovernanceCapabilityGrantRegistryOptions {
  readonly now?: (() => number) | undefined;
  readonly maxTtlMs?: number | undefined;
  readonly maxGrants?: number | undefined;
  readonly tokenMaterial?:
    | (() => { readonly grantId: string; readonly secret: string })
    | undefined;
  readonly auditSink?: ((event: GovernanceGrantAuditEvent) => void) | undefined;
}

interface GrantRecord {
  readonly grantId: string;
  readonly verifier: Buffer;
  readonly projectId: string;
  readonly clientId: string;
  readonly issuedBy: string;
  readonly capabilities: readonly GovernanceServiceCapability[];
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  revokedAtMs?: number | undefined;
  revokedBy?: string | undefined;
  revocationReason?: string | undefined;
}

class ImmutableCapabilitySet implements ReadonlySet<GovernanceServiceCapability> {
  readonly #values: Set<GovernanceServiceCapability>;

  constructor(values: readonly GovernanceServiceCapability[]) {
    this.#values = new Set(values);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: GovernanceServiceCapability): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[GovernanceServiceCapability, GovernanceServiceCapability]> {
    return this.#values.entries();
  }

  keys(): SetIterator<GovernanceServiceCapability> {
    return this.#values.keys();
  }

  values(): SetIterator<GovernanceServiceCapability> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (
      value: GovernanceServiceCapability,
      value2: GovernanceServiceCapability,
      set: ReadonlySet<GovernanceServiceCapability>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }

  [Symbol.iterator](): SetIterator<GovernanceServiceCapability> {
    return this.#values[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return 'ImmutableCapabilitySet';
  }
}

function nonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must not be empty.`);
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function defaultTokenMaterial(): { readonly grantId: string; readonly secret: string } {
  return { grantId: randomUUID(), secret: randomBytes(32).toString('base64url') };
}

export class GovernanceCapabilityGrantRegistry {
  readonly projectId: string;

  private readonly records = new Map<string, GrantRecord>();
  private readonly now: () => number;
  private readonly maxTtlMs: number;
  private readonly maxGrants: number;
  private readonly tokenMaterial: () => { readonly grantId: string; readonly secret: string };
  private readonly auditSink: ((event: GovernanceGrantAuditEvent) => void) | undefined;
  private auditSequence = 0;

  constructor(projectId: string, options: GovernanceCapabilityGrantRegistryOptions = {}) {
    nonEmpty(projectId, 'projectId');
    this.projectId = projectId;
    this.now = options.now ?? Date.now;
    this.maxTtlMs = options.maxTtlMs ?? DEFAULT_GOVERNANCE_GRANT_MAX_TTL_MS;
    this.maxGrants = options.maxGrants ?? DEFAULT_GOVERNANCE_MAX_GRANTS;
    this.tokenMaterial = options.tokenMaterial ?? defaultTokenMaterial;
    this.auditSink = options.auditSink;
    if (!Number.isSafeInteger(this.maxTtlMs) || this.maxTtlMs <= 0) {
      throw new Error('maxTtlMs must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(this.maxGrants) || this.maxGrants <= 0) {
      throw new Error('maxGrants must be a positive safe integer.');
    }
  }

  issue(options: IssueGovernanceCapabilityGrantOptions): IssuedGovernanceCapabilityGrant {
    nonEmpty(options.clientId, 'clientId');
    const issuedBy = options.issuedBy ?? 'trusted-server';
    nonEmpty(issuedBy, 'issuedBy');
    if (issuedBy.length > 512) throw new Error('issuedBy must contain at most 512 characters.');
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('ttlMs must be a positive safe integer.');
    }
    if (options.ttlMs > this.maxTtlMs) {
      throw new Error(`ttlMs exceeds the configured maximum of ${this.maxTtlMs}.`);
    }
    const requested = new Set(options.capabilities);
    const capabilities = Object.freeze(
      GOVERNANCE_SERVICE_CAPABILITIES.filter((capability) => requested.has(capability)),
    );
    if (capabilities.length !== requested.size || capabilities.length === 0) {
      throw new Error('At least one known governance capability is required.');
    }
    this.pruneInactive();
    if (this.records.size >= this.maxGrants) {
      throw new Error(`Governance capability grant capacity ${this.maxGrants} has been reached.`);
    }

    const material = this.tokenMaterial();
    nonEmpty(material.grantId, 'grantId');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(material.grantId)) {
      throw new Error('grantId must be a token-safe identifier of at most 128 characters.');
    }
    if (material.secret.length < 32 || material.secret.length > 512) {
      throw new Error('Grant secrets must contain between 32 and 512 characters.');
    }
    if (this.records.has(material.grantId))
      throw new Error(`Grant id ${material.grantId} already exists.`);

    const issuedAtMs = this.now();
    const expiresAtMs = issuedAtMs + options.ttlMs;
    if (
      !Number.isSafeInteger(issuedAtMs) ||
      issuedAtMs < 0 ||
      !Number.isSafeInteger(expiresAtMs) ||
      !Number.isFinite(new Date(expiresAtMs).getTime())
    ) {
      throw new Error('The grant clock returned an invalid value.');
    }
    const record: GrantRecord = {
      grantId: material.grantId,
      verifier: hashSecret(material.secret),
      projectId: this.projectId,
      clientId: options.clientId,
      issuedBy,
      capabilities,
      issuedAtMs,
      expiresAtMs,
    };
    const grant = this.describe(record, issuedAtMs);
    this.appendAudit({
      type: 'grant_issued',
      grantId: grant.grantId,
      projectId: grant.projectId,
      clientId: grant.clientId,
      issuedBy: grant.issuedBy,
      capabilities: grant.capabilities,
      occurredAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    });
    this.records.set(record.grantId, record);
    return Object.freeze({ token: `wsg_${record.grantId}.${material.secret}`, grant });
  }

  rotate(
    grantId: string,
    options: RotateGovernanceCapabilityGrantOptions,
  ): IssuedGovernanceCapabilityGrant {
    nonEmpty(grantId, 'grantId');
    const current = this.records.get(grantId);
    const rotatedBy = options.rotatedBy ?? 'trusted-server';
    const reason = options.reason ?? 'credential rotated';
    nonEmpty(rotatedBy, 'rotatedBy');
    nonEmpty(reason, 'reason');
    if (rotatedBy.length > 512) throw new Error('rotatedBy must contain at most 512 characters.');
    if (reason.length > 512) throw new Error('reason must contain at most 512 characters.');
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('ttlMs must be a positive safe integer.');
    }
    if (options.ttlMs > this.maxTtlMs) {
      throw new Error(`ttlMs exceeds the configured maximum of ${this.maxTtlMs}.`);
    }
    const issuedAtMs = this.now();
    if (!current || current.revokedAtMs !== undefined || current.expiresAtMs <= issuedAtMs) {
      throw new Error('Only an active governance capability grant can be rotated.');
    }

    const material = this.tokenMaterial();
    nonEmpty(material.grantId, 'grantId');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(material.grantId)) {
      throw new Error('grantId must be a token-safe identifier of at most 128 characters.');
    }
    if (material.secret.length < 32 || material.secret.length > 512) {
      throw new Error('Grant secrets must contain between 32 and 512 characters.');
    }
    if (this.records.has(material.grantId)) {
      throw new Error(`Grant id ${material.grantId} already exists.`);
    }
    const expiresAtMs = issuedAtMs + options.ttlMs;
    if (
      !Number.isSafeInteger(issuedAtMs) ||
      issuedAtMs < 0 ||
      !Number.isSafeInteger(expiresAtMs) ||
      !Number.isFinite(new Date(expiresAtMs).getTime())
    ) {
      throw new Error('The grant clock returned an invalid value.');
    }
    const replacement: GrantRecord = {
      grantId: material.grantId,
      verifier: hashSecret(material.secret),
      projectId: current.projectId,
      clientId: current.clientId,
      issuedBy: rotatedBy,
      capabilities: current.capabilities,
      issuedAtMs,
      expiresAtMs,
    };
    const grant = this.describe(replacement, issuedAtMs);
    // Emit grant_rotated before grant_revoked so that if the audit sink rejects
    // the rotation event, no phantom revocation is persisted for a grant that
    // stays active. A failed grant_revoked after a successful grant_rotated is
    // recoverable (the old grant remains authenticating); the reverse is not.
    this.appendAudit({
      type: 'grant_rotated',
      grantId: replacement.grantId,
      previousGrantId: current.grantId,
      projectId: current.projectId,
      clientId: current.clientId,
      rotatedBy,
      capabilities: current.capabilities,
      occurredAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      reason,
    });
    this.appendAudit({
      type: 'grant_revoked',
      grantId: current.grantId,
      projectId: current.projectId,
      clientId: current.clientId,
      revokedBy: rotatedBy,
      occurredAt: new Date(issuedAtMs).toISOString(),
      reason,
    });
    current.revokedAtMs = issuedAtMs;
    current.revokedBy = rotatedBy;
    current.revocationReason = reason;
    this.records.delete(current.grantId);
    this.records.set(replacement.grantId, replacement);
    return Object.freeze({ token: `wsg_${replacement.grantId}.${material.secret}`, grant });
  }

  authenticate(credential: GovernanceServiceCredential): GovernanceCapabilityAuthenticationResult {
    const parsed = this.parseToken(credential.token);
    if (!parsed) return this.reject('invalid_token', 'The capability token is invalid.');
    const record = this.records.get(parsed.grantId);
    if (!record) return this.reject('invalid_token', 'The capability token is invalid.');
    const actual = hashSecret(parsed.secret);
    if (actual.length !== record.verifier.length || !timingSafeEqual(actual, record.verifier)) {
      return this.reject('invalid_token', 'The capability token is invalid.');
    }
    if (credential.projectId !== this.projectId || record.projectId !== credential.projectId) {
      return this.reject('project_mismatch', 'The capability grant belongs to another project.');
    }
    if (record.clientId !== credential.clientId) {
      return this.reject('client_mismatch', 'The capability grant belongs to another client.');
    }
    if (record.revokedAtMs !== undefined) {
      return this.reject('grant_revoked', 'The capability grant has been revoked.');
    }
    const now = this.now();
    if (record.expiresAtMs <= now) {
      return this.reject('grant_expired', 'The capability grant has expired.');
    }
    return {
      authenticated: true,
      grant: this.describe(record, now),
      client: Object.freeze({
        clientId: record.clientId,
        capabilities: new ImmutableCapabilitySet(record.capabilities),
      }),
    };
  }

  revoke(grantId: string, reason = 'revoked by policy', revokedBy = 'trusted-server'): boolean {
    const record = this.records.get(grantId);
    if (!record || record.revokedAtMs !== undefined) return false;
    nonEmpty(reason, 'reason');
    if (reason.length > 512) throw new Error('reason must contain at most 512 characters.');
    nonEmpty(revokedBy, 'revokedBy');
    if (revokedBy.length > 512) throw new Error('revokedBy must contain at most 512 characters.');
    const revokedAtMs = this.now();
    this.appendAudit({
      type: 'grant_revoked',
      grantId: record.grantId,
      projectId: record.projectId,
      clientId: record.clientId,
      revokedBy,
      occurredAt: new Date(revokedAtMs).toISOString(),
      reason,
    });
    record.revokedAtMs = revokedAtMs;
    record.revokedBy = revokedBy;
    record.revocationReason = reason;
    return true;
  }

  sweepExpired(reason = 'expired by grant clock'): number {
    const now = this.now();
    let removed = 0;
    for (const [grantId, record] of this.records) {
      if (record.revokedAtMs !== undefined || record.expiresAtMs > now) continue;
      this.appendAudit({
        type: 'grant_expired',
        grantId: record.grantId,
        projectId: record.projectId,
        clientId: record.clientId,
        occurredAt: new Date(now).toISOString(),
        reason,
      });
      this.records.delete(grantId);
      removed += 1;
    }
    return removed;
  }

  getGrant(grantId: string): GovernanceCapabilityGrant | null {
    const record = this.records.get(grantId);
    return record ? this.describe(record, this.now()) : null;
  }

  remainingTtlMs(grantId: string): number | null {
    const record = this.records.get(grantId);
    if (!record || record.revokedAtMs !== undefined) return null;
    const remaining = record.expiresAtMs - this.now();
    return remaining > 0 ? remaining : null;
  }

  /**
   * Ordering is deliberately byte-wise rather than locale-aware. Both keys are
   * ASCII by construction — `issuedAt` is an ISO-8601 timestamp and `grantId`
   * matches `^[A-Za-z0-9_-]{1,128}$` — so the two orders are identical, but
   * `localeCompare` would make the order depend on the host's default locale.
   * This list backs the `list_capability_grants` cursor, and a cursor is only
   * sound while the order it walks is stable across the requests that walk it.
   */
  listGrants(): readonly GovernanceCapabilityGrant[] {
    const now = this.now();
    return Object.freeze(
      [...this.records.values()]
        .map((record) => this.describe(record, now))
        .sort((left, right) => {
          if (left.issuedAt !== right.issuedAt) return left.issuedAt < right.issuedAt ? -1 : 1;
          if (left.grantId === right.grantId) return 0;
          return left.grantId < right.grantId ? -1 : 1;
        }),
    );
  }

  private parseToken(token: string): { readonly grantId: string; readonly secret: string } | null {
    if (typeof token !== 'string' || token.length > 700 || !token.startsWith('wsg_')) return null;
    const separator = token.indexOf('.', 4);
    if (separator <= 4 || separator === token.length - 1) return null;
    return { grantId: token.slice(4, separator), secret: token.slice(separator + 1) };
  }

  private describe(record: GrantRecord, now: number): GovernanceCapabilityGrant {
    const status: GovernanceCapabilityGrantStatus =
      record.revokedAtMs !== undefined
        ? 'revoked'
        : record.expiresAtMs <= now
          ? 'expired'
          : 'active';
    return Object.freeze({
      grantId: record.grantId,
      projectId: record.projectId,
      clientId: record.clientId,
      issuedBy: record.issuedBy,
      capabilities: record.capabilities,
      issuedAt: new Date(record.issuedAtMs).toISOString(),
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      status,
      ...(record.revokedAtMs !== undefined
        ? { revokedAt: new Date(record.revokedAtMs).toISOString() }
        : {}),
      ...(record.revokedBy ? { revokedBy: record.revokedBy } : {}),
      ...(record.revocationReason ? { revocationReason: record.revocationReason } : {}),
    });
  }

  private reject(
    code: GovernanceCapabilityAuthenticationFailureCode,
    message: string,
  ): GovernanceCapabilityAuthenticationResult {
    return { authenticated: false, code, message };
  }

  private appendAudit(event: GovernanceGrantAuditEventInput): void {
    const sequence = this.auditSequence + 1;
    const stored = Object.freeze({ ...event, sequence }) as GovernanceGrantAuditEvent;
    this.auditSink?.(stored);
    this.auditSequence = sequence;
  }

  private pruneInactive(): void {
    this.sweepExpired();
    for (const [grantId, record] of this.records) {
      if (record.revokedAtMs !== undefined) this.records.delete(grantId);
    }
  }
}

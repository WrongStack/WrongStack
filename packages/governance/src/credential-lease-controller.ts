import { randomUUID } from 'node:crypto';

import type { GovernanceCapabilityGrant, GovernanceServiceCredential } from './capability-grant.js';
import { DEFAULT_GOVERNANCE_GRANT_MAX_TTL_MS } from './capability-grant.js';
import { GOVERNANCE_MANAGEMENT_RECEIPT_TTL_MS } from './management-receipt-cache.js';
import { GOVERNANCE_IPC_DEFAULT_TIMEOUT_MS, GovernanceProjectClient } from './project-client.js';
import type { GovernanceServiceResponse } from './project-service.js';
import { sanitizeGovernanceMessage } from './sanitize.js';
import { GOVERNANCE_SERVICE_PROTOCOL_VERSION } from './service-protocol.js';

const GOVERNANCE_CREDENTIAL_LEASE_DEFAULT_TTL_MS = 60 * 60 * 1_000;
const GOVERNANCE_CREDENTIAL_LEASE_DEFAULT_RENEW_BEFORE_MS = 5 * 60 * 1_000;
const GOVERNANCE_CREDENTIAL_LEASE_DEFAULT_RETRY_MS = 1_000;
const GOVERNANCE_CREDENTIAL_LEASE_DEFAULT_MAX_ATTEMPTS = 3;

type GovernanceCredentialLeaseState =
  | 'idle'
  | 'scheduled'
  | 'rotating'
  | 'retry_wait'
  | 'stopped'
  | 'expired';

type GovernanceCredentialLeaseStopReason =
  | 'stopped_by_owner'
  | 'retry_exhausted'
  | 'credential_expired';

export interface GovernanceCredentialLeaseSnapshot {
  readonly state: GovernanceCredentialLeaseState;
  readonly projectId: string;
  readonly clientId: string;
  readonly grantId: string;
  readonly expiresAt: string;
  readonly rotationAttempt: number;
  readonly nextActionAt?: string | undefined;
  readonly stopReason?: GovernanceCredentialLeaseStopReason | undefined;
  readonly lastFailure?: string | undefined;
}

export interface GovernanceCredentialLeaseScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

interface GovernanceCredentialLeaseClient {
  request(input: unknown): Promise<GovernanceServiceResponse>;
}

interface GovernanceCredentialLeaseControllerOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly grantId: string;
  readonly expiresAt: string;
  readonly credential: GovernanceServiceCredential;
  readonly rotationTtlMs?: number | undefined;
  readonly renewBeforeMs?: number | undefined;
  readonly retryDelayMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly scheduler?: GovernanceCredentialLeaseScheduler | undefined;
  readonly requestIdFactory?: (() => string) | undefined;
  readonly clientFactory?:
    | ((credential: GovernanceServiceCredential) => GovernanceCredentialLeaseClient)
    | undefined;
}

const defaultScheduler: GovernanceCredentialLeaseScheduler = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    // A renewal is pending for most of the credential's lifetime — with the
    // default 60 min TTL and 5 min renew window, ~55 min of it. A referenced
    // timer would make that the reason the process cannot exit, so a host that
    // finished its work would hang until the renewal fired. Renewing a lease is
    // never a reason to keep a process alive; the sibling attachment-broker
    // scheduler already takes the same position.
    handle.unref();
    return handle;
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function validTimestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid timestamp.`);
  return parsed;
}

function tokenSafe(value: string, name: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${name} must be a token-safe identifier of at most 128 characters.`);
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim())
    return sanitizeGovernanceMessage(error.message);
  return 'Governance credential rotation failed.';
}

function validRotationResult(
  response: GovernanceServiceResponse,
  projectId: string,
  clientId: string,
  previousGrantId: string,
  now: number,
):
  | {
      readonly valid: true;
      readonly grant: GovernanceCapabilityGrant;
      readonly credential: GovernanceServiceCredential;
      readonly expiresAtMs: number;
    }
  | { readonly valid: false; readonly message: string } {
  if (!response.ok)
    return { valid: false, message: sanitizeGovernanceMessage(response.error.message) };
  if (response.result.type !== 'capability_grant_rotated') {
    return { valid: false, message: 'Credential rotation returned an unexpected response type.' };
  }
  const { grant, credential } = response.result;
  const expiresAtMs = Date.parse(grant.expiresAt);
  if (
    response.result.previousGrantId !== previousGrantId ||
    grant.projectId !== projectId ||
    grant.clientId !== clientId ||
    grant.status !== 'active' ||
    !grant.capabilities.includes('capability_admin') ||
    credential.projectId !== projectId ||
    credential.clientId !== clientId ||
    !credential.token.startsWith(`wsg_${grant.grantId}.`) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= now
  ) {
    return { valid: false, message: 'Credential rotation identity validation failed.' };
  }
  return { valid: true, grant, credential, expiresAtMs };
}

/**
 * Opt-in process-local holder for one self-rotating capability_admin credential.
 * It never persists or exposes the current bearer token.
 */
export class GovernanceCredentialLeaseController implements GovernanceCredentialLeaseClient {
  private readonly projectRoot: string;
  private readonly projectId: string;
  private readonly clientId: string;
  private readonly rotationTtlMs: number;
  private readonly renewBeforeMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly scheduler: GovernanceCredentialLeaseScheduler;
  private readonly requestIdFactory: () => string;
  private readonly clientFactory: (
    credential: GovernanceServiceCredential,
  ) => GovernanceCredentialLeaseClient;

  private client: GovernanceCredentialLeaseClient;
  private credential: GovernanceServiceCredential;
  private grantId: string;
  private expiresAtMs: number;
  private state: GovernanceCredentialLeaseState = 'idle';
  private rotationAttempt = 0;
  private cycleRequestId: string | undefined;
  private timer: unknown;
  private nextActionAtMs: number | undefined;
  private stopReason: GovernanceCredentialLeaseStopReason | undefined;
  private lastFailure: string | undefined;
  private stopped = false;
  private inFlight: Promise<GovernanceCredentialLeaseSnapshot> | undefined;

  constructor(options: GovernanceCredentialLeaseControllerOptions) {
    this.projectRoot = options.projectRoot;
    this.projectId = options.projectId;
    this.clientId = options.credential.clientId;
    this.grantId = options.grantId;
    this.expiresAtMs = validTimestamp(options.expiresAt, 'expiresAt');
    this.credential = Object.freeze({ ...options.credential });
    this.rotationTtlMs = options.rotationTtlMs ?? GOVERNANCE_CREDENTIAL_LEASE_DEFAULT_TTL_MS;
    this.renewBeforeMs =
      options.renewBeforeMs ?? GOVERNANCE_CREDENTIAL_LEASE_DEFAULT_RENEW_BEFORE_MS;
    this.retryDelayMs = options.retryDelayMs ?? GOVERNANCE_CREDENTIAL_LEASE_DEFAULT_RETRY_MS;
    this.maxAttempts = options.maxAttempts ?? GOVERNANCE_CREDENTIAL_LEASE_DEFAULT_MAX_ATTEMPTS;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.requestIdFactory = options.requestIdFactory ?? (() => `lease-rotate-${randomUUID()}`);
    tokenSafe(this.grantId, 'grantId');
    if (this.credential.projectId !== this.projectId) {
      throw new Error('Governance credential lease project identity does not match.');
    }
    positiveSafeInteger(this.rotationTtlMs, 'rotationTtlMs');
    positiveSafeInteger(this.renewBeforeMs, 'renewBeforeMs');
    positiveSafeInteger(this.retryDelayMs, 'retryDelayMs');
    positiveSafeInteger(this.maxAttempts, 'maxAttempts');
    if (this.rotationTtlMs > DEFAULT_GOVERNANCE_GRANT_MAX_TTL_MS) {
      throw new Error('rotationTtlMs exceeds the governance grant maximum.');
    }
    if (this.renewBeforeMs >= this.rotationTtlMs) {
      throw new Error('renewBeforeMs must be less than rotationTtlMs.');
    }
    const timeoutMs = options.requestTimeoutMs ?? GOVERNANCE_IPC_DEFAULT_TIMEOUT_MS;
    positiveSafeInteger(timeoutMs, 'requestTimeoutMs');
    const replayWindowMs = (this.maxAttempts - 1) * (timeoutMs + this.retryDelayMs);
    if (
      !Number.isSafeInteger(replayWindowMs) ||
      replayWindowMs >= GOVERNANCE_MANAGEMENT_RECEIPT_TTL_MS
    ) {
      throw new Error('Credential lease retry window must fit within the management receipt TTL.');
    }
    this.clientFactory =
      options.clientFactory ??
      ((credential) =>
        new GovernanceProjectClient(this.projectRoot, credential, {
          timeoutMs,
        }));
    this.client = this.clientFactory(this.credential);
  }

  start(): GovernanceCredentialLeaseSnapshot {
    if (this.stopped || this.state !== 'idle') return this.snapshot();
    this.scheduleRenewal();
    return this.snapshot();
  }

  stop(): GovernanceCredentialLeaseSnapshot {
    this.stopped = true;
    this.clearTimer();
    this.state = 'stopped';
    this.stopReason = 'stopped_by_owner';
    this.nextActionAtMs = undefined;
    return this.snapshot();
  }

  async request(input: unknown): Promise<GovernanceServiceResponse> {
    if (this.inFlight) await this.inFlight;
    return this.client.request(input);
  }

  rotateNow(): Promise<GovernanceCredentialLeaseSnapshot> {
    if (this.stopped || this.state === 'expired') return Promise.resolve(this.snapshot());
    if (this.inFlight) return this.inFlight;
    this.clearTimer();
    const operation = this.rotateOnce().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = operation;
    return operation;
  }

  snapshot(): GovernanceCredentialLeaseSnapshot {
    return Object.freeze({
      state: this.state,
      projectId: this.projectId,
      clientId: this.clientId,
      grantId: this.grantId,
      expiresAt: new Date(this.expiresAtMs).toISOString(),
      rotationAttempt: this.rotationAttempt,
      ...(this.nextActionAtMs === undefined
        ? {}
        : { nextActionAt: new Date(this.nextActionAtMs).toISOString() }),
      ...(this.stopReason ? { stopReason: this.stopReason } : {}),
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
    });
  }

  private async rotateOnce(): Promise<GovernanceCredentialLeaseSnapshot> {
    const now = this.now();
    if (now >= this.expiresAtMs) {
      this.expire();
      return this.snapshot();
    }
    this.state = 'rotating';
    this.rotationAttempt += 1;
    if (!this.cycleRequestId) {
      const requestId = this.requestIdFactory();
      tokenSafe(requestId, 'rotation requestId');
      this.cycleRequestId = requestId;
    }
    try {
      const response = await this.client.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: this.cycleRequestId,
        type: 'rotate_capability_grant',
        grantId: this.grantId,
        ttlMs: this.rotationTtlMs,
        reason: 'automatic credential lease renewal',
      });
      const validated = validRotationResult(
        response,
        this.projectId,
        this.clientId,
        this.grantId,
        this.now(),
      );
      if (!validated.valid) return this.handleFailure(validated.message);
      this.credential = Object.freeze({ ...validated.credential });
      this.grantId = validated.grant.grantId;
      this.expiresAtMs = validated.expiresAtMs;
      this.client = this.clientFactory(this.credential);
      this.rotationAttempt = 0;
      this.cycleRequestId = undefined;
      this.lastFailure = undefined;
      if (this.stopped) {
        this.state = 'stopped';
        return this.snapshot();
      }
      this.scheduleRenewal();
      return this.snapshot();
    } catch (error) {
      return this.handleFailure(failureMessage(error));
    }
  }

  private handleFailure(message: string): GovernanceCredentialLeaseSnapshot {
    this.lastFailure = message;
    if (this.stopped) {
      this.state = 'stopped';
      return this.snapshot();
    }
    const now = this.now();
    if (now >= this.expiresAtMs) {
      this.expire();
      return this.snapshot();
    }
    if (this.rotationAttempt >= this.maxAttempts) {
      this.stopped = true;
      this.state = 'stopped';
      this.stopReason = 'retry_exhausted';
      this.nextActionAtMs = undefined;
      return this.snapshot();
    }
    const remaining = this.expiresAtMs - now;
    const delayMs = Math.min(this.retryDelayMs, remaining);
    if (delayMs <= 0) {
      this.expire();
      return this.snapshot();
    }
    this.state = 'retry_wait';
    this.schedule(delayMs);
    return this.snapshot();
  }

  private scheduleRenewal(): void {
    const now = this.now();
    if (now >= this.expiresAtMs) {
      this.expire();
      return;
    }
    this.state = 'scheduled';
    this.stopReason = undefined;
    const delay = Math.min(2_147_483_647, Math.max(0, this.expiresAtMs - this.renewBeforeMs - now));
    this.schedule(delay);
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.nextActionAtMs = this.now() + delayMs;
    this.timer = this.scheduler.schedule(() => {
      this.timer = undefined;
      this.nextActionAtMs = undefined;
      // `rotateOnce` handles request and validation failures itself, but the
      // work it does before its own try block — the injected `requestIdFactory`
      // and `now` — can still throw, and so can an injected scheduler on the
      // retry path. Without this catch that becomes an unhandled rejection from
      // a timer callback, which takes the whole process down. The failure is
      // already recorded in the snapshot, so there is nothing further to do
      // with it here.
      void this.rotateNow().catch(() => undefined);
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.scheduler.cancel(this.timer);
    this.timer = undefined;
    this.nextActionAtMs = undefined;
  }

  private expire(): void {
    this.clearTimer();
    this.stopped = true;
    this.state = 'expired';
    this.stopReason = 'credential_expired';
    this.nextActionAtMs = undefined;
  }
}

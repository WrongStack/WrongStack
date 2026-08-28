import type {
  GovernanceCapabilityGrant,
  GovernanceServiceCredential,
  IssuedGovernanceCapabilityGrant,
  IssueGovernanceCapabilityGrantOptions,
} from './capability-grant.js';
import {
  createGovernanceDaemonAttachmentBroker,
  GOVERNANCE_DAEMON_ATTACHMENT_BROKER_TTL_MS,
  type GovernanceDaemonAttachmentBrokerRecord,
  type GovernanceDaemonMetadata,
  removeOwnedGovernanceDaemonAttachmentBroker,
  writeGovernanceDaemonAttachmentBroker,
} from './daemon-metadata.js';
import { sanitizeGovernanceMessage } from './sanitize.js';

const GOVERNANCE_DAEMON_ATTACHMENT_BROKER_RENEW_BEFORE_MS = 15 * 60 * 1_000;
const GOVERNANCE_DAEMON_ATTACHMENT_BROKER_RETRY_MS = 5_000;
const GOVERNANCE_DAEMON_ATTACHMENT_BROKER_DEGRADED_FAILURES = 3;

type GovernanceAttachmentBrokerLifecycleEventType =
  | 'published'
  | 'renewal_failed'
  | 'degraded'
  | 'revocation_failed'
  | 'recovered'
  | 'stopped';

export interface GovernanceAttachmentBrokerLifecycleEvent {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly type: GovernanceAttachmentBrokerLifecycleEventType;
  readonly projectId: string;
  readonly instanceId: string;
  readonly occurredAt: string;
  readonly state: GovernanceAttachmentBrokerControllerSnapshot['state'];
  readonly health: GovernanceAttachmentBrokerControllerSnapshot['health'];
  readonly grantId: string | null;
  readonly expiresAt: string | null;
  readonly consecutiveFailures: number;
  readonly pendingRevocations: number;
  readonly message?: string | undefined;
}

export interface GovernanceAttachmentBrokerScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface GovernanceAttachmentBrokerControllerSnapshot {
  readonly state: 'idle' | 'active' | 'retry_wait' | 'stopped';
  readonly health: 'initializing' | 'healthy' | 'degraded' | 'stopped';
  readonly grantId: string | null;
  readonly expiresAt: string | null;
  readonly consecutiveFailures: number;
  readonly pendingRevocations: number;
  readonly auditHealthy: boolean;
  readonly nextActionAt?: string | undefined;
  readonly lastFailure?: string | undefined;
  readonly lastAuditFailure?: string | undefined;
}

interface GovernanceAttachmentBrokerGrantPort {
  issueGrant(options: IssueGovernanceCapabilityGrantOptions): IssuedGovernanceCapabilityGrant;
  revokeGrant(grantId: string, reason?: string): boolean;
}

interface GovernanceAttachmentBrokerControllerOptions {
  readonly projectRoot: string;
  readonly metadata: GovernanceDaemonMetadata;
  readonly grants: GovernanceAttachmentBrokerGrantPort;
  readonly ttlMs?: number | undefined;
  readonly renewBeforeMs?: number | undefined;
  readonly retryMs?: number | undefined;
  readonly degradedFailureThreshold?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly scheduler?: GovernanceAttachmentBrokerScheduler | undefined;
  readonly publish?:
    | ((broker: GovernanceDaemonAttachmentBrokerRecord) => Promise<void>)
    | undefined;
  readonly remove?: (() => Promise<boolean>) | undefined;
  readonly onEvent?: ((event: GovernanceAttachmentBrokerLifecycleEvent) => void) | undefined;
}

function defaultScheduler(): GovernanceAttachmentBrokerScheduler {
  return {
    schedule(callback, delayMs) {
      const handle = setTimeout(callback, delayMs);
      handle.unref();
      return handle;
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeGovernanceMessage(message).slice(0, 512);
}

export class GovernanceAttachmentBrokerController {
  readonly #options: GovernanceAttachmentBrokerControllerOptions;
  readonly #now: () => number;
  readonly #scheduler: GovernanceAttachmentBrokerScheduler;
  readonly #ttlMs: number;
  readonly #renewBeforeMs: number;
  readonly #retryMs: number;
  readonly #degradedFailureThreshold: number;
  readonly #pendingRevocations = new Set<string>();
  readonly #reportedRevocationFailures = new Set<string>();
  #state: GovernanceAttachmentBrokerControllerSnapshot['state'] = 'idle';
  #currentGrant: GovernanceCapabilityGrant | null = null;
  #timer: unknown;
  #nextActionAt: string | undefined;
  #lastFailure: string | undefined;
  #lastAuditFailure: string | undefined;
  #consecutiveFailures = 0;
  #eventSequence = 0;
  #rotationPromise: Promise<GovernanceDaemonAttachmentBrokerRecord> | undefined;
  #started = false;

  constructor(options: GovernanceAttachmentBrokerControllerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#scheduler = options.scheduler ?? defaultScheduler();
    this.#ttlMs = options.ttlMs ?? GOVERNANCE_DAEMON_ATTACHMENT_BROKER_TTL_MS;
    this.#renewBeforeMs =
      options.renewBeforeMs ?? GOVERNANCE_DAEMON_ATTACHMENT_BROKER_RENEW_BEFORE_MS;
    this.#retryMs = options.retryMs ?? GOVERNANCE_DAEMON_ATTACHMENT_BROKER_RETRY_MS;
    this.#degradedFailureThreshold =
      options.degradedFailureThreshold ?? GOVERNANCE_DAEMON_ATTACHMENT_BROKER_DEGRADED_FAILURES;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new Error('Attachment broker ttlMs must be a positive safe integer.');
    }
    if (
      !Number.isSafeInteger(this.#renewBeforeMs) ||
      this.#renewBeforeMs <= 0 ||
      this.#renewBeforeMs >= this.#ttlMs
    ) {
      throw new Error('Attachment broker renewBeforeMs must be positive and less than ttlMs.');
    }
    if (!Number.isSafeInteger(this.#retryMs) || this.#retryMs <= 0) {
      throw new Error('Attachment broker retryMs must be a positive safe integer.');
    }
    if (
      !Number.isSafeInteger(this.#degradedFailureThreshold) ||
      this.#degradedFailureThreshold <= 0
    ) {
      throw new Error('Attachment broker degradedFailureThreshold must be positive.');
    }
  }

  start(): Promise<GovernanceDaemonAttachmentBrokerRecord> {
    if (this.#started || this.#state !== 'idle') {
      return Promise.reject(new Error('Attachment broker controller can only be started once.'));
    }
    this.#started = true;
    return this.rotateNow();
  }

  rotateNow(): Promise<GovernanceDaemonAttachmentBrokerRecord> {
    if (this.#state === 'stopped') {
      return Promise.reject(new Error('Attachment broker controller is stopped.'));
    }
    if (this.#rotationPromise) return this.#rotationPromise;
    this.cancelTimer();
    this.#rotationPromise = this.rotateOnce().finally(() => {
      this.#rotationPromise = undefined;
    });
    return this.#rotationPromise;
  }

  async stop(): Promise<GovernanceAttachmentBrokerControllerSnapshot> {
    if (this.#state === 'stopped') return this.snapshot();
    this.#state = 'stopped';
    this.cancelTimer();
    await this.#rotationPromise?.catch(() => null);
    this.#state = 'stopped';
    this.cancelTimer();
    await this.remove().catch((error) => {
      this.#lastFailure = failureMessage(error);
      return false;
    });
    if (this.#currentGrant) this.#pendingRevocations.add(this.#currentGrant.grantId);
    this.#currentGrant = null;
    this.revokePending('governance attachment broker controller stopped');
    this.emit('stopped');
    return this.snapshot();
  }

  snapshot(): GovernanceAttachmentBrokerControllerSnapshot {
    return Object.freeze({
      state: this.#state,
      health: this.health(),
      grantId: this.#currentGrant?.grantId ?? null,
      expiresAt: this.#currentGrant?.expiresAt ?? null,
      consecutiveFailures: this.#consecutiveFailures,
      pendingRevocations: this.#pendingRevocations.size,
      auditHealthy: this.#lastAuditFailure === undefined,
      ...(this.#nextActionAt ? { nextActionAt: this.#nextActionAt } : {}),
      ...(this.#lastFailure ? { lastFailure: this.#lastFailure } : {}),
      ...(this.#lastAuditFailure ? { lastAuditFailure: this.#lastAuditFailure } : {}),
    });
  }

  private async rotateOnce(): Promise<GovernanceDaemonAttachmentBrokerRecord> {
    this.revokePending('superseded governance attachment broker cleanup');
    const previous = this.#currentGrant;
    const priorFailures = this.#consecutiveFailures;
    let issued: IssuedGovernanceCapabilityGrant | undefined;
    try {
      issued = this.#options.grants.issueGrant({
        clientId: `governance-attachment-broker-${this.#options.metadata.instanceId}`,
        issuedBy: 'governance-daemon-owner',
        capabilities: ['runtime_attach', 'daemon_status_read'],
        ttlMs: this.#ttlMs,
      });
      const expiresAtMs = Date.parse(issued.grant.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.#now()) {
        throw new Error('Attachment broker grant has an invalid expiry.');
      }
      const credential: GovernanceServiceCredential = {
        token: issued.token,
        projectId: this.#options.metadata.projectId,
        clientId: issued.grant.clientId,
      };
      const broker = createGovernanceDaemonAttachmentBroker({
        metadata: this.#options.metadata,
        grantId: issued.grant.grantId,
        expiresAt: issued.grant.expiresAt,
        credential,
      });
      await this.publish(broker);
      const stoppedDuringPublication = this.#state === 'stopped';
      this.#currentGrant = issued.grant;
      this.#state = stoppedDuringPublication ? 'stopped' : 'active';
      this.#lastFailure = undefined;
      this.#consecutiveFailures = 0;
      if (previous) this.#pendingRevocations.add(previous.grantId);
      this.revokePending('superseded governance attachment broker');
      if (!stoppedDuringPublication) {
        this.schedule(Math.max(1, expiresAtMs - this.#now() - this.#renewBeforeMs));
      }
      this.emit(priorFailures > 0 ? 'recovered' : 'published');
      return broker;
    } catch (error) {
      if (issued) {
        this.#pendingRevocations.add(issued.grant.grantId);
        this.revokePending('unpublished governance attachment broker');
      }
      this.#consecutiveFailures += 1;
      this.#lastFailure = failureMessage(error);
      if (this.#consecutiveFailures === 1) this.emit('renewal_failed', this.#lastFailure);
      if (this.#consecutiveFailures === this.#degradedFailureThreshold) {
        this.emit('degraded', this.#lastFailure);
      }
      if (this.#state !== 'stopped' && previous) {
        this.#state = 'retry_wait';
        this.schedule(this.#retryMs);
      }
      throw error;
    }
  }

  private publish(broker: GovernanceDaemonAttachmentBrokerRecord): Promise<void> {
    return this.#options.publish
      ? this.#options.publish(broker)
      : writeGovernanceDaemonAttachmentBroker(this.#options.projectRoot, broker);
  }

  private remove(): Promise<boolean> {
    return this.#options.remove
      ? this.#options.remove()
      : removeOwnedGovernanceDaemonAttachmentBroker(
          this.#options.projectRoot,
          this.#options.metadata,
        );
  }

  private revokePending(reason: string): void {
    const hadReportedFailure = this.#reportedRevocationFailures.size > 0;
    for (const grantId of this.#pendingRevocations) {
      try {
        this.#options.grants.revokeGrant(grantId, reason);
        this.#pendingRevocations.delete(grantId);
        this.#reportedRevocationFailures.delete(grantId);
      } catch (error) {
        this.#lastFailure = failureMessage(error);
        if (!this.#reportedRevocationFailures.has(grantId)) {
          this.#reportedRevocationFailures.add(grantId);
          this.emit('revocation_failed', this.#lastFailure);
        }
      }
    }
    if (
      hadReportedFailure &&
      this.#pendingRevocations.size === 0 &&
      this.#consecutiveFailures === 0
    ) {
      this.#lastFailure = undefined;
      this.emit('recovered');
    }
  }

  private health(): GovernanceAttachmentBrokerControllerSnapshot['health'] {
    if (this.#state === 'stopped') return 'stopped';
    if (
      this.#consecutiveFailures >= this.#degradedFailureThreshold ||
      this.#pendingRevocations.size > 0 ||
      this.#lastAuditFailure !== undefined
    ) {
      return 'degraded';
    }
    return this.#currentGrant ? 'healthy' : 'initializing';
  }

  private emit(type: GovernanceAttachmentBrokerLifecycleEventType, message?: string): void {
    if (!this.#options.onEvent) return;
    this.#lastAuditFailure = undefined;
    this.#eventSequence += 1;
    const event: GovernanceAttachmentBrokerLifecycleEvent = Object.freeze({
      schemaVersion: 1,
      sequence: this.#eventSequence,
      type,
      projectId: this.#options.metadata.projectId,
      instanceId: this.#options.metadata.instanceId,
      occurredAt: new Date(this.#now()).toISOString(),
      state: this.#state,
      health: this.health(),
      grantId: this.#currentGrant?.grantId ?? null,
      expiresAt: this.#currentGrant?.expiresAt ?? null,
      consecutiveFailures: this.#consecutiveFailures,
      pendingRevocations: this.#pendingRevocations.size,
      ...(message ? { message } : {}),
    });
    try {
      this.#options.onEvent(event);
      this.#lastAuditFailure = undefined;
    } catch (error) {
      this.#lastAuditFailure = failureMessage(error);
    }
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    this.#nextActionAt = new Date(this.#now() + delayMs).toISOString();
    this.#timer = this.#scheduler.schedule(() => {
      this.#timer = undefined;
      this.#nextActionAt = undefined;
      void this.rotateNow().catch(() => undefined);
    }, delayMs);
  }

  private cancelTimer(): void {
    if (this.#timer !== undefined) this.#scheduler.cancel(this.#timer);
    this.#timer = undefined;
    this.#nextActionAt = undefined;
  }
}

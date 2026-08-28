import type { GovernanceAttachmentBrokerControllerSnapshot } from './attachment-broker-controller.js';

export interface GovernanceDaemonControlStatus {
  readonly projectId: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly attachmentBroker?: GovernanceAttachmentBrokerControllerSnapshot | undefined;
}

type GovernanceDaemonOperatorSignalLevel = 'healthy' | 'notice' | 'warning';

interface GovernanceDaemonOperatorAttachmentBrokerStatus {
  readonly state: GovernanceAttachmentBrokerControllerSnapshot['state'];
  readonly health: GovernanceAttachmentBrokerControllerSnapshot['health'];
  readonly expiresAt?: string | undefined;
  readonly nextActionAt?: string | undefined;
  readonly consecutiveFailures: number;
  readonly pendingRevocations: number;
  readonly auditHealthy: boolean;
}

export interface GovernanceDaemonOperatorStatus {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly signal: {
    readonly level: GovernanceDaemonOperatorSignalLevel;
    readonly code:
      | 'attachment_broker_healthy'
      | 'attachment_broker_initializing'
      | 'attachment_broker_status_unavailable'
      | 'attachment_broker_degraded'
      | 'attachment_broker_audit_unhealthy'
      | 'attachment_broker_revocation_pending'
      | 'attachment_broker_stopped';
    readonly message: string;
    readonly operatorAction: 'none' | 'observe' | 'investigate';
    readonly executionDisposition: 'continue';
  };
  readonly attachmentBroker: GovernanceDaemonOperatorAttachmentBrokerStatus | null;
}

/**
 * Deterministic, credential-free operator projection. A warning is advisory:
 * task and model execution continue until a separate policy gate says otherwise.
 */
export function projectGovernanceDaemonOperatorStatus(
  status: GovernanceDaemonControlStatus,
): GovernanceDaemonOperatorStatus {
  const broker = status.attachmentBroker;
  let signal: GovernanceDaemonOperatorStatus['signal'];
  if (!broker) {
    signal = {
      level: 'notice',
      code: 'attachment_broker_status_unavailable',
      message: 'Attachment broker health is unavailable from this daemon version.',
      operatorAction: 'observe',
      executionDisposition: 'continue',
    };
  } else if (broker.state === 'stopped' || broker.health === 'stopped') {
    signal = {
      level: 'warning',
      code: 'attachment_broker_stopped',
      message: 'Attachment broker publication is stopped.',
      operatorAction: 'investigate',
      executionDisposition: 'continue',
    };
  } else if (!broker.auditHealthy) {
    signal = {
      level: 'warning',
      code: 'attachment_broker_audit_unhealthy',
      message: 'Attachment broker lifecycle audit persistence is unhealthy.',
      operatorAction: 'investigate',
      executionDisposition: 'continue',
    };
  } else if (broker.pendingRevocations > 0) {
    signal = {
      level: 'warning',
      code: 'attachment_broker_revocation_pending',
      message: 'Attachment broker has credential revocations pending.',
      operatorAction: 'investigate',
      executionDisposition: 'continue',
    };
  } else if (broker.health === 'degraded') {
    signal = {
      level: 'warning',
      code: 'attachment_broker_degraded',
      message: 'Attachment broker renewal health is degraded.',
      operatorAction: 'investigate',
      executionDisposition: 'continue',
    };
  } else if (broker.health === 'initializing') {
    signal = {
      level: 'notice',
      code: 'attachment_broker_initializing',
      message: 'Attachment broker publication is initializing.',
      operatorAction: 'observe',
      executionDisposition: 'continue',
    };
  } else {
    signal = {
      level: 'healthy',
      code: 'attachment_broker_healthy',
      message: 'Attachment broker publication and audit persistence are healthy.',
      operatorAction: 'none',
      executionDisposition: 'continue',
    };
  }
  return Object.freeze({
    schemaVersion: 1,
    projectId: status.projectId,
    pid: status.pid,
    instanceId: status.instanceId,
    startedAt: status.startedAt,
    signal: Object.freeze(signal),
    attachmentBroker: broker
      ? Object.freeze({
          state: broker.state,
          health: broker.health,
          ...(broker.expiresAt ? { expiresAt: broker.expiresAt } : {}),
          ...(broker.nextActionAt ? { nextActionAt: broker.nextActionAt } : {}),
          consecutiveFailures: broker.consecutiveFailures,
          pendingRevocations: broker.pendingRevocations,
          auditHealthy: broker.auditHealthy,
        })
      : null,
  });
}

export interface GovernanceDaemonControlPort {
  status(): GovernanceDaemonControlStatus;
}

export interface GovernanceDaemonShutdownNotice {
  readonly requestId: string;
  readonly expectedInstanceId: string;
  readonly requestedBy: string;
  readonly reason: string;
}

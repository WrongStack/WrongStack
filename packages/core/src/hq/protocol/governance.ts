/**
 * Credential-free, project-scoped governance telemetry published to HQ.
 * This is deliberately observational: HQ cannot use this payload to stop,
 * approve, or otherwise control project execution.
 */

export type HqGovernanceSignalLevel = 'healthy' | 'notice' | 'warning' | 'unavailable';

export type HqGovernanceSignalCode =
  | 'attachment_broker_healthy'
  | 'attachment_broker_initializing'
  | 'attachment_broker_status_unavailable'
  | 'attachment_broker_degraded'
  | 'attachment_broker_audit_unhealthy'
  | 'attachment_broker_revocation_pending'
  | 'attachment_broker_stopped'
  | 'broker_missing'
  | 'broker_invalid'
  | 'connection_failed'
  | 'request_rejected'
  | 'unexpected_response';

export interface HqGovernanceSnapshotPayload {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly observedAt: string;
  readonly available: boolean;
  readonly signal: {
    readonly level: HqGovernanceSignalLevel;
    readonly code: HqGovernanceSignalCode;
    readonly operatorAction: 'none' | 'observe' | 'investigate';
    readonly executionDisposition: 'continue';
  };
  readonly daemon?: {
    readonly pid: number;
    readonly startedAt: string;
  };
  readonly attachmentBroker?: {
    readonly state: 'idle' | 'active' | 'retry_wait' | 'stopped';
    readonly health: 'initializing' | 'healthy' | 'degraded' | 'stopped';
    readonly consecutiveFailures: number;
    readonly pendingRevocations: number;
    readonly auditHealthy: boolean;
    readonly expiresAt?: string;
    readonly nextActionAt?: string;
  } | null;
}

const SIGNAL_LEVELS = new Set<HqGovernanceSignalLevel>([
  'healthy',
  'notice',
  'warning',
  'unavailable',
]);
const SIGNAL_CODES = new Set<HqGovernanceSignalCode>([
  'attachment_broker_healthy',
  'attachment_broker_initializing',
  'attachment_broker_status_unavailable',
  'attachment_broker_degraded',
  'attachment_broker_audit_unhealthy',
  'attachment_broker_revocation_pending',
  'attachment_broker_stopped',
  'broker_missing',
  'broker_invalid',
  'connection_failed',
  'request_rejected',
  'unexpected_response',
]);
const OPERATOR_ACTIONS = new Set(['none', 'observe', 'investigate']);
const BROKER_STATES = new Set(['idle', 'active', 'retry_wait', 'stopped']);
const BROKER_HEALTH = new Set(['initializing', 'healthy', 'degraded', 'stopped']);

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

export function isHqGovernanceSnapshotPayload(
  value: unknown,
): value is HqGovernanceSnapshotPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(payload, [
      'schemaVersion',
      'projectId',
      'observedAt',
      'available',
      'signal',
      'daemon',
      'attachmentBroker',
    ]) ||
    payload.schemaVersion !== 1 ||
    typeof payload.projectId !== 'string' ||
    payload.projectId.length === 0 ||
    typeof payload.observedAt !== 'string' ||
    typeof payload.available !== 'boolean' ||
    typeof payload.signal !== 'object' ||
    payload.signal === null ||
    Array.isArray(payload.signal)
  ) {
    return false;
  }
  const signal = payload.signal as Record<string, unknown>;
  if (
    !hasOnlyKeys(signal, ['level', 'code', 'operatorAction', 'executionDisposition']) ||
    !SIGNAL_LEVELS.has(signal.level as HqGovernanceSignalLevel) ||
    !SIGNAL_CODES.has(signal.code as HqGovernanceSignalCode) ||
    !OPERATOR_ACTIONS.has(signal.operatorAction as string) ||
    signal.executionDisposition !== 'continue'
  ) {
    return false;
  }
  if (
    (payload.available === false &&
      (signal.level !== 'unavailable' ||
        payload.daemon !== undefined ||
        payload.attachmentBroker !== undefined)) ||
    (payload.available === true && signal.level === 'unavailable')
  ) {
    return false;
  }
  if (payload.daemon !== undefined) {
    if (
      typeof payload.daemon !== 'object' ||
      payload.daemon === null ||
      Array.isArray(payload.daemon)
    ) {
      return false;
    }
    const daemon = payload.daemon as Record<string, unknown>;
    if (
      !hasOnlyKeys(daemon, ['pid', 'startedAt']) ||
      !isNonNegativeInteger(daemon.pid) ||
      typeof daemon.startedAt !== 'string'
    ) {
      return false;
    }
  }
  if (payload.attachmentBroker !== undefined && payload.attachmentBroker !== null) {
    if (typeof payload.attachmentBroker !== 'object' || Array.isArray(payload.attachmentBroker)) {
      return false;
    }
    const broker = payload.attachmentBroker as Record<string, unknown>;
    if (
      !hasOnlyKeys(broker, [
        'state',
        'health',
        'consecutiveFailures',
        'pendingRevocations',
        'auditHealthy',
        'expiresAt',
        'nextActionAt',
      ]) ||
      !BROKER_STATES.has(broker.state as string) ||
      !BROKER_HEALTH.has(broker.health as string) ||
      !isNonNegativeInteger(broker.consecutiveFailures) ||
      !isNonNegativeInteger(broker.pendingRevocations) ||
      typeof broker.auditHealthy !== 'boolean' ||
      (broker.expiresAt !== undefined && typeof broker.expiresAt !== 'string') ||
      (broker.nextActionAt !== undefined && typeof broker.nextActionAt !== 'string')
    ) {
      return false;
    }
  }
  return true;
}

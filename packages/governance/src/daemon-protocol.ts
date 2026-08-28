import type { GovernanceServiceCredential } from './capability-grant.js';
import {
  GOVERNANCE_SERVICE_CAPABILITIES,
  type GovernanceServiceCapability,
} from './service-protocol.js';

export const GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION = 2 as const;

interface GovernanceDaemonBootstrapRequest {
  readonly type: 'bootstrap';
  readonly protocolVersion: typeof GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly clientId: string;
  readonly capabilities: readonly GovernanceServiceCapability[];
  readonly ttlMs: number;
}

export type GovernanceDaemonBootstrapErrorCode =
  | 'invalid_bootstrap'
  | 'owner_conflict'
  | 'startup_busy'
  | 'endpoint_invalid'
  | 'startup_failed';

export type GovernanceDaemonBootstrapMessage =
  | {
      readonly type: 'ready';
      readonly protocolVersion: typeof GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION;
      readonly projectRoot: string;
      readonly projectId: string;
      readonly pid: number;
      readonly instanceId: string;
      readonly startedAt: string;
    }
  | {
      readonly type: 'bootstrap_result';
      readonly protocolVersion: typeof GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION;
      readonly nonce: string;
      readonly projectRoot: string;
      readonly projectId: string;
      readonly pid: number;
      readonly instanceId: string;
      readonly startedAt: string;
      readonly grantId: string;
      readonly expiresAt: string;
      readonly credential: GovernanceServiceCredential;
    }
  | {
      readonly type: 'bootstrap_error';
      readonly protocolVersion: typeof GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION;
      readonly code: GovernanceDaemonBootstrapErrorCode;
      readonly message: string;
    };

interface GovernanceDaemonProtocolIssue {
  readonly path: string;
  readonly message: string;
}

type GovernanceDaemonBootstrapRequestDecodeResult =
  | { readonly decoded: true; readonly request: GovernanceDaemonBootstrapRequest }
  | { readonly decoded: false; readonly issues: readonly GovernanceDaemonProtocolIssue[] };

type GovernanceDaemonBootstrapMessageDecodeResult =
  | { readonly decoded: true; readonly message: GovernanceDaemonBootstrapMessage }
  | { readonly decoded: false; readonly issues: readonly GovernanceDaemonProtocolIssue[] };

type JsonRecord = Record<string, unknown>;

function plainRecord(value: unknown): JsonRecord | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return null;
  }
  return value as JsonRecord;
}

function unknownFields(
  record: JsonRecord,
  allowed: readonly string[],
  path: string,
): GovernanceDaemonProtocolIssue[] {
  const allowedSet = new Set(allowed);
  return Object.keys(record)
    .filter((key) => !allowedSet.has(key))
    .map((key) => ({ path: `${path}.${key}`, message: `${path}.${key} is not allowed.` }));
}

function requiredString(
  record: JsonRecord,
  key: string,
  path: string,
  issues: GovernanceDaemonProtocolIssue[],
  maxLength: number,
): void {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    issues.push({
      path: `${path}.${key}`,
      message: `${path}.${key} must be a non-empty string of at most ${maxLength} characters.`,
    });
  }
}

function protocolVersion(record: JsonRecord, issues: GovernanceDaemonProtocolIssue[]): void {
  if (record.protocolVersion !== GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION) {
    issues.push({
      path: '$.protocolVersion',
      message: `Only daemon bootstrap protocol version ${GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION} is supported.`,
    });
  }
}

function instanceIdentity(record: JsonRecord, issues: GovernanceDaemonProtocolIssue[]): void {
  requiredString(record, 'instanceId', '$', issues, 128);
  if (typeof record.instanceId === 'string' && !/^[A-Za-z0-9_-]{1,128}$/.test(record.instanceId)) {
    issues.push({ path: '$.instanceId', message: '$.instanceId must be a token-safe identifier.' });
  }
  requiredString(record, 'startedAt', '$', issues, 64);
  if (typeof record.startedAt === 'string' && !Number.isFinite(Date.parse(record.startedAt))) {
    issues.push({ path: '$.startedAt', message: '$.startedAt must be a valid timestamp.' });
  }
}

function knownCapabilities(
  value: unknown,
  issues: GovernanceDaemonProtocolIssue[],
): readonly GovernanceServiceCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path: '$.capabilities', message: '$.capabilities must be a non-empty array.' });
    return [];
  }
  const known = new Set<string>(GOVERNANCE_SERVICE_CAPABILITIES);
  const capabilities: GovernanceServiceCapability[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const capability = value[index];
    if (typeof capability !== 'string' || !known.has(capability)) {
      issues.push({
        path: `$.capabilities[${index}]`,
        message: `$.capabilities[${index}] must be a known governance capability.`,
      });
      continue;
    }
    if (seen.has(capability)) {
      issues.push({
        path: `$.capabilities[${index}]`,
        message: `$.capabilities[${index}] duplicates an earlier capability.`,
      });
      continue;
    }
    seen.add(capability);
    capabilities.push(capability as GovernanceServiceCapability);
  }
  return Object.freeze(capabilities);
}

export function decodeGovernanceDaemonBootstrapRequest(
  input: unknown,
): GovernanceDaemonBootstrapRequestDecodeResult {
  const record = plainRecord(input);
  if (!record) {
    return {
      decoded: false,
      issues: [{ path: '$', message: 'Daemon bootstrap request must be a plain JSON object.' }],
    };
  }
  const issues = unknownFields(
    record,
    ['type', 'protocolVersion', 'nonce', 'clientId', 'capabilities', 'ttlMs'],
    '$',
  );
  if (record.type !== 'bootstrap') {
    issues.push({ path: '$.type', message: '$.type must be bootstrap.' });
  }
  protocolVersion(record, issues);
  requiredString(record, 'nonce', '$', issues, 128);
  requiredString(record, 'clientId', '$', issues, 512);
  const capabilities = knownCapabilities(record.capabilities, issues);
  if (!Number.isSafeInteger(record.ttlMs) || (record.ttlMs as number) <= 0) {
    issues.push({ path: '$.ttlMs', message: '$.ttlMs must be a positive safe integer.' });
  }
  if (issues.length > 0) return { decoded: false, issues: Object.freeze(issues) };
  return {
    decoded: true,
    request: Object.freeze({
      type: 'bootstrap',
      protocolVersion: GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
      nonce: record.nonce as string,
      clientId: record.clientId as string,
      capabilities,
      ttlMs: record.ttlMs as number,
    }),
  };
}

function decodeCredential(
  value: unknown,
  issues: GovernanceDaemonProtocolIssue[],
): GovernanceServiceCredential | null {
  const credential = plainRecord(value);
  if (!credential) {
    issues.push({ path: '$.credential', message: '$.credential must be a plain JSON object.' });
    return null;
  }
  issues.push(...unknownFields(credential, ['token', 'projectId', 'clientId'], '$.credential'));
  requiredString(credential, 'token', '$.credential', issues, 700);
  requiredString(credential, 'projectId', '$.credential', issues, 512);
  requiredString(credential, 'clientId', '$.credential', issues, 512);
  if (issues.length > 0) return null;
  return Object.freeze({
    token: credential.token as string,
    projectId: credential.projectId as string,
    clientId: credential.clientId as string,
  });
}

export function decodeGovernanceDaemonBootstrapMessage(
  input: unknown,
): GovernanceDaemonBootstrapMessageDecodeResult {
  const record = plainRecord(input);
  if (!record) {
    return {
      decoded: false,
      issues: [{ path: '$', message: 'Daemon bootstrap message must be a plain JSON object.' }],
    };
  }
  const issues: GovernanceDaemonProtocolIssue[] = [];
  protocolVersion(record, issues);
  if (record.type === 'ready') {
    issues.push(
      ...unknownFields(
        record,
        ['type', 'protocolVersion', 'projectRoot', 'projectId', 'pid', 'instanceId', 'startedAt'],
        '$',
      ),
    );
    requiredString(record, 'projectRoot', '$', issues, 32_768);
    requiredString(record, 'projectId', '$', issues, 512);
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
      issues.push({ path: '$.pid', message: '$.pid must be a positive safe integer.' });
    }
    instanceIdentity(record, issues);
    if (issues.length > 0) return { decoded: false, issues: Object.freeze(issues) };
    return {
      decoded: true,
      message: Object.freeze({
        type: 'ready',
        protocolVersion: GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
        projectRoot: record.projectRoot as string,
        projectId: record.projectId as string,
        pid: record.pid as number,
        instanceId: record.instanceId as string,
        startedAt: record.startedAt as string,
      }),
    };
  }
  if (record.type === 'bootstrap_result') {
    issues.push(
      ...unknownFields(
        record,
        [
          'type',
          'protocolVersion',
          'nonce',
          'projectRoot',
          'projectId',
          'pid',
          'instanceId',
          'startedAt',
          'grantId',
          'expiresAt',
          'credential',
        ],
        '$',
      ),
    );
    requiredString(record, 'nonce', '$', issues, 128);
    requiredString(record, 'projectRoot', '$', issues, 32_768);
    requiredString(record, 'projectId', '$', issues, 512);
    requiredString(record, 'grantId', '$', issues, 128);
    requiredString(record, 'expiresAt', '$', issues, 64);
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
      issues.push({ path: '$.pid', message: '$.pid must be a positive safe integer.' });
    }
    instanceIdentity(record, issues);
    const credential = decodeCredential(record.credential, issues);
    if (issues.length > 0 || !credential) {
      return { decoded: false, issues: Object.freeze(issues) };
    }
    return {
      decoded: true,
      message: Object.freeze({
        type: 'bootstrap_result',
        protocolVersion: GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
        nonce: record.nonce as string,
        projectRoot: record.projectRoot as string,
        projectId: record.projectId as string,
        pid: record.pid as number,
        instanceId: record.instanceId as string,
        startedAt: record.startedAt as string,
        grantId: record.grantId as string,
        expiresAt: record.expiresAt as string,
        credential,
      }),
    };
  }
  if (record.type === 'bootstrap_error') {
    issues.push(...unknownFields(record, ['type', 'protocolVersion', 'code', 'message'], '$'));
    const errorCodes = new Set<GovernanceDaemonBootstrapErrorCode>([
      'invalid_bootstrap',
      'owner_conflict',
      'startup_busy',
      'endpoint_invalid',
      'startup_failed',
    ]);
    if (
      typeof record.code !== 'string' ||
      !errorCodes.has(record.code as GovernanceDaemonBootstrapErrorCode)
    ) {
      issues.push({ path: '$.code', message: '$.code must be a known bootstrap error code.' });
    }
    requiredString(record, 'message', '$', issues, 1_024);
    if (issues.length > 0) return { decoded: false, issues: Object.freeze(issues) };
    return {
      decoded: true,
      message: Object.freeze({
        type: 'bootstrap_error',
        protocolVersion: GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
        code: record.code as GovernanceDaemonBootstrapErrorCode,
        message: record.message as string,
      }),
    };
  }
  issues.push({ path: '$.type', message: '$.type must be a known daemon bootstrap message.' });
  return { decoded: false, issues: Object.freeze(issues) };
}

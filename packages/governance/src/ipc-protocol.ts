import type { GovernanceServiceCredential } from './capability-grant.js';
import type { GovernanceServiceResponse } from './project-service.js';
import { GOVERNANCE_SERVICE_PROTOCOL_VERSION } from './service-protocol.js';

export const GOVERNANCE_IPC_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface GovernanceIpcRequestEnvelope {
  readonly protocolVersion: typeof GOVERNANCE_SERVICE_PROTOCOL_VERSION;
  readonly credential: GovernanceServiceCredential;
  readonly request: unknown;
}

interface GovernanceIpcDecodeIssue {
  readonly path: string;
  readonly message: string;
}

type GovernanceIpcEnvelopeDecodeResult =
  | { readonly decoded: true; readonly envelope: GovernanceIpcRequestEnvelope }
  | { readonly decoded: false; readonly issues: readonly GovernanceIpcDecodeIssue[] };

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

function unknownFields(record: JsonRecord, allowed: readonly string[], path: string) {
  const allowedSet = new Set(allowed);
  return Object.keys(record)
    .filter((key) => !allowedSet.has(key))
    .map((key) => ({ path: `${path}.${key}`, message: `${path}.${key} is not allowed.` }));
}

function requiredString(
  record: JsonRecord,
  key: string,
  path: string,
  issues: GovernanceIpcDecodeIssue[],
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

export function decodeGovernanceIpcEnvelope(input: unknown): GovernanceIpcEnvelopeDecodeResult {
  const issues: GovernanceIpcDecodeIssue[] = [];
  const record = plainRecord(input);
  if (!record) {
    return {
      decoded: false,
      issues: [{ path: '$', message: 'IPC envelope must be a plain JSON object.' }],
    };
  }
  issues.push(...unknownFields(record, ['protocolVersion', 'credential', 'request'], '$'));
  if (record.protocolVersion !== GOVERNANCE_SERVICE_PROTOCOL_VERSION) {
    issues.push({
      path: '$.protocolVersion',
      message: `Only protocol version ${GOVERNANCE_SERVICE_PROTOCOL_VERSION} is supported.`,
    });
  }
  const credential = plainRecord(record.credential);
  if (!credential) {
    issues.push({ path: '$.credential', message: '$.credential must be a plain JSON object.' });
  } else {
    issues.push(...unknownFields(credential, ['token', 'projectId', 'clientId'], '$.credential'));
    requiredString(credential, 'token', '$.credential', issues, 700);
    requiredString(credential, 'projectId', '$.credential', issues, 512);
    requiredString(credential, 'clientId', '$.credential', issues, 512);
  }
  if (!Object.hasOwn(record, 'request')) {
    issues.push({ path: '$.request', message: '$.request is required.' });
  }
  if (issues.length > 0) return { decoded: false, issues: Object.freeze(issues) };
  return {
    decoded: true,
    envelope: Object.freeze({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      credential: Object.freeze({
        token: credential!.token as string,
        projectId: credential!.projectId as string,
        clientId: credential!.clientId as string,
      }),
      request: record.request,
    }),
  };
}

export function encodeGovernanceIpcFrame(value: unknown): Buffer {
  const frame = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (frame.byteLength > GOVERNANCE_IPC_MAX_FRAME_BYTES) {
    throw new Error(`Governance IPC frame exceeds ${GOVERNANCE_IPC_MAX_FRAME_BYTES} bytes.`);
  }
  return frame;
}

export function decodeGovernanceIpcResponse(input: unknown): GovernanceServiceResponse {
  const record = plainRecord(input);
  if (!record || typeof record.ok !== 'boolean' || typeof record.requestId !== 'string') {
    throw new Error('Governance IPC response has an invalid envelope.');
  }
  if (record.ok) {
    if (!Object.hasOwn(record, 'result')) {
      throw new Error('Governance IPC success response is missing result.');
    }
  } else {
    const error = plainRecord(record.error);
    if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
      throw new Error('Governance IPC error response is invalid.');
    }
  }
  return record as unknown as GovernanceServiceResponse;
}

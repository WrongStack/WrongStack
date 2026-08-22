import { isRegisteredMessageType } from './registry.js';
import type {
  CanonicalClientMessage,
  CanonicalServerMessage,
  ProtocolDecodeIssue,
  ProtocolDecodeResult,
  ProtocolDirection,
  ProtocolEnvelope,
} from './types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PAYLOAD_DEPTH = 32;

function inspectValue(value: unknown, path: string, depth: number): ProtocolDecodeIssue | null {
  if (depth > MAX_PAYLOAD_DEPTH) {
    return { code: 'too_deep', message: 'Protocol payload exceeds the nesting limit', path };
  }
  if (value === null || typeof value !== 'object') return null;

  for (const key of Object.keys(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) {
      return { code: 'unsafe_key', message: `Unsafe protocol key: ${key}`, path: childPath };
    }
    const issue = inspectValue((value as Record<string, unknown>)[key], childPath, depth + 1);
    if (issue) return issue;
  }
  return null;
}

export function decodeProtocolMessage(
  input: unknown,
  direction: 'client',
): ProtocolDecodeResult<CanonicalClientMessage>;
export function decodeProtocolMessage(
  input: unknown,
  direction: 'server',
): ProtocolDecodeResult<CanonicalServerMessage>;
export function decodeProtocolMessage(
  input: unknown,
  direction: ProtocolDirection,
): ProtocolDecodeResult<ProtocolEnvelope> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      issue: { code: 'invalid_envelope', message: 'Protocol message must be an object' },
    };
  }

  const envelope = input as Record<string, unknown>;
  if (typeof envelope['type'] !== 'string' || envelope['type'].length === 0) {
    return {
      ok: false,
      issue: { code: 'invalid_type', message: 'Protocol message type must be a non-empty string' },
    };
  }
  if (!isRegisteredMessageType(envelope['type'], direction)) {
    return {
      ok: false,
      issue: { code: 'unknown_type', message: `Unknown ${direction} message: ${envelope['type']}` },
    };
  }
  if (direction === 'server' && !Object.hasOwn(envelope, 'payload')) {
    return {
      ok: false,
      issue: { code: 'invalid_envelope', message: 'Server protocol messages require a payload' },
    };
  }

  const issue = inspectValue(envelope, '$', 0);
  if (issue) return { ok: false, issue };
  return { ok: true, message: input as ProtocolEnvelope };
}

export function decodeProtocolFrame(
  frame: string,
  direction: 'client',
): ProtocolDecodeResult<CanonicalClientMessage>;
export function decodeProtocolFrame(
  frame: string,
  direction: 'server',
): ProtocolDecodeResult<CanonicalServerMessage>;
export function decodeProtocolFrame(
  frame: string,
  direction: ProtocolDirection,
): ProtocolDecodeResult<ProtocolEnvelope> {
  try {
    return decodeProtocolMessage(JSON.parse(frame), direction as 'client');
  } catch {
    return {
      ok: false,
      issue: { code: 'invalid_envelope', message: 'Protocol frame is not valid JSON' },
    };
  }
}

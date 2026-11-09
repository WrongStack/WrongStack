import type {
  AcpRuntimeOptionsResult,
  AcpRuntimeValues,
} from '@wrongstack/contracts/types/acp-runtime';
import { acpRuntimeValuesError } from '@wrongstack/contracts/types/acp-runtime';

export interface HqAcpConfigCommand {
  type: 'acp-config';
  sessionId: string;
  agentId: string;
  action: 'inspect' | 'set';
  values?: AcpRuntimeValues;
  expected?: AcpRuntimeValues;
}
export function parseHqAcpConfig(p: Record<string, unknown>): HqAcpConfigCommand | null {
  if (
    typeof p.sessionId !== 'string' ||
    !p.sessionId ||
    p.sessionId.length > 512 ||
    typeof p.agentId !== 'string' ||
    !p.agentId ||
    p.agentId.length > 200 ||
    ['__proto__', 'constructor', 'prototype'].includes(p.agentId)
  )
    return null;
  if (p.action === 'inspect')
    return { type: 'acp-config', action: 'inspect', agentId: p.agentId, sessionId: p.sessionId };
  if (p.action !== 'set' || acpRuntimeValuesError(p.values) || acpRuntimeValuesError(p.expected))
    return null;
  return {
    type: 'acp-config',
    action: 'set',
    agentId: p.agentId,
    sessionId: p.sessionId,
    values: p.values as AcpRuntimeValues,
    expected: p.expected as AcpRuntimeValues,
  };
}
/** The acknowledgement carries selectors only, never a generic remote response. */
export function isHqAcpConfigResult(value: unknown): value is AcpRuntimeOptionsResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as AcpRuntimeOptionsResult;
  const bounded = (x: unknown, max = 2000): x is string => typeof x === 'string' && x.length <= max;
  if (
    !bounded(p.agentId, 200) ||
    acpRuntimeValuesError(p.applied) ||
    !Array.isArray(p.options) ||
    p.options.length > 64
  )
    return false;
  if (
    !p.options.every(
      (x) =>
        x &&
        bounded(x.id, 200) &&
        bounded(x.name) &&
        bounded(x.currentValue) &&
        (x.category === undefined || bounded(x.category, 100)) &&
        (x.description === undefined || bounded(x.description)) &&
        Array.isArray(x.options) &&
        x.options.length <= 8192 &&
        x.options.every((y) => y && bounded(y.value) && bounded(y.name)),
    )
  )
    return false;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256_000;
}

import { createHash } from 'node:crypto';
import { objectRecord } from './modern-protocol.js';

export function taskInputFingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : objectRecord(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, item]) => [k, canonical(item)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)) ?? 'undefined')
    .digest('hex');
}

export function validateAnsweredInputs(value: unknown): Record<string, string> {
  const record = objectRecord(value);
  if (!record || Object.keys(record).length > 64) throw new Error('Invalid saved MCP input keys');
  const result: Record<string, string> = Object.create(null);
  for (const [key, hash] of Object.entries(record)) {
    if (
      !key ||
      key.length > 256 ||
      /[\x00-\x1f\x7f]/.test(key) ||
      typeof hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      throw new Error('Invalid saved MCP input fingerprint');
    result[key] = hash;
  }
  return result;
}

/**
 * The one implementation of Chronicle's tamper-evident hash.
 *
 * Chronicle events form a chain: each carries the `hash` of its predecessor in
 * `previousHash`, anchored at {@link GENESIS_HASH}. Verification recomputes
 * every `hash` from the stored event, so the canonicalization below is part of
 * the durable format — two subtly different implementations would produce two
 * incompatible chains, and the divergence would only surface later as a
 * "corrupt journal" report on data that was never actually tampered with.
 *
 * It therefore lives here rather than beside any one store, and both the JSONL
 * journal and the SQLite journal import it.
 */
import { createHash } from 'node:crypto';
import type { ChronicleEvent } from './types.js';

/** `previousHash` of the first event in a chain. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministic JSON encoding: object keys sorted, `undefined` members dropped,
 * `undefined` array elements encoded as `null`.
 *
 * Note this is NOT what gets written to disk — the JSONL journal stores
 * `JSON.stringify(event)` in V8 property order. The stored bytes are a record;
 * the preimage is always re-derived from the parsed event.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((key) => obj[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`;
}

export function hashValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

/**
 * Recompute the hash a stored event should carry.
 *
 * The `hash` field is excluded from its own preimage, so verification of an
 * event read back from any store is `chronicleEventHash(event) === event.hash`.
 */
export function chronicleEventHash(event: ChronicleEvent): string {
  const { hash: _hash, ...unhashed } = event;
  return hashValue(unhashed);
}

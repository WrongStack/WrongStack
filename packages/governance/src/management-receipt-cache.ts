import { createHash } from 'node:crypto';

import type { GovernanceServiceCredential } from './capability-grant.js';
import type { GovernanceServiceResponse } from './project-service.js';

export const GOVERNANCE_MANAGEMENT_RECEIPT_TTL_MS = 30_000;
const GOVERNANCE_MANAGEMENT_RECEIPT_MAX_ENTRIES = 1_024;

interface GovernanceManagementReceiptCacheOptions {
  readonly now?: (() => number) | undefined;
  readonly ttlMs?: number | undefined;
  readonly maxEntries?: number | undefined;
}

type GovernanceManagementReceiptLookup =
  | { readonly kind: 'miss' }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'conflict'; readonly allowAfterRotation: boolean }
  | {
      readonly kind: 'replay';
      readonly response: GovernanceServiceResponse;
      readonly allowAfterRotation: boolean;
    };

interface ReceiptRecord {
  readonly fingerprint: string;
  readonly response: GovernanceServiceResponse | null;
  readonly allowAfterRotation: boolean;
  readonly expiresAtMs: number;
}

interface GovernanceManagementReceiptReservation {
  readonly key: string;
  readonly fingerprint: string;
  readonly requestId: string;
}

interface FingerprintBudget {
  nodes: number;
}

const MAX_FINGERPRINT_DEPTH = 64;
const MAX_FINGERPRINT_NODES = 20_000;

function stableValue(value: unknown, depth: number, budget: FingerprintBudget): string | null {
  budget.nodes += 1;
  if (depth > MAX_FINGERPRINT_DEPTH || budget.nodes > MAX_FINGERPRINT_NODES) return null;
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const serialized = stableValue(item, depth + 1, budget);
      if (serialized === null) return null;
      items.push(serialized);
    }
    return `[${items.join(',')}]`;
  }
  if (!value || typeof value !== 'object') return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue;
    const serialized = stableValue(record[key], depth + 1, budget);
    if (serialized === null) return null;
    fields.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${fields.join(',')}}`;
}

function fingerprint(value: unknown): string | null {
  const stable = stableValue(value, 0, { nodes: 0 });
  return stable === null ? null : createHash('sha256').update(stable).digest('hex');
}

function requestIdFromUnknown(input: unknown): string | null {
  return input &&
    typeof input === 'object' &&
    'requestId' in input &&
    typeof input.requestId === 'string' &&
    input.requestId.length > 0
    ? input.requestId
    : null;
}

function receiptKey(credential: GovernanceServiceCredential, requestId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([credential.projectId, credential.clientId, credential.token, requestId]),
    )
    .digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export class GovernanceManagementReceiptCache {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly records = new Map<string, ReceiptRecord>();

  constructor(options: GovernanceManagementReceiptCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? GOVERNANCE_MANAGEMENT_RECEIPT_TTL_MS;
    this.maxEntries = options.maxEntries ?? GOVERNANCE_MANAGEMENT_RECEIPT_MAX_ENTRIES;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Governance management receipt TTL must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error('Governance management receipt capacity must be a positive safe integer.');
    }
  }

  lookup(
    input: unknown,
    credential: GovernanceServiceCredential,
  ): GovernanceManagementReceiptLookup {
    const requestId = requestIdFromUnknown(input);
    if (!requestId) return { kind: 'miss' };
    const key = receiptKey(credential, requestId);
    const record = this.records.get(key);
    if (!record) return { kind: 'miss' };
    if (record.expiresAtMs <= this.now()) {
      this.records.delete(key);
      return { kind: 'miss' };
    }
    if (record.response === null) return { kind: 'in_progress' };
    const actual = fingerprint(input);
    if (!actual || actual !== record.fingerprint) {
      return { kind: 'conflict', allowAfterRotation: record.allowAfterRotation };
    }
    return {
      kind: 'replay',
      response: record.response,
      allowAfterRotation: record.allowAfterRotation,
    };
  }

  reserve(options: {
    readonly input: unknown;
    readonly credential: GovernanceServiceCredential;
    /**
     * Raw wire payload to fingerprint for replay-conflict detection. Must be
     * the same form that subsequent `lookup` calls see; defaults to `input`
     * when the caller has no separate wire form. Passing the raw form (and
     * not the decoder-normalized form) keeps the contract immune to a future
     * decoder that adds content-preserving normalization, which would
     * otherwise turn every legitimate retry into a misleading
     * "requestId already used" conflict.
     */
    readonly wireInput?: unknown;
  }): GovernanceManagementReceiptReservation | null {
    this.pruneExpired();
    const requestId = requestIdFromUnknown(options.input);
    const fingerprintTarget = options.wireInput ?? options.input;
    const requestFingerprint = fingerprint(fingerprintTarget);
    if (!requestId || !requestFingerprint) return null;
    const key = receiptKey(options.credential, requestId);
    if (this.records.has(key) || this.records.size >= this.maxEntries) return null;
    this.records.set(key, {
      fingerprint: requestFingerprint,
      response: null,
      allowAfterRotation: false,
      expiresAtMs: this.now() + this.ttlMs,
    });
    return Object.freeze({ key, fingerprint: requestFingerprint, requestId });
  }

  commit(
    reservation: GovernanceManagementReceiptReservation,
    response: GovernanceServiceResponse,
    allowAfterRotation = false,
  ): void {
    const current = this.records.get(reservation.key);
    if (!current || current.response !== null || current.fingerprint !== reservation.fingerprint) {
      throw new Error('Governance management receipt reservation is not active.');
    }
    if (response.requestId !== reservation.requestId) {
      throw new Error('Governance management receipt response request id does not match.');
    }
    this.records.set(reservation.key, {
      ...current,
      response: deepFreeze(response),
      allowAfterRotation,
    });
  }

  release(reservation: GovernanceManagementReceiptReservation): void {
    const current = this.records.get(reservation.key);
    if (current?.response === null && current.fingerprint === reservation.fingerprint) {
      this.records.delete(reservation.key);
    }
  }

  clear(): void {
    this.records.clear();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.expiresAtMs <= now) this.records.delete(key);
    }
  }
}

/**
 * Sync ladder — server → client resume envelopes.
 *
 * Triggered when a client reconnects after a network interruption and sends
 * `client.resume { lastSeqSeen }`. The server replies with one of:
 *  - `hq.resume_gap` — bounded list of missed envelopes from the event log.
 *  - `hq.snapshot` — full snapshot when the gap is too large (>1000 envelopes
 *    or >24 h stale) or when the event log cannot serve the gap.
 *
 * The envelope is additively v1; existing v1 clients ignore unknown types.
 *
 * See `docs/plans/hq-evolution-2026-08.md` §2.5 and §7.
 *
 * @module hq/protocol/resume
 */

import type { HqEventEnvelope } from './core.js';

/** Maximum envelopes per `hq.resume_gap` reply. */
export const HQ_RESUME_GAP_MAX_ENVELOPES = 1000;

/** Maximum bytes per `hq.resume_gap` reply (sum of `JSON.stringify(envelope).byteLength`). */
export const HQ_RESUME_GAP_MAX_BYTES = 1_048_576; // 1 MiB;

/** Maximum age of `lastSeqSeen` for which the gap-fill route is acceptable. */
export const HQ_RESUME_GAP_MAX_STALE_MS = 24 * 60 * 60 * 1000; // 24 h.

/**
 * Server-to-client gap-fill envelope. The server reads the unbounded
 * `HqEventLog` for envelopes with `(clientId, seq) > lastSeqSeen` and
 * returns them capped at `{HQ_RESUME_GAP_MAX_ENVELOPES}` items and
 * `{HQ_RESUME_GAP_MAX_BYTES}` bytes. The client is expected to dedupe
 * on `envelope.id` (already in the `HqEventEnvelope` shape).
 */
export interface HqResumeGapMessage {
  type: 'hq.resume_gap';
  /** The `lastSeqSeen` the client reported on `client.resume`. */
  lastSeqSeen: number;
  /** Envelopes the client missed. Bounded by the limits above. */
  envelopes: readonly HqEventEnvelope[];
  /** True when the response was capped; the client should request a snapshot. */
  truncated: boolean;
}

/**
 * Server-to-client resume indicator. The server uses this to tell the
 * client why the gap-fill could not be served (e.g. snapshotted instead).
 */
export interface HqResumeRejectMessage {
  type: 'hq.resume_reject';
  reason: 'gap_too_large' | 'last_seen_too_old' | 'log_unavailable';
  /** ISO timestamp the server received the resume. */
  detectedAt: string;
}

export type HqResumeMessage = HqResumeGapMessage | HqResumeRejectMessage;

/**
 * Returns `true` if `envelope` is a `HqResumeGapMessage` with valid shape.
 * Defensive against malformed payloads from misbehaving servers.
 */
export function isHqResumeGapMessage(x: unknown): x is HqResumeGapMessage {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const v = x as Record<string, unknown>;
  if (v.type !== 'hq.resume_gap') return false;
  if (!Number.isSafeInteger(v.lastSeqSeen) || (v.lastSeqSeen as number) < 0) return false;
  if (!Array.isArray(v.envelopes)) return false;
  if (v.envelopes.length > HQ_RESUME_GAP_MAX_ENVELOPES) return false;
  if (typeof v.truncated !== 'boolean') return false;
  return true;
}

export function isHqResumeRejectMessage(x: unknown): x is HqResumeRejectMessage {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const v = x as Record<string, unknown>;
  if (v.type !== 'hq.resume_reject') return false;
  if (
    v.reason !== 'gap_too_large' &&
    v.reason !== 'last_seen_too_old' &&
    v.reason !== 'log_unavailable'
  ) {
    return false;
  }
  if (typeof v.detectedAt !== 'string' || !Number.isFinite(Date.parse(v.detectedAt))) return false;
  return true;
}

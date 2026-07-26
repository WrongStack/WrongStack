/**
 * Core data types for the Chimera Finding Store.
 *
 * FS-P0.0: Every finding is produced by parsing a Chimera review report,
 * deduplicated by fingerprint, and tracked through a documented lifecycle
 * state machine.
 *
 * @module review-finding-types
 */

// ── Severity and status ────────────────────────────────────────────

/** Severity level from the report heading. */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Current lifecycle status of a finding.
 *
 * ```
 * found (created) → triaged → in_progress → resolved
 *   │                  │            │
 *   └→ ignored ──────→│────────────┘
 *   (found again)      (reopened)
 * ```
 */
export type FindingStatus = 'active' | 'triaged' | 'in_progress' | 'resolved' | 'ignored';

/** How a resolved finding was concluded. */
export type ResolutionOutcome =
  | 'fixed'
  | 'wontfix'
  | 'duplicate'
  | 'false_positive'
  | 'stale';

/** What type of agent produced the review report. */
export type FindingSource = 'auto' | 'chimera' | 'cascade' | 'security-scanner';

/** What kind of actor performed a lifecycle transition. */
export type ActorKind = 'agent' | 'operator' | 'system';

// ── Core types ─────────────────────────────────────────────────────

export interface ChimeraFindingLocation {
  /** Project-relative file path. */
  file: string;
  /** Line number within the file, if known. */
  line?: number | undefined;
}

export interface ChimeraFindingOrigin {
  /** Unique report run ID. */
  reportId: string;
  /** Session that triggered the review. */
  sessionId: string;
  /** Agent that was being reviewed. */
  agentId: string;
  /** Model that produced the review report. */
  reviewerModel: string;
}

export interface ChimeraFindingResolution {
  outcome: ResolutionOutcome;
  resolvedAt: string; // ISO8601
  resolvedBy: string; // actor ID
  commitSha?: string | undefined;
  committedAt?: string | undefined;
  notes?: string | undefined;
}

/** Full finding record, written once and never mutated. */
export interface ChimeraFinding {
  /** Immutable UUID. */
  id: string;
  /** Content fingerprint for deduplication. */
  fingerprint: string;
  /** Severity from the report heading. */
  severity: FindingSeverity;
  /** Review kind that produced this finding. */
  source: FindingSource;
  /** Where the issue was found. */
  location?: ChimeraFindingLocation | undefined;
  /** One-line title extracted from the report item. */
  title: string;
  /** Full description paragraphs. */
  description: string;
  /** Suggested fix, if the reviewer provided one. */
  suggestedFix?: string | undefined;
  /** ISO8601 — when the finding was first created. */
  createdAt: string;
  /** Materialized current status (derived from latest lifecycle event). */
  status: FindingStatus;
  /** Set only when status === 'resolved'. */
  resolution?: ChimeraFindingResolution | undefined;
  /** Original review context that produced this finding. */
  originReport: ChimeraFindingOrigin;
}

// ── Lifecycle event types ──────────────────────────────────────────

export type FindingEventType =
  | 'created'
  | 'relinked'
  | 'reopened'
  | 'triaged'
  | 'started'
  | 'resolved'
  | 'ignored'
  | 'compacted';

/** A single state-transition event in a finding's lifecycle. */
export interface FindingLifecycleEvent {
  id: string;
  findingId: string;
  eventType: FindingEventType;
  fromStatus: FindingStatus | null;
  toStatus: FindingStatus;
  actorId: string;
  actorKind: ActorKind;
  timestamp: string; // ISO8601
  reason?: string | undefined;
}

// ── Error classes ──────────────────────────────────────────────────

export class FindingNotFoundError extends Error {
  readonly findingId: string;
  constructor(findingId: string) {
    super(`Finding not found: ${findingId}`);
    this.name = 'FindingNotFoundError';
    this.findingId = findingId;
  }
}

export class InvalidTransitionError extends Error {
  readonly from: FindingStatus;
  readonly to: FindingStatus;
  constructor(from: FindingStatus, to: FindingStatus, reason?: string) {
    const msg = reason ?? `Invalid transition from "${from}" to "${to}"`;
    super(msg);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class FindingStoreLockError extends Error {
  readonly path: string;
  constructor(path: string, cause?: string) {
    super(`Could not acquire finding store lock: ${path}${cause ? ` (${cause})` : ''}`);
    this.name = 'FindingStoreLockError';
    this.path = path;
  }
}

// ── Fingerprint ────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

/** Normalize a title for fingerprinting: lowercase, strip trailing punctuation, collapse whitespace. */
export function normalizeFingerprintTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ')    // collapse whitespace
    .trim();
}

/**
 * Generate a deterministic fingerprint for a finding.
 *
 * Fingerprint = SHA256(file + ":" + line + ":" + normalizedTitle).
 *
 * When `line` is null/undefined, 0 is used so the fingerprint still
 * provides deduplication for findings without a specific line.
 */
export function computeFindingFingerprint(
  file: string,
  line: number | undefined | null,
  title: string,
): string {
  const normalizedTitle = normalizeFingerprintTitle(title);
  const normalizedFile = file.replace(/\\/g, '/').trim().toLowerCase();
  const lineStr = line != null && line >= 0 ? String(line) : '0';
  const hash = createHash('sha256');
  hash.update(`${normalizedFile}:${lineStr}:${normalizedTitle}`);
  return hash.digest('hex');
}

// ── Transition state machine ───────────────────────────────────────

const TRANSITION_MATRIX: Record<FindingStatus, ReadonlySet<FindingStatus>> = {
  active: new Set(['triaged', 'ignored', 'resolved']),
  triaged: new Set(['in_progress', 'ignored', 'resolved']),
  in_progress: new Set(['resolved', 'active']),
  ignored: new Set(['active']),
  resolved: new Set(['active']),
};

/**
 * Check whether a status transition is valid per the state machine.
 * Throws InvalidTransitionError for invalid transitions.
 */
export function validateTransition(
  from: FindingStatus,
  to: FindingStatus,
): void {
  if (from === to) return; // same status is idempotent
  const allowed = TRANSITION_MATRIX[from];
  if (!allowed?.has(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/**
 * Resolve transitions requires an outcome.
 */
export function validateResolution(
  status: FindingStatus,
  outcome?: ResolutionOutcome | undefined,
): void {
  if (status !== 'resolved') return;
  if (!outcome) {
    throw new InvalidTransitionError(
      'active',
      'resolved',
      'A resolution outcome is required when transitioning to "resolved"',
    );
  }
}

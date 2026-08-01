/**
 * Chimera Finding Store — persistent JSONL store with lifecycle tracking.
 *
 * FS-P0.1 through FS-P0.4
 *
 * @module review-finding-store
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { SECRET_FILE_MODE } from '../security/file-permissions.js';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import type {
  ChimeraFinding,
  FindingEventType,
  FindingLifecycleEvent,
  FindingSeverity,
  FindingStatus,
  ResolutionOutcome,
} from './review-finding-types.js';
import { validateResolution, validateTransition } from './review-finding-types.js';

// ── Constants ──────────────────────────────────────────────────────

/** Default retention for resolved findings (30 days in ms). */
export const FINDING_RESOLVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Default retention for ignored/wontfix findings (14 days in ms). */
export const FINDING_IGNORED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Max findings returned by list() without a limit. */
export const FINDING_DEFAULT_PAGE_SIZE = 50;

/** JSONL separator. */
const NL = '\n';
const LINE_SEPARATOR = NL;

// ── File name ──────────────────────────────────────────────────────

/** File name for the finding store JSONL file. */
export const FINDING_STORE_FILE = 'review-findings.jsonl';

/** Resolve the absolute path to the finding store file. */
export function resolveFindingStorePath(projectDir: string): string {
  return path.join(projectDir, FINDING_STORE_FILE);
}

// ── JSONL record types ────────────────────────────────────────────

/** JSONL record discriminator for a finding record. */
interface FindingRecord {
  __finding: 1;
  data: ChimeraFinding;
}

/** JSONL record discriminator for a lifecycle event. */
interface LifecycleEventRecord {
  __findingEvent: 1;
  data: FindingLifecycleEvent;
}

/** JSONL record discriminator for a compaction marker. */
interface CompactMarker {
  __findingCompact: 1;
  compactedAt: string;
  removedFindings: number;
  foldedEvents: number;
}

// ── Store implementation ───────────────────────────────────────────

export interface UpsertResult {
  created: number;
  relinked: number;
  reopened: number;
}

export interface UpsertContext {
  sessionId: string;
  reportId: string;
  agentId: string;
  model: string;
}

export interface ListOptions {
  severities?: FindingSeverity[] | undefined;
  statuses?: FindingStatus[] | undefined;
  file?: string | undefined;
  /** Filter to findings from a specific review report. */
  reportId?: string | undefined;
  limit?: number | undefined;
}

export interface CompactOptions {
  /** Resolved/ignored findings older than this (ms) are eligible. Default: FINDING_RESOLVED_RETENTION_MS. */
  resolvedMaxAgeMs?: number | undefined;
  /** Ignored findings use this separately. Default: FINDING_IGNORED_RETENTION_MS. */
  ignoredMaxAgeMs?: number | undefined;
}

export interface FindingStore {
  upsert(findings: ChimeraFinding[], context: UpsertContext): Promise<UpsertResult>;
  transition(
    findingId: string,
    to: FindingStatus,
    actor: { id: string; kind: 'agent' | 'operator' | 'system' },
    opts?: { reason?: string; outcome?: ResolutionOutcome },
  ): Promise<ChimeraFinding>;
  list(opts?: ListOptions): Promise<ChimeraFinding[]>;
  get(idOrFingerprint: string): Promise<ChimeraFinding | null>;
  getEvents(findingId: string): Promise<FindingLifecycleEvent[]>;
  compact(opts?: CompactOptions): Promise<{ removed: number; eventsFolded: number }>;
}

export class JsonlFindingStore implements FindingStore {
  private readonly filePath: string;

  constructor(projectDir: string) {
    this.filePath = resolveFindingStorePath(projectDir);
  }

  get storePath(): string {
    return this.filePath;
  }

  // ── Path helpers ─────────────────────────────────────────────────

  async upsert(newFindings: ChimeraFinding[], context: UpsertContext): Promise<UpsertResult> {
    if (newFindings.length === 0) return { created: 0, relinked: 0, reopened: 0 };

    const result: UpsertResult = { created: 0, relinked: 0, reopened: 0 };

    const existing = await this._readAll();

    return withFileLock(this.filePath, async () => {
      for (const finding of newFindings) {
        const match = existing.find((e) => e.finding.fingerprint === finding.fingerprint);
        if (match) {
          // Materialize current status from events before checking reopen eligibility.
          const materialized = this._materialize(match);
          if (materialized.status === 'resolved' || materialized.status === 'ignored') {
            const reopenEvent = this._makeEvent(
              match.finding.id,
              'reopened',
              materialized.status,
              'active',
              context,
            );
            match.finding.status = 'active';
            match.finding.resolution = undefined;
            // Re-persist the finding record so status + cleared resolution survive reads.
            const updatedRecord: FindingRecord = { __finding: 1, data: match.finding };
            await fsp.appendFile(
              this.filePath,
              JSON.stringify(updatedRecord) +
                LINE_SEPARATOR +
                JSON.stringify({ __findingEvent: 1, data: reopenEvent }) +
                LINE_SEPARATOR,
              { encoding: 'utf8', mode: SECRET_FILE_MODE },
            );
            result.reopened++;
          } else {
            const relinkEvent = this._makeEvent(
              match.finding.id,
              'relinked',
              match.finding.status,
              match.finding.status,
              context,
            );
            await fsp.appendFile(
              this.filePath,
              JSON.stringify({ __findingEvent: 1, data: relinkEvent }) + LINE_SEPARATOR,
              { encoding: 'utf8', mode: SECRET_FILE_MODE },
            );
            result.relinked++;
          }
        } else {
          // New finding — append the record and a created event.
          const record: FindingRecord = { __finding: 1, data: finding };
          const createdEvent = this._makeEvent(finding.id, 'created', null, 'active', context);
          const lines =
            JSON.stringify(record) +
            LINE_SEPARATOR +
            JSON.stringify({ __findingEvent: 1, data: createdEvent }) +
            LINE_SEPARATOR;
          await fsp.appendFile(this.filePath, lines, { encoding: 'utf8', mode: SECRET_FILE_MODE });
          result.created++;
        }
      }
      return result;
    });
  }

  async transition(
    findingId: string,
    to: FindingStatus,
    actor: { id: string; kind: 'agent' | 'operator' | 'system' },
    opts?: { reason?: string; outcome?: ResolutionOutcome },
  ): Promise<ChimeraFinding> {
    const all = await this._readAll();
    const entry = all.find((e) => e.finding.id === findingId);
    if (!entry) throw new Error(`Finding not found: ${findingId}`);

    const from = entry.finding.status;
    validateTransition(from, to);
    validateResolution(to, opts?.outcome);

    const event: FindingLifecycleEvent = {
      id: randomUUID(),
      findingId,
      eventType:
        to === 'resolved' ? 'resolved' : to === 'ignored' ? 'ignored' : this._eventTypeFor(to),
      fromStatus: from,
      toStatus: to,
      actorId: actor.id,
      actorKind: actor.kind,
      timestamp: new Date().toISOString(),
      reason: opts?.reason,
    };

    entry.finding.status = to;
    if (to === 'resolved' && opts?.outcome) {
      entry.finding.resolution = {
        outcome: opts.outcome,
        resolvedAt: event.timestamp,
        resolvedBy: actor.id,
        notes: opts.reason,
      };
    }

    // Re-persist the finding record so non-event fields (resolution, etc.)
    // survive _readAll + _materialize. The latest record wins on read.
    const updatedRecord: FindingRecord = { __finding: 1, data: entry.finding };
    await fsp.appendFile(
      this.filePath,
      JSON.stringify(updatedRecord) +
        LINE_SEPARATOR +
        JSON.stringify({ __findingEvent: 1, data: event }) +
        LINE_SEPARATOR,
      { encoding: 'utf8', mode: SECRET_FILE_MODE },
    );

    return { ...entry.finding };
  }

  async list(opts?: ListOptions): Promise<ChimeraFinding[]> {
    const all = await this._readAll();
    let findings = all.map((e) => this._materialize(e));

    if (opts?.severities && opts.severities.length > 0) {
      const sevs = new Set(opts.severities);
      findings = findings.filter((f) => sevs.has(f.severity));
    }
    if (opts?.statuses && opts.statuses.length > 0) {
      const sts = new Set(opts.statuses);
      findings = findings.filter((f) => sts.has(f.status));
    }
    if (opts?.file) {
      const pattern = opts.file.toLowerCase();
      findings = findings.filter((f) => f.location?.file.toLowerCase().includes(pattern));
    }
    if (opts?.reportId) {
      findings = findings.filter((f) => f.originReport.reportId === opts.reportId);
    }

    // Sort by severity (critical first), then by age (oldest first).
    const severityRank: Record<FindingSeverity, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    };
    findings.sort((a, b) => {
      const sa = severityRank[a.severity] - severityRank[b.severity];
      if (sa !== 0) return sa;
      return a.createdAt.localeCompare(b.createdAt);
    });

    const limit = opts?.limit ?? FINDING_DEFAULT_PAGE_SIZE;
    return findings.slice(0, limit);
  }

  async get(idOrFingerprint: string): Promise<ChimeraFinding | null> {
    const all = await this._readAll();
    const entry = all.find(
      (e) => e.finding.id === idOrFingerprint || e.finding.fingerprint === idOrFingerprint,
    );
    return entry ? this._materialize(entry) : null;
  }

  async getEvents(findingId: string): Promise<FindingLifecycleEvent[]> {
    const all = await this._readAllLines();
    const events: FindingLifecycleEvent[] = [];
    for (const line of all) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (this._isLifecycleEvent(parsed) && parsed.data.findingId === findingId) {
          events.push(parsed.data);
        }
      } catch {
        // Skip malformed lines.
      }
    }
    return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async compact(opts?: CompactOptions): Promise<{ removed: number; eventsFolded: number }> {
    const resolvedMaxAge = opts?.resolvedMaxAgeMs ?? FINDING_RESOLVED_RETENTION_MS;
    const ignoredMaxAge = opts?.ignoredMaxAgeMs ?? FINDING_IGNORED_RETENTION_MS;
    const now = Date.now();

    const all = await this._readAll();
    const kept: Array<{ record: FindingRecord | null; events: FindingLifecycleEvent[] }> = [];
    let removed = 0;
    let eventsFolded = 0;

    for (const entry of all) {
      const age = now - new Date(entry.finding.createdAt).getTime();
      const isResolved = entry.finding.status === 'resolved';
      const isIgnored = entry.finding.status === 'ignored';
      const maxAge = isResolved ? resolvedMaxAge : isIgnored ? ignoredMaxAge : Infinity;

      if (age > maxAge && (isResolved || isIgnored)) {
        removed++;
        eventsFolded += entry.events.length;
        continue;
      }

      // Fold events older than maxAge into a single compacted marker.
      const oldEvents = entry.events.filter(
        (ev) => now - new Date(ev.timestamp).getTime() > maxAge,
      );
      if (oldEvents.length > 1) {
        eventsFolded += oldEvents.length - 1;
        // Keep only the newest event before maxAge (fold the rest).
        const newestOld = oldEvents.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]!;
        entry.events = [
          newestOld,
          ...entry.events.filter((ev) => now - new Date(ev.timestamp).getTime() <= maxAge),
        ];
      }
      kept.push({ record: { __finding: 1, data: entry.finding }, events: entry.events });
    }

    // Rewrite the file.
    const lines: string[] = [];
    for (const { record, events } of kept) {
      if (record) lines.push(JSON.stringify(record));
      for (const ev of events) {
        lines.push(JSON.stringify({ __findingEvent: 1, data: ev }));
      }
    }
    // Append a compaction marker.
    lines.push(
      JSON.stringify({
        __findingCompact: 1,
        compactedAt: new Date().toISOString(),
        removedFindings: removed,
        foldedEvents: eventsFolded,
      } as CompactMarker),
    );

    await atomicWrite(this.filePath, lines.join(LINE_SEPARATOR) + LINE_SEPARATOR, { mode: 0o600 });

    return { removed, eventsFolded };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async _readAllLines(): Promise<string[]> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      return raw.split(LINE_SEPARATOR).filter((l) => l.trim().length > 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private _isFindingRecord(v: unknown): v is FindingRecord {
    return typeof v === 'object' && v !== null && (v as Record<string, unknown>)['__finding'] === 1;
  }

  private _isLifecycleEvent(v: unknown): v is LifecycleEventRecord {
    return (
      typeof v === 'object' && v !== null && (v as Record<string, unknown>)['__findingEvent'] === 1
    );
  }

  private async _readAll(): Promise<
    Array<{ finding: ChimeraFinding; events: FindingLifecycleEvent[] }>
  > {
    const lines = await this._readAllLines();
    const findings = new Map<string, ChimeraFinding>();
    const eventsMap = new Map<string, FindingLifecycleEvent[]>();

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (this._isFindingRecord(parsed)) {
          findings.set(parsed.data.id, parsed.data);
          if (!eventsMap.has(parsed.data.id)) eventsMap.set(parsed.data.id, []);
        } else if (this._isLifecycleEvent(parsed)) {
          const list = eventsMap.get(parsed.data.findingId);
          if (list) list.push(parsed.data);
        }
        // Compact markers are informational — skip for materialization.
      } catch {
        // Skip malformed lines.
      }
    }

    return Array.from(findings.entries()).map(([id, finding]) => ({
      finding,
      events: eventsMap.get(id) ?? [],
    }));
  }

  /** Materialize a finding's current status from its events. */
  private _materialize(entry: {
    finding: ChimeraFinding;
    events: FindingLifecycleEvent[];
  }): ChimeraFinding {
    if (entry.events.length === 0) return { ...entry.finding };

    // Events are already sorted by timestamp (appended in order).
    // The latest status event defines the materialized status.
    const sorted = [...entry.events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const latest = sorted[sorted.length - 1]!;
    return {
      ...entry.finding,
      status: latest.toStatus,
    };
  }

  private _makeEvent(
    findingId: string,
    eventType: FindingEventType,
    fromStatus: FindingStatus | null,
    toStatus: FindingStatus,
    context: UpsertContext,
  ): FindingLifecycleEvent {
    return {
      id: randomUUID(),
      findingId,
      eventType,
      fromStatus,
      toStatus,
      actorId: context.agentId,
      actorKind: 'agent',
      timestamp: new Date().toISOString(),
      reason: `session:${context.sessionId} report:${context.reportId}`,
    };
  }

  private _eventTypeFor(to: FindingStatus): FindingEventType {
    switch (to) {
      case 'triaged':
        return 'triaged';
      case 'in_progress':
        return 'started';
      case 'resolved':
        return 'resolved';
      case 'ignored':
        return 'ignored';
      case 'active':
        return 'reopened';
      default:
        return 'created';
    }
  }
}

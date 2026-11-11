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
import { SECRET_FILE_MODE } from '@wrongstack/core/security';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';
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
  /** Terminal findings (resolved/ignored) dropped by their own windows. */
  removedFindings: number;
  /**
   * Non-terminal findings (active/triaged/in_progress) dropped by the bounded
   * cap. Optional so markers written before that path existed still parse.
   */
  removedNonTerminalFindings?: number;
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
  /**
   * Bounded retention for findings that never reached a terminal status —
   * `active`, `triaged` and `in_progress` alike. Without it those rows are
   * immortal at any age, because the terminal rule above keys only on
   * `resolved`/`ignored`.
   *
   * Omit to preserve the historical contract exactly: a non-terminal finding is
   * never removed. Only the maintenance owner supplies a cap in production.
   * Age is measured from `createdAt`, the same basis the terminal rule uses.
   */
  nonTerminalMaxAgeMs?: number | undefined;
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
  /**
   * Drops `resolved`/`ignored` findings past their own 30d/14d windows, and —
   * only when `nonTerminalMaxAgeMs` is supplied — `active`/`triaged`/
   * `in_progress` findings past that cap. Omitting it preserves the historical
   * contract: a finding that was never resolved or ignored is never removed.
   */
  compact(opts?: CompactOptions): Promise<{
    removed: number;
    removedNonTerminal: number;
    eventsFolded: number;
  }>;
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

    return withFileLock(this.filePath, async () => {
      const existing = await this._readAll();
      for (const finding of newFindings) {
        const match = existing.find((e) => e.finding.fingerprint === finding.fingerprint);
        if (match) {
          // Materialize current status from events before checking reopen eligibility.
          // Operator-suppressed findings (`ignored`, or `resolved` as `wontfix` /
          // `false_positive`) stay suppressed on passive re-scans instead of
          // resurrecting as noisy false positives; genuinely `fixed` findings
          // reopen if the exact same fingerprint reappears later.
          const materialized = this._materialize(match);
          const suppressedOutcome = materialized.resolution?.outcome;
          const isOperatorSuppressed =
            materialized.status === 'ignored' ||
            (materialized.status === 'resolved' &&
              (suppressedOutcome === 'wontfix' || suppressedOutcome === 'false_positive'));
          if (
            !isOperatorSuppressed &&
            (materialized.status === 'resolved' || materialized.status === 'ignored')
          ) {
            const reopenEvent = this._makeEvent(
              match.finding.id,
              'reopened',
              materialized.status,
              'active',
              context,
            );
            match.finding.status = 'active';
            match.finding.resolution = undefined;
            match.events.push(reopenEvent);
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
              materialized.status,
              materialized.status,
              context,
            );
            match.events.push(relinkEvent);
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
          const createdEvent = this._makeEvent(
            finding.id,
            'created',
            null,
            finding.status ?? 'active',
            context,
          );
          const lines =
            JSON.stringify(record) +
            LINE_SEPARATOR +
            JSON.stringify({ __findingEvent: 1, data: createdEvent }) +
            LINE_SEPARATOR;
          await fsp.appendFile(this.filePath, lines, { encoding: 'utf8', mode: SECRET_FILE_MODE });
          // Track this batch's creations in-memory so later items with the
          // same fingerprint in the SAME upsert dedupe instead of creating
          // a second record.
          existing.push({ finding, events: [createdEvent] });
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
    return withFileLock(this.filePath, async () => {
      const all = await this._readAll();
      const entry = all.find((e) => e.finding.id === findingId);
      if (!entry) throw new Error(`Finding not found: ${findingId}`);

      const from = this._materialize(entry).status;
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
      } else if (to !== 'resolved') {
        entry.finding.resolution = undefined;
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
    });
  }

  async list(opts?: ListOptions): Promise<ChimeraFinding[]> {
    const all = await this._readAll();
    return this._selectEntries(all, opts).map((entry) => entry.finding);
  }

  /**
   * The same selection as {@link list}, with each finding's lifecycle events
   * attached from the SAME read.
   *
   * `list()` materializes findings only, so a caller that also needs the events
   * had to call `getEvents()` once per finding — and every `getEvents()` call
   * re-reads and re-parses the whole JSONL. One WebUI report-detail request
   * therefore cost `findings + 1` full file reads of the findings file.
   */
  async listWithEvents(
    opts?: ListOptions,
  ): Promise<Array<{ finding: ChimeraFinding; events: FindingLifecycleEvent[] }>> {
    const all = await this._readAll();
    return this._selectEntries(all, opts).map((entry) => ({
      finding: entry.finding,
      // `getEvents` returns events oldest-first; keep that response shape.
      events: [...entry.events].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    }));
  }

  /** Filter and order entries exactly like `list()`, over one `_readAll` result. */
  private _selectEntries(
    all: Array<{ finding: ChimeraFinding; events: FindingLifecycleEvent[] }>,
    opts?: ListOptions,
  ): Array<{ finding: ChimeraFinding; events: FindingLifecycleEvent[] }> {
    let entries = all.map((e) => ({ finding: this._materialize(e), events: e.events }));

    if (opts?.severities && opts.severities.length > 0) {
      const sevs = new Set(opts.severities);
      entries = entries.filter((e) => sevs.has(e.finding.severity));
    }
    if (opts?.statuses && opts.statuses.length > 0) {
      const sts = new Set(opts.statuses);
      entries = entries.filter((e) => sts.has(e.finding.status));
    }
    if (opts?.file) {
      const pattern = opts.file.toLowerCase();
      entries = entries.filter((e) => e.finding.location?.file.toLowerCase().includes(pattern));
    }
    if (opts?.reportId) {
      const reportId = opts.reportId;
      entries = entries.filter((e) => e.finding.originReport.reportId === reportId);
    }

    // Sort by severity (critical first), then by age (oldest first).
    const severityRank: Record<FindingSeverity, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    };
    entries.sort((a, b) => {
      const sa = severityRank[a.finding.severity] - severityRank[b.finding.severity];
      if (sa !== 0) return sa;
      return a.finding.createdAt.localeCompare(b.finding.createdAt);
    });

    const limit = opts?.limit ?? FINDING_DEFAULT_PAGE_SIZE;
    return entries.slice(0, limit);
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

  async compact(opts?: CompactOptions): Promise<{
    removed: number;
    removedNonTerminal: number;
    eventsFolded: number;
  }> {
    return withFileLock(this.filePath, async () => {
      const resolvedMaxAge = opts?.resolvedMaxAgeMs ?? FINDING_RESOLVED_RETENTION_MS;
      const ignoredMaxAge = opts?.ignoredMaxAgeMs ?? FINDING_IGNORED_RETENTION_MS;
      const nonTerminalMaxAge = opts?.nonTerminalMaxAgeMs;
      const now = Date.now();

      const all = await this._readAll();
      const kept: Array<{ record: FindingRecord | null; events: FindingLifecycleEvent[] }> = [];
      let removed = 0;
      let removedNonTerminal = 0;
      let eventsFolded = 0;

      for (const entry of all) {
        const materialized = this._materialize(entry);
        const age = now - new Date(materialized.createdAt).getTime();
        const isResolved = materialized.status === 'resolved';
        const isIgnored = materialized.status === 'ignored';
        const isTerminal = isResolved || isIgnored;
        const maxAge = isResolved ? resolvedMaxAge : isIgnored ? ignoredMaxAge : Infinity;

        if (age > maxAge && isTerminal) {
          removed++;
          eventsFolded += entry.events.length;
          continue;
        }

        // Bounded retention for `active`/`triaged`/`in_progress`. This branch is
        // guarded by `!isTerminal`, i.e. the exact complement of the rule above,
        // so a resolved or ignored finding can never be reached here and its
        // 30d/14d windows are unaffected.
        if (!isTerminal && nonTerminalMaxAge !== undefined && age > nonTerminalMaxAge) {
          removedNonTerminal++;
          eventsFolded += entry.events.length;
          continue;
        }

        // Fold events older than maxAge into a single compacted marker.
        const oldEvents = entry.events.filter(
          (ev) => now - new Date(ev.timestamp).getTime() > maxAge,
        );
        if (oldEvents.length > 1) {
          eventsFolded += oldEvents.length - 1;
          // Keep only the newest event before maxAge (fold the rest), breaking
          // same-millisecond timestamp ties by reverse append index.
          const newestOld = oldEvents
            .map((ev, index) => ({ ev, index }))
            .sort(
              (a, b) => b.ev.timestamp.localeCompare(a.ev.timestamp) || b.index - a.index,
            )[0]!.ev;
          entry.events = [
            newestOld,
            ...entry.events.filter((ev) => now - new Date(ev.timestamp).getTime() <= maxAge),
          ];
        }
        kept.push({ record: { __finding: 1, data: materialized }, events: entry.events });
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
          removedNonTerminalFindings: removedNonTerminal,
          foldedEvents: eventsFolded,
        } as CompactMarker),
      );

      await atomicWrite(this.filePath, lines.join(LINE_SEPARATOR) + LINE_SEPARATOR, {
        mode: 0o600,
      });

      return { removed, removedNonTerminal, eventsFolded };
    });
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

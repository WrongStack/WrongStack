/**
 * Chimera Review Report Store — persistent JSONL store with lifecycle tracking.
 *
 * Each completed Chimera review produces one ReviewReport record here. The
 * raw Markdown text is preserved (`rawText`) alongside structured metadata
 * (severity counts, files, duration, provenance) so reports can be browsed
 * and audited over time.
 *
 * Reports are linked to the finding store via the shared `id` field, which
 * equals each finding's `originReport.reportId`. The two stores have
 * independent lifecycles and retention windows.
 *
 * @module review-report-store
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { SECRET_FILE_MODE } from '@wrongstack/core/security';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';
import type {
  ReviewReport,
  ReviewReportCounts,
  ReviewReportEvent,
  ReviewReportFile,
} from './review-report-types.js';
import {
  type ReportActorKind,
  type ReportLifecycleStatus,
  reportEventTypeFor,
  validateReportTransition,
} from './review-report-types.js';
import type { CascadeEvidenceCheckResult, CascadeEvidenceStatus } from './review-types.js';

// ── Constants ──────────────────────────────────────────────────────

/** Default retention for completed/skipped reports (90 days in ms). */
export const REPORT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Max reports returned by list() without a limit. */
export const REPORT_DEFAULT_PAGE_SIZE = 25;

const NL = '\n';

/** File name for the report store JSONL file. */
export const REPORT_STORE_FILE = 'review-reports.jsonl';

/** Resolve the absolute path to the report store file. */
export function resolveReportStorePath(projectDir: string): string {
  return path.join(projectDir, REPORT_STORE_FILE);
}

// ── JSONL record types ────────────────────────────────────────────

interface ReportRecord {
  __report: 1;
  data: ReviewReport;
}

interface ReportEventRecord {
  __reportEvent: 1;
  data: ReviewReportEvent;
}

interface ReportCompactMarker {
  __reportCompact: 1;
  compactedAt: string;
  /** Terminal (completed/skipped) reports dropped by their own retention. */
  removedReports: number;
  /**
   * Non-terminal (`open`/`actioned`) reports dropped by the bounded-retention
   * path. Absent from stores last compacted before that path existed, so it
   * must stay optional.
   */
  removedNonTerminalReports?: number;
  foldedEvents: number;
}

// ── Persist input ─────────────────────────────────────────────────

/** Structured input for creating a report record. */
export interface PersistReportInput {
  /** Report UUID — should match the findings' originReport.reportId. */
  id: string;
  sessionId: string;
  agentId: string;
  reviewerModel: string;
  source: ReviewReport['source'];
  reviewStatus: 'success' | 'failed';
  files: ReviewReportFile[];
  counts: ReviewReportCounts;
  totalFindings: number;
  unparseableCount: number;
  durationSeconds?: number | undefined;
  rawText: string;
  cascadeDepth?: number | undefined;
  /** P0-3: cascade fix evidence status (verified/failed/missing). */
  evidenceStatus?: CascadeEvidenceStatus | undefined;
  /** P0-3: per-check claimed-vs-observed exit-code comparisons. */
  evidenceChecks?: CascadeEvidenceCheckResult[] | undefined;
  /** Token, cache, cost, and turn/tool telemetry recorded for this review. */
  usage?: import('./review-types.js').ReviewUsageMetrics | undefined;
  /** Structured manifest of reviewed/skipped files, deltas, and symbols. */
  scopeManifest?: import('./review-types.js').ReviewScopeManifest | undefined;
}

/** Context for who is creating/transitioning a report. */
export interface ReportActor {
  id: string;
  kind: ReportActorKind;
}

export interface ListReportsOptions {
  statuses?: ReportLifecycleStatus[] | undefined;
  sources?: ReviewReport['source'][] | undefined;
  limit?: number | undefined;
}

export interface ReportStore {
  persist(input: PersistReportInput): Promise<ReviewReport>;
  transition(
    reportId: string,
    to: ReportLifecycleStatus,
    actor: ReportActor,
    opts?: { reason?: string },
  ): Promise<ReviewReport>;
  addNote(reportId: string, actor: ReportActor, note: string): Promise<ReviewReport>;
  updateEvidence(
    reportId: string,
    evidenceStatus: CascadeEvidenceStatus,
    evidenceChecks: CascadeEvidenceCheckResult[],
  ): Promise<ReviewReport>;
  list(opts?: ListReportsOptions): Promise<ReviewReport[]>;
  get(id: string): Promise<ReviewReport | null>;
  getEvents(reportId: string): Promise<ReviewReportEvent[]>;
  /**
   * Drop terminal (completed/skipped) reports older than `maxAgeMs`, and — when
   * `nonTerminalMaxAgeMs` is supplied — drop non-terminal (`open`/`actioned`)
   * reports older than that cap. Omitting `nonTerminalMaxAgeMs` keeps the
   * historical contract: a report that was never closed out is never removed.
   */
  compact(opts?: {
    maxAgeMs?: number | undefined;
    nonTerminalMaxAgeMs?: number | undefined;
  }): Promise<{ removed: number; removedNonTerminal: number; eventsFolded: number }>;
}

// ── Implementation ─────────────────────────────────────────────────

export class JsonlReportStore implements ReportStore {
  private readonly filePath: string;

  constructor(projectDir: string) {
    this.filePath = resolveReportStorePath(projectDir);
  }

  get storePath(): string {
    return this.filePath;
  }

  // ── Persist (create or reopen) ───────────────────────────────────

  async persist(input: PersistReportInput): Promise<ReviewReport> {
    return withFileLock(this.filePath, async () => {
      const existing = await this._findRecord(input.id);

      if (existing) {
        // Report already persisted (e.g. cascade re-review of same reportId).
        // Update materialized counts/rawText but don't duplicate the created event.
        const updated: ReviewReport = {
          ...existing,
          counts: input.counts,
          totalFindings: input.totalFindings,
          unparseableCount: input.unparseableCount,
          durationSeconds: input.durationSeconds ?? existing.durationSeconds,
          rawText: input.rawText || existing.rawText,
          files: input.files.length > 0 ? input.files : existing.files,
          ...(input.evidenceStatus !== undefined ? { evidenceStatus: input.evidenceStatus } : {}),
          ...(input.evidenceChecks !== undefined ? { evidenceChecks: input.evidenceChecks } : {}),
          ...(input.usage !== undefined ? { usage: input.usage } : {}),
          ...(input.scopeManifest !== undefined ? { scopeManifest: input.scopeManifest } : {}),
        };
        await fsp.appendFile(this.filePath, JSON.stringify({ __report: 1, data: updated }) + NL, {
          encoding: 'utf8',
          mode: SECRET_FILE_MODE,
        });
        return updated;
      }

      const report: ReviewReport = {
        id: input.id,
        reviewedAt: new Date().toISOString(),
        sessionId: input.sessionId,
        agentId: input.agentId,
        reviewerModel: input.reviewerModel,
        source: input.source,
        reviewStatus: input.reviewStatus,
        lifecycle: 'open',
        files: input.files,
        counts: input.counts,
        totalFindings: input.totalFindings,
        unparseableCount: input.unparseableCount,
        durationSeconds: input.durationSeconds,
        rawText: input.rawText,
        ...(input.cascadeDepth !== undefined ? { cascadeDepth: input.cascadeDepth } : {}),
        ...(input.evidenceStatus !== undefined ? { evidenceStatus: input.evidenceStatus } : {}),
        ...(input.evidenceChecks !== undefined ? { evidenceChecks: input.evidenceChecks } : {}),
        ...(input.usage !== undefined ? { usage: input.usage } : {}),
        ...(input.scopeManifest !== undefined ? { scopeManifest: input.scopeManifest } : {}),
      };

      const createdEvent: ReviewReportEvent = {
        id: randomUUID(),
        reportId: report.id,
        eventType: 'created',
        fromLifecycle: null,
        toLifecycle: 'open',
        actorId: 'system',
        actorKind: 'system',
        timestamp: report.reviewedAt,
      };

      const lines =
        JSON.stringify({ __report: 1, data: report }) +
        NL +
        JSON.stringify({ __reportEvent: 1, data: createdEvent }) +
        NL;
      await fsp.appendFile(this.filePath, lines, { encoding: 'utf8', mode: SECRET_FILE_MODE });
      return report;
    });
  }

  // ── Lifecycle transitions ────────────────────────────────────────

  async transition(
    reportId: string,
    to: ReportLifecycleStatus,
    actor: ReportActor,
    opts?: { reason?: string },
  ): Promise<ReviewReport> {
    return withFileLock(this.filePath, async () => {
      const all = await this._readAll();
      const entry = all.find((e) => e.report.id === reportId);
      if (!entry) throw new Error(`Review report not found: ${reportId}`);

      // Materialize current lifecycle from events — the stored record's
      // lifecycle field is the original value (set at creation time); only
      // events reflect subsequent transitions.
      const from = this._materialize(entry).lifecycle;
      validateReportTransition(from, to);

      const event: ReviewReportEvent = {
        id: randomUUID(),
        reportId,
        eventType: reportEventTypeFor(to),
        fromLifecycle: from,
        toLifecycle: to,
        actorId: actor.id,
        actorKind: actor.kind,
        timestamp: new Date().toISOString(),
        reason: opts?.reason,
      };

      entry.report.lifecycle = to;

      await fsp.appendFile(this.filePath, JSON.stringify({ __reportEvent: 1, data: event }) + NL, {
        encoding: 'utf8',
        mode: SECRET_FILE_MODE,
      });

      return { ...entry.report };
    });
  }

  async updateEvidence(
    reportId: string,
    status: CascadeEvidenceStatus,
    checks: CascadeEvidenceCheckResult[],
  ): Promise<ReviewReport> {
    return withFileLock(this.filePath, async () => {
      const all = await this._readAll();
      const entry = all.find((candidate) => candidate.report.id === reportId);
      if (!entry) throw new Error(`Review report not found: ${reportId}`);

      const updated: ReviewReport = {
        ...this._materialize(entry),
        evidenceStatus: status,
        evidenceChecks: checks,
      };
      await fsp.appendFile(
        this.filePath,
        `${JSON.stringify({ __report: 1, data: updated })}${NL}`,
        { encoding: 'utf8', mode: SECRET_FILE_MODE },
      );
      return updated;
    });
  }

  async addNote(reportId: string, actor: ReportActor, note: string): Promise<ReviewReport> {
    return withFileLock(this.filePath, async () => {
      const all = await this._readAll();
      const entry = all.find((e) => e.report.id === reportId);
      if (!entry) throw new Error(`Review report not found: ${reportId}`);

      const materialized = this._materialize(entry);
      const event: ReviewReportEvent = {
        id: randomUUID(),
        reportId,
        eventType: 'note_added',
        fromLifecycle: materialized.lifecycle,
        toLifecycle: materialized.lifecycle,
        actorId: actor.id,
        actorKind: actor.kind,
        timestamp: new Date().toISOString(),
        reason: note,
      };

      await fsp.appendFile(this.filePath, JSON.stringify({ __reportEvent: 1, data: event }) + NL, {
        encoding: 'utf8',
        mode: SECRET_FILE_MODE,
      });

      return materialized;
    });
  }

  // ── Query ────────────────────────────────────────────────────────

  async list(opts?: ListReportsOptions): Promise<ReviewReport[]> {
    const all = await this._readAll();
    let reports = all.map((e) => this._materialize(e));

    if (opts?.statuses && opts.statuses.length > 0) {
      const set = new Set(opts.statuses);
      reports = reports.filter((r) => set.has(r.lifecycle));
    }
    if (opts?.sources && opts.sources.length > 0) {
      const set = new Set(opts.sources);
      reports = reports.filter((r) => set.has(r.source));
    }

    // Sort newest first.
    reports.sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));

    const limit = opts?.limit ?? REPORT_DEFAULT_PAGE_SIZE;
    return reports.slice(0, limit);
  }

  async get(id: string): Promise<ReviewReport | null> {
    const all = await this._readAll();
    const entry = all.find((e) => e.report.id === id);
    return entry ? this._materialize(entry) : null;
  }

  async getEvents(reportId: string): Promise<ReviewReportEvent[]> {
    const all = await this._readAllLines();
    const events: ReviewReportEvent[] = [];
    for (const line of all) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (this._isEventRecord(parsed) && parsed.data.reportId === reportId) {
          events.push(parsed.data);
        }
      } catch {
        // skip malformed
      }
    }
    return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  // ── Compaction ───────────────────────────────────────────────────

  async compact(opts?: {
    maxAgeMs?: number;
    nonTerminalMaxAgeMs?: number;
  }): Promise<{ removed: number; removedNonTerminal: number; eventsFolded: number }> {
    return withFileLock(this.filePath, async () => {
      const maxAge = opts?.maxAgeMs ?? REPORT_RETENTION_MS;
      // Bounded retention for reports that never reached a terminal state.
      // Left undefined, the historical behavior is preserved exactly: an
      // `open`/`actioned` report is kept at any age. Only the maintenance
      // owner (review-store-maintenance.ts) supplies a cap in production.
      const nonTerminalMaxAge = opts?.nonTerminalMaxAgeMs;
      const now = Date.now();

      const all = await this._readAll();
      const kept: Array<{ record: ReportRecord | null; events: ReviewReportEvent[] }> = [];
      let removed = 0;
      let removedNonTerminal = 0;
      let eventsFolded = 0;

      for (const entry of all) {
        const age = now - new Date(entry.report.reviewedAt).getTime();
        const materialized = this._materialize(entry);
        const isTerminal =
          materialized.lifecycle === 'completed' || materialized.lifecycle === 'skipped';

        if (isTerminal && age > maxAge) {
          removed++;
          eventsFolded += entry.events.length;
          continue;
        }

        if (!isTerminal && nonTerminalMaxAge !== undefined && age > nonTerminalMaxAge) {
          removedNonTerminal++;
          eventsFolded += entry.events.length;
          continue;
        }

        // Fold old events down to bound the file. The current lifecycle is
        // materialized from the last NON-`note_added` event (the stored record
        // is frozen at creation), so keeping only the newest old event could
        // discard the one that determines it whenever a note was newer — the
        // report then silently reverted to its creation-time value. Retain the
        // newest old event AND the newest old lifecycle event.
        const oldEvents = entry.events.filter(
          (ev) => now - new Date(ev.timestamp).getTime() > maxAge,
        );
        if (oldEvents.length > 1) {
          // `oldEvents` is in file (append) order, so the newest lifecycle event
          // must be picked from the newest-first view — scanning the raw array
          // would return the OLDEST one and resurrect the creation-time value.
          // Timestamps are millisecond ISO strings: `created` and the first
          // transition often share one, and a stable descending sort then
          // ranks `created` first. Append order breaks the tie, as it does in
          // `_materialize`.
          const newestFirst = oldEvents
            .map((ev, index) => ({ ev, index }))
            .sort((a, b) => b.ev.timestamp.localeCompare(a.ev.timestamp) || b.index - a.index)
            .map(({ ev }) => ev);
          const newestOld = newestFirst[0]!;
          const newestOldLifecycle = newestFirst.find((ev) => ev.eventType !== 'note_added');
          const survivors =
            newestOldLifecycle && newestOldLifecycle.id !== newestOld.id
              ? [newestOldLifecycle, newestOld]
              : [newestOld];
          eventsFolded += oldEvents.length - survivors.length;
          entry.events = [
            ...survivors.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
            ...entry.events.filter((ev) => now - new Date(ev.timestamp).getTime() <= maxAge),
          ];
        }
        kept.push({ record: { __report: 1, data: entry.report }, events: entry.events });
      }

      const lines: string[] = [];
      for (const { record, events } of kept) {
        if (record) lines.push(JSON.stringify(record));
        for (const ev of events) {
          lines.push(JSON.stringify({ __reportEvent: 1, data: ev }));
        }
      }
      lines.push(
        JSON.stringify({
          __reportCompact: 1,
          compactedAt: new Date().toISOString(),
          removedReports: removed,
          removedNonTerminalReports: removedNonTerminal,
          foldedEvents: eventsFolded,
        } as ReportCompactMarker),
      );

      await atomicWrite(this.filePath, lines.join(NL) + NL, { mode: 0o600 });
      return { removed, removedNonTerminal, eventsFolded };
    });
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async _readAllLines(): Promise<string[]> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      return raw.split(NL).filter((l) => l.trim().length > 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private _isReportRecord(v: unknown): v is ReportRecord {
    return typeof v === 'object' && v !== null && (v as Record<string, unknown>)['__report'] === 1;
  }

  private _isEventRecord(v: unknown): v is ReportEventRecord {
    return (
      typeof v === 'object' && v !== null && (v as Record<string, unknown>)['__reportEvent'] === 1
    );
  }

  private async _readAll(): Promise<Array<{ report: ReviewReport; events: ReviewReportEvent[] }>> {
    const lines = await this._readAllLines();
    const reports = new Map<string, ReviewReport>();
    const eventsMap = new Map<string, ReviewReportEvent[]>();

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (this._isReportRecord(parsed)) {
          reports.set(parsed.data.id, parsed.data);
          if (!eventsMap.has(parsed.data.id)) eventsMap.set(parsed.data.id, []);
        } else if (this._isEventRecord(parsed)) {
          const list = eventsMap.get(parsed.data.reportId);
          if (list) list.push(parsed.data);
        }
      } catch {
        // skip malformed
      }
    }

    return Array.from(reports.entries()).map(([id, report]) => ({
      report,
      events: eventsMap.get(id) ?? [],
    }));
  }

  private async _findRecord(id: string): Promise<ReviewReport | null> {
    const all = await this._readAll();
    const entry = all.find((e) => e.report.id === id);
    return entry ? this._materialize(entry) : null;
  }

  private _materialize(entry: { report: ReviewReport; events: ReviewReportEvent[] }): ReviewReport {
    if (entry.events.length === 0) return { ...entry.report };
    const sorted = [...entry.events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    // A `note_added` event is an annotation, not a transition, so the current
    // lifecycle comes from the LAST LIFECYCLE event. Checking only whether the
    // single latest event is a note discarded every earlier real transition —
    // and because the stored record's lifecycle is frozen at creation
    // (`transition` only appends an event, it never rewrites the record), a
    // completed report that had a note added afterwards read back as "open".
    for (let i = sorted.length - 1; i >= 0; i--) {
      const event = sorted[i]!;
      if (event.eventType !== 'note_added') {
        return { ...entry.report, lifecycle: event.toLifecycle };
      }
    }
    return { ...entry.report };
  }
}

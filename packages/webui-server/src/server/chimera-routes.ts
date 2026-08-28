/**
 * Chimera review-report routes — the session-scoped and project-wide view
 * of persisted Chimera review reports, findings, and event journals.
 *
 * Wire shape:
 *   client → `chimera.reports.list`       { sessionId?: string, all?: boolean, lifecycle?: string, limit?: number }
 *   server → `chimera.reports`            { sessionId, reports: [...] }
 *   client → `chimera.report.get`         { reportId }
 *   server → `chimera.report.detail`      { report, findings, events, error?: string }
 *   client → `chimera.report.transition`  { reportId, to, reason?: string }
 *   server → `chimera.report.updated`     { reportId, lifecycle, success: boolean, error?: string }
 *   client → `chimera.report.add_note`    { reportId, note: string }
 *   server → `chimera.report.note_added`  { reportId, success: boolean, error?: string }
 *   client → `chimera.finding.transition` { findingId, to, outcome?: string, reason?: string }
 *   server → `chimera.finding.updated`    { findingId, status, success: boolean, error?: string }
 */
import {
  JsonlFindingStore,
  JsonlReportStore,
  syncReportCompletion,
  syncReportReopen,
  type ChimeraFinding,
  type FindingLifecycleEvent,
  type FindingStatus,
  type ReportLifecycleStatus,
  type ResolutionOutcome,
  type ReviewReport,
  type ReviewReportCounts,
  type ReviewReportEvent,
} from '@wrongstack/core/plugin';
import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';

export interface ChimeraRouteHandlers {
  listReports: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  getReport?: ((ws: WebSocket, msg: WSClientMessage) => Promise<void>) | undefined;
  transitionReport?: ((ws: WebSocket, msg: WSClientMessage) => Promise<void>) | undefined;
  addReportNote?: ((ws: WebSocket, msg: WSClientMessage) => Promise<void>) | undefined;
  transitionFinding?: ((ws: WebSocket, msg: WSClientMessage) => Promise<void>) | undefined;
}

export async function handleChimeraRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: ChimeraRouteHandlers,
): Promise<boolean> {
  if (msg.type === 'chimera.reports.list' || msg.type === 'chimera.reports.query') {
    await handlers.listReports(ws, msg);
    return true;
  }
  if (msg.type === 'chimera.report.get') {
    if (handlers.getReport) {
      await handlers.getReport(ws, msg);
    }
    return true;
  }
  if (msg.type === 'chimera.report.transition') {
    if (handlers.transitionReport) {
      await handlers.transitionReport(ws, msg);
    }
    return true;
  }
  if (msg.type === 'chimera.report.add_note') {
    if (handlers.addReportNote) {
      await handlers.addReportNote(ws, msg);
    }
    return true;
  }
  if (msg.type === 'chimera.finding.transition') {
    if (handlers.transitionFinding) {
      await handlers.transitionFinding(ws, msg);
    }
    return true;
  }
  return false;
}

/** One report row on the wire. */
export interface ChimeraReportSummary {
  reportId: string;
  sessionId: string;
  agentId?: string | undefined;
  reviewedAt: string;
  reviewerModel?: string | undefined;
  source?: string | undefined;
  reviewStatus?: 'success' | 'failed' | undefined;
  lifecycleStatus: string;
  counts?: ReviewReportCounts | undefined;
  totalFindings: number;
  fileCount?: number | undefined;
  durationSeconds?: number | undefined;
  cascadeDepth?: number | undefined;
  evidenceStatus?: string | undefined;
  /** Mirrors `pending`: the client backfills cards for actionable rows. */
  hasActionableFindings: boolean;
}

/**
 * A report still asks for attention until its findings are closed out.
 * `completed`/`skipped` are terminal: nobody needs to be nudged about them.
 */
export function isPendingChimeraReport(report: {
  lifecycle: string;
  totalFindings: number;
}): boolean {
  return (
    report.totalFindings > 0 &&
    report.lifecycle !== 'completed' &&
    report.lifecycle !== 'skipped'
  );
}

/**
 * List one session's pending persisted review reports, newest first.
 * Pure over the store — unit-testable without a WebSocket.
 */
export async function listChimeraReportsForSession(
  projectDir: string,
  sessionId: string,
  limit = 10,
): Promise<ChimeraReportSummary[]> {
  if (!sessionId) return [];
  const store = new JsonlReportStore(projectDir);
  const reports = await store.list({ limit: 200 });
  return reports
    .filter((r) => r.sessionId === sessionId && isPendingChimeraReport(r))
    .sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt))
    .slice(0, limit)
    .map((r) => {
      const pending = isPendingChimeraReport(r);
      return {
        reportId: r.id,
        sessionId: r.sessionId,
        agentId: r.agentId,
        reviewedAt: r.reviewedAt,
        reviewerModel: r.reviewerModel,
        source: r.source,
        reviewStatus: r.reviewStatus,
        lifecycleStatus: r.lifecycle,
        counts: r.counts,
        totalFindings: r.totalFindings,
        fileCount: r.files?.length ?? 0,
        durationSeconds: r.durationSeconds,
        cascadeDepth: r.cascadeDepth,
        evidenceStatus: r.evidenceStatus,
        hasActionableFindings: pending,
      };
    });
}

/**
 * Query all reports across sessions with optional filters.
 */
export async function queryAllChimeraReports(
  projectDir: string,
  opts?: {
    sessionId?: string | undefined;
    lifecycle?: string | undefined;
    limit?: number | undefined;
  },
): Promise<ChimeraReportSummary[]> {
  const store = new JsonlReportStore(projectDir);
  const statuses = opts?.lifecycle
    ? [opts.lifecycle as ReportLifecycleStatus]
    : undefined;
  const reports = await store.list({
    ...(statuses ? { statuses } : {}),
    limit: opts?.limit ?? 200,
  });

  return reports
    .filter((r) => !opts?.sessionId || r.sessionId === opts.sessionId)
    .sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt))
    .map((r) => ({
      reportId: r.id,
      sessionId: r.sessionId,
      agentId: r.agentId,
      reviewedAt: r.reviewedAt,
      reviewerModel: r.reviewerModel,
      source: r.source,
      reviewStatus: r.reviewStatus,
      lifecycleStatus: r.lifecycle,
      counts: r.counts,
      totalFindings: r.totalFindings,
      fileCount: r.files?.length ?? 0,
      durationSeconds: r.durationSeconds,
      cascadeDepth: r.cascadeDepth,
      evidenceStatus: r.evidenceStatus,
      hasActionableFindings: isPendingChimeraReport(r),
    }));
}

/** Finding with its lifecycle events attached for detail view. */
export interface FindingWithEvents {
  finding: ChimeraFinding;
  events: FindingLifecycleEvent[];
}

/** Full report detail payload. */
export interface ChimeraReportDetail {
  report: ReviewReport | null;
  findings: FindingWithEvents[];
  events: ReviewReportEvent[];
}

/** Build the route handlers. `projectDir` is read lazily: project switches re-root it. */
export function createChimeraRouteHandlers(deps: {
  projectDir: () => string;
  send: (ws: WebSocket, msg: { type: string; payload: unknown }) => void;
  log?: ((message: string) => void) | undefined;
}): ChimeraRouteHandlers {
  return {
    listReports: async (ws, msg) => {
      const payload = (msg.payload ?? {}) as {
        sessionId?: unknown;
        all?: unknown;
        lifecycle?: unknown;
        limit?: unknown;
      };
      const rawSessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
      const isAllQuery = payload.all === true || msg.type === 'chimera.reports.query' || payload.lifecycle != null;
      const limit = typeof payload.limit === 'number' ? payload.limit : 50;

      if (!rawSessionId && !isAllQuery) return; // untagged single-tab request names no tab

      try {
        if (isAllQuery) {
          const reports = await queryAllChimeraReports(deps.projectDir(), {
            sessionId: rawSessionId || undefined,
            lifecycle: typeof payload.lifecycle === 'string' ? payload.lifecycle : undefined,
            limit,
          });
          deps.send(ws, {
            type: 'chimera.reports',
            payload: { sessionId: rawSessionId, reports, isQuery: true },
          });
        } else {
          const reports = await listChimeraReportsForSession(deps.projectDir(), rawSessionId, limit);
          deps.send(ws, { type: 'chimera.reports', payload: { sessionId: rawSessionId, reports } });
        }
      } catch (err) {
        deps.log?.(`chimera.reports.list failed: ${err instanceof Error ? err.message : String(err)}`);
        deps.send(ws, { type: 'chimera.reports', payload: { sessionId: rawSessionId, reports: [] } });
      }
    },

    getReport: async (ws, msg) => {
      const payload = (msg.payload ?? {}) as { reportId?: unknown };
      const reportId = typeof payload.reportId === 'string' ? payload.reportId : '';
      if (!reportId) {
        deps.send(ws, {
          type: 'chimera.report.detail',
          payload: { report: null, findings: [], events: [], error: 'reportId is required' },
        });
        return;
      }

      try {
        const projectDir = deps.projectDir();
        const reportStore = new JsonlReportStore(projectDir);
        const findingStore = new JsonlFindingStore(projectDir);

        const report = await reportStore.get(reportId);
        if (!report) {
          deps.send(ws, {
            type: 'chimera.report.detail',
            payload: { report: null, findings: [], events: [], error: `Report not found: ${reportId}` },
          });
          return;
        }

        const events = await reportStore.getEvents(reportId);
        const rawFindings = await findingStore.list({ reportId, limit: 9999 });

        const findings: FindingWithEvents[] = await Promise.all(
          rawFindings.map(async (finding) => {
            const fEvents = await findingStore.getEvents(finding.id);
            return { finding, events: fEvents };
          }),
        );

        deps.send(ws, {
          type: 'chimera.report.detail',
          payload: { report, findings, events },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log?.(`chimera.report.get failed: ${message}`);
        deps.send(ws, {
          type: 'chimera.report.detail',
          payload: { report: null, findings: [], events: [], error: message },
        });
      }
    },

    transitionReport: async (ws, msg) => {
      const payload = (msg.payload ?? {}) as {
        reportId?: unknown;
        to?: unknown;
        reason?: unknown;
      };
      const reportId = typeof payload.reportId === 'string' ? payload.reportId : '';
      const to = typeof payload.to === 'string' ? (payload.to as ReportLifecycleStatus) : null;
      const reason = typeof payload.reason === 'string' ? payload.reason : undefined;

      if (!reportId || !to) {
        deps.send(ws, {
          type: 'chimera.report.updated',
          payload: { reportId, success: false, error: 'reportId and to status are required' },
        });
        return;
      }

      try {
        const store = new JsonlReportStore(deps.projectDir());
        await store.transition(
          reportId,
          to,
          { id: 'operator', kind: 'operator' },
          { ...(reason ? { reason } : {}) },
        );
        deps.send(ws, {
          type: 'chimera.report.updated',
          payload: { reportId, lifecycle: to, success: true },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log?.(`chimera.report.transition failed: ${message}`);
        deps.send(ws, {
          type: 'chimera.report.updated',
          payload: { reportId, success: false, error: message },
        });
      }
    },

    addReportNote: async (ws, msg) => {
      const payload = (msg.payload ?? {}) as {
        reportId?: unknown;
        note?: unknown;
      };
      const reportId = typeof payload.reportId === 'string' ? payload.reportId : '';
      const note = typeof payload.note === 'string' ? payload.note.trim() : '';

      if (!reportId || !note) {
        deps.send(ws, {
          type: 'chimera.report.note_added',
          payload: { reportId, success: false, error: 'reportId and note are required' },
        });
        return;
      }

      try {
        const store = new JsonlReportStore(deps.projectDir());
        await store.addNote(reportId, { id: 'operator', kind: 'operator' }, note);
        deps.send(ws, {
          type: 'chimera.report.note_added',
          payload: { reportId, success: true },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log?.(`chimera.report.add_note failed: ${message}`);
        deps.send(ws, {
          type: 'chimera.report.note_added',
          payload: { reportId, success: false, error: message },
        });
      }
    },

    transitionFinding: async (ws, msg) => {
      const payload = (msg.payload ?? {}) as {
        findingId?: unknown;
        to?: unknown;
        outcome?: unknown;
        reason?: unknown;
      };
      const findingId = typeof payload.findingId === 'string' ? payload.findingId : '';
      const to = typeof payload.to === 'string' ? (payload.to as FindingStatus) : null;
      const outcome = typeof payload.outcome === 'string' ? (payload.outcome as ResolutionOutcome) : undefined;
      const reason = typeof payload.reason === 'string' ? payload.reason : undefined;

      if (!findingId || !to) {
        deps.send(ws, {
          type: 'chimera.finding.updated',
          payload: { findingId, success: false, error: 'findingId and to status are required' },
        });
        return;
      }

      try {
        const projectDir = deps.projectDir();
        const store = new JsonlFindingStore(projectDir);
        const finding = await store.get(findingId);
        if (!finding) {
          deps.send(ws, {
            type: 'chimera.finding.updated',
            payload: { findingId, success: false, error: `Finding not found: ${findingId}` },
          });
          return;
        }

        await store.transition(
          findingId,
          to,
          { id: 'operator', kind: 'operator' },
          {
            ...(reason ? { reason } : {}),
            ...(outcome ? { outcome } : {}),
          },
        );

        // Auto-sync parent report
        const reportId = finding.originReport?.reportId;
        if (reportId) {
          try {
            if (to === 'resolved' || to === 'ignored') {
              await syncReportCompletion(reportId, projectDir, { id: 'operator', kind: 'operator' });
            } else if (to === 'active') {
              await syncReportReopen(reportId, projectDir, { id: 'operator', kind: 'operator' }, reason);
            }
          } catch {
            // best-effort sync
          }
        }

        deps.send(ws, {
          type: 'chimera.finding.updated',
          payload: { findingId, status: to, success: true },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log?.(`chimera.finding.transition failed: ${message}`);
        deps.send(ws, {
          type: 'chimera.finding.updated',
          payload: { findingId, success: false, error: message },
        });
      }
    },
  };
}

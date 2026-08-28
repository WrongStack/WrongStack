/**
 * Chimera review-report routes — the session-scoped, mailbox-independent view
 * of persisted Chimera review reports.
 *
 * The CLI persists every completed Chimera review to
 * `~/.wrongstack/projects/<slug>/review-reports.jsonl` (JsonlReportStore).
 * These routes let a WebUI tab ask "which actionable reports exist for MY
 * session?" without going near the mailbox, so the chat surface can keep
 * showing actionable report cards after the live `chimera.report_available`
 * event is long gone (tab reopened, page refreshed, lanes were full).
 *
 * Wire shape:
 *   client → `chimera.reports.list`  { sessionId }
 *   server → `chimera.reports`       { sessionId, reports: [...] }
 */
import { JsonlReportStore } from '@wrongstack/core/plugins/review-report-store';
import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';

export interface ChimeraRouteHandlers {
  listReports: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
}

export async function handleChimeraRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: ChimeraRouteHandlers,
): Promise<boolean> {
  if (msg.type !== 'chimera.reports.list') return false;
  await handlers.listReports(ws, msg);
  return true;
}

/** One report row on the wire — everything the chat card needs, nothing else. */
export interface ChimeraReportSummary {
  reportId: string;
  reviewedAt: string;
  lifecycleStatus: string;
  totalFindings: number;
  /** Mirrors `pending`: the client only backfills cards for actionable rows. */
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
        reviewedAt: r.reviewedAt,
        lifecycleStatus: r.lifecycle,
        totalFindings: r.totalFindings,
        hasActionableFindings: pending,
      };
    });
}

/** Build the route handlers. `projectDir` is read lazily: project switches re-root it. */
export function createChimeraRouteHandlers(deps: {
  projectDir: () => string;
  send: (ws: WebSocket, msg: { type: string; payload: unknown }) => void;
  log?: ((message: string) => void) | undefined;
}): ChimeraRouteHandlers {
  return {
    listReports: async (ws, msg) => {
      const payload = (msg.payload ?? {}) as { sessionId?: unknown };
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
      if (!sessionId) return; // untagged request names no tab — nothing to list
      try {
        const reports = await listChimeraReportsForSession(deps.projectDir(), sessionId);
        deps.send(ws, { type: 'chimera.reports', payload: { sessionId, reports } });
      } catch (err) {
        // The list is an enhancement; a missing/corrupt store must not raise
        // an error surface in the tab — answer with "nothing pending" instead.
        deps.log?.(`chimera.reports.list failed: ${err instanceof Error ? err.message : String(err)}`);
        deps.send(ws, { type: 'chimera.reports', payload: { sessionId, reports: [] } });
      }
    },
  };
}

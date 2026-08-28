/**
 * chimera-reports-store.ts — Per-session registry of Chimera review reports.
 *
 * ONE LIST PER TAB. A Chimera report names the session it reviewed, so it
 * belongs to that session's tab and to no other — the same positive-routing
 * rule the chat lanes follow. This store is the identity/bookkeeping layer:
 * the transcript card is the visible surface, while this store dedupes by
 * reportId so a live `chimera.report_available` event and a `chimera.reports`
 * hydration response never produce two cards for one report, and it remembers
 * which reports the user already actioned.
 *
 * Why a store at all (and not just lane messages): a report can arrive while
 * its session's lane does not exist yet or all four lane slots are taken;
 * the registry keeps it addressable so the next tab activation can
 * re-materialize the card from the server's persisted list.
 */

import { create } from 'zustand';

/** One surfacable Chimera review report for a session tab. */
export interface ChimeraReportNotice {
  /** Review run id — the dedupe key within a session. */
  reportId: string;
  sessionId: string;
  /** Human-readable summary from the live event (generic text when hydrated). */
  message: string;
  findingCount: number;
  fileCount: number;
  hasActionableFindings: boolean;
  /** ms epoch — arrival time (event) or review completion time (hydration). */
  receivedAt: number;
  /** When this tab's one-click prompt was sent to the leader; null until then. */
  actionedAt: number | null;
  /** Where the notice came from: the live event or a server list hydration. */
  source: 'event' | 'hydrate';
}

interface ChimeraReportsState {
  bySession: Record<string, ChimeraReportNotice[]>;
  /** Record a report. Returns false when the reportId is already known. */
  recordReport: (notice: ChimeraReportNotice) => boolean;
  markActioned: (sessionId: string, reportId: string, at: number) => void;
  /** Merge server-hydrated reports; unknown reportIds only, never clobbers actionedAt. */
  hydrateReports: (sessionId: string, notices: ChimeraReportNotice[]) => void;
  forgetSession: (sessionId: string) => void;
}

export const useChimeraReportsStore = create<ChimeraReportsState>()((set, get) => ({
  bySession: {},

  recordReport: (notice) => {
    if (!notice.reportId) return false;
    const existing = get().bySession[notice.sessionId];
    if (existing?.some((r) => r.reportId === notice.reportId)) return false;
    set((s) => ({
      bySession: {
        ...s.bySession,
        [notice.sessionId]: [...(s.bySession[notice.sessionId] ?? []), notice],
      },
    }));
    return true;
  },

  markActioned: (sessionId, reportId, at) => {
    set((s) => {
      const list = s.bySession[sessionId];
      if (!list?.some((r) => r.reportId === reportId)) return s;
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: list.map((r) =>
            r.reportId === reportId ? { ...r, actionedAt: r.actionedAt ?? at } : r,
          ),
        },
      };
    });
  },

  hydrateReports: (sessionId, notices) => {
    if (notices.length === 0) return;
    set((s) => {
      const known = new Set((s.bySession[sessionId] ?? []).map((r) => r.reportId));
      const fresh = notices.filter((n) => n.reportId && !known.has(n.reportId));
      if (fresh.length === 0) return s;
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: [...(s.bySession[sessionId] ?? []), ...fresh],
        },
      };
    });
  },

  forgetSession: (sessionId) => {
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  },
}));

const EMPTY_NOTICES: ChimeraReportNotice[] = [];

/** The reports known for one session tab (never undefined; stable when empty). */
export function useSessionChimeraReports(
  sessionId: string | null | undefined,
): ChimeraReportNotice[] {
  return (
    useChimeraReportsStore((s) => (sessionId ? s.bySession[sessionId] : undefined)) ??
    EMPTY_NOTICES
  );
}

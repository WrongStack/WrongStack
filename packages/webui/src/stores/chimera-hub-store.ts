import { create } from 'zustand';
import { getWSClient } from '@/lib/ws-client';

export interface ChimeraReportSummaryItem {
  reportId: string;
  sessionId: string;
  agentId?: string | undefined;
  reviewedAt: string;
  reviewerModel?: string | undefined;
  source?: string | undefined;
  reviewStatus?: 'success' | 'failed' | undefined;
  lifecycleStatus: string;
  counts?: { critical: number; high: number; medium: number; low: number } | undefined;
  totalFindings: number;
  fileCount?: number | undefined;
  durationSeconds?: number | undefined;
  cascadeDepth?: number | undefined;
  evidenceStatus?: string | undefined;
  hasActionableFindings?: boolean | undefined;
}

export interface FindingDetailItem {
  finding: {
    id: string;
    fingerprint: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    source: string;
    location?: { file: string; line?: number | undefined } | undefined;
    category?: string | undefined;
    confidence?: string | undefined;
    verification?: { status: string; reason: string; evidence?: string | undefined } | undefined;
    title: string;
    description: string;
    suggestedFix?: string | undefined;
    createdAt: string;
    status: string;
    resolution?: { outcome: string; resolvedAt: string; resolvedBy: string; commitSha?: string | undefined; notes?: string | undefined } | undefined;
    originReport: { reportId: string; sessionId: string; agentId: string; reviewerModel: string };
  };
  events: Array<{
    id: string;
    findingId: string;
    eventType: string;
    fromStatus: string | null;
    toStatus: string;
    actorId: string;
    actorKind: string;
    timestamp: string;
    reason?: string | undefined;
  }>;
}

export interface ChimeraReportFullDetail {
  report: {
    id: string;
    reviewedAt: string;
    sessionId: string;
    agentId: string;
    reviewerModel: string;
    source: string;
    reviewStatus: 'success' | 'failed';
    lifecycle: string;
    files: Array<{ path: string; status: string }>;
    counts: { critical: number; high: number; medium: number; low: number };
    totalFindings: number;
    unparseableCount: number;
    durationSeconds?: number | undefined;
    rawText: string;
    cascadeDepth?: number | undefined;
    evidenceStatus?: string | undefined;
    evidenceChecks?: Array<{ name: string; command: string; ok: boolean; claimedExitCode?: number | null; actualExitCode?: number | null }> | undefined;
  } | null;
  findings: FindingDetailItem[];
  events: Array<{
    id: string;
    reportId: string;
    eventType: string;
    fromLifecycle: string | null;
    toLifecycle: string;
    actorId: string;
    actorKind: string;
    timestamp: string;
    reason?: string | undefined;
  }>;
}

interface ChimeraHubState {
  reports: ChimeraReportSummaryItem[];
  selectedReportId: string | null;
  detail: ChimeraReportFullDetail | null;
  loading: boolean;
  detailLoading: boolean;
  error: string | null;
  filterSessionId: string;
  filterLifecycle: string;
  searchQuery: string;

  fetchReports: () => void;
  selectReport: (reportId: string | null) => void;
  setFilterSessionId: (sessionId: string) => void;
  setFilterLifecycle: (lifecycle: string) => void;
  setSearchQuery: (query: string) => void;
  transitionReport: (reportId: string, to: string, reason?: string) => void;
  addReportNote: (reportId: string, note: string) => void;
  transitionFinding: (findingId: string, to: string, outcome?: string, reason?: string) => void;
}

let handlersInstalled = false;

export function ensureChimeraHubHandlersInstalled(): void {
  if (handlersInstalled) return;
  const client = getWSClient();
  if (!client) return;

  client.on('chimera.reports', (msg: unknown) => {
    const payload = (msg as { payload: { reports: ChimeraReportSummaryItem[]; isQuery?: boolean } }).payload;
    if (payload?.isQuery || payload?.reports) {
      useChimeraHubStore.setState({
        reports: payload.reports ?? [],
        loading: false,
      });
    }
  });

  client.on('chimera.report.detail', (msg: unknown) => {
    const payload = (msg as { payload: ChimeraReportFullDetail & { error?: string } }).payload;
    useChimeraHubStore.setState({
      detail: payload.error ? null : payload,
      error: payload.error ?? null,
      detailLoading: false,
    });
  });

  client.on('chimera.report.updated', () => {
    useChimeraHubStore.getState().fetchReports();
    const cur = useChimeraHubStore.getState().selectedReportId;
    if (cur) useChimeraHubStore.getState().selectReport(cur);
  });

  client.on('chimera.report.note_added', () => {
    const cur = useChimeraHubStore.getState().selectedReportId;
    if (cur) useChimeraHubStore.getState().selectReport(cur);
  });

  client.on('chimera.finding.updated', () => {
    useChimeraHubStore.getState().fetchReports();
    const cur = useChimeraHubStore.getState().selectedReportId;
    if (cur) useChimeraHubStore.getState().selectReport(cur);
  });

  client.on('chimera.report_available', () => {
    useChimeraHubStore.getState().fetchReports();
  });

  handlersInstalled = true;
}

export const useChimeraHubStore = create<ChimeraHubState>((set, get) => ({
  reports: [],
  selectedReportId: null,
  detail: null,
  loading: false,
  detailLoading: false,
  error: null,
  filterSessionId: '',
  filterLifecycle: '',
  searchQuery: '',

  fetchReports: () => {
    ensureChimeraHubHandlersInstalled();
    const client = getWSClient();
    if (!client.isConnected) {
      set({ loading: false });
      return;
    }
    set({ loading: true, error: null });
    const { filterSessionId, filterLifecycle } = get();
    client.send({
      type: 'chimera.reports.list',
      payload: {
        all: true,
        sessionId: filterSessionId || undefined,
        lifecycle: filterLifecycle || undefined,
      },
    });
  },

  selectReport: (reportId) => {
    ensureChimeraHubHandlersInstalled();
    set({ selectedReportId: reportId });
    if (!reportId) {
      set({ detail: null, detailLoading: false });
      return;
    }
    const client = getWSClient();
    if (!client.isConnected) return;
    set({ detailLoading: true, error: null });
    client.send({
      type: 'chimera.report.get',
      payload: { reportId },
    });
  },

  setFilterSessionId: (sessionId) => {
    set({ filterSessionId: sessionId });
    get().fetchReports();
  },

  setFilterLifecycle: (lifecycle) => {
    set({ filterLifecycle: lifecycle });
    get().fetchReports();
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query });
  },

  transitionReport: (reportId, to, reason) => {
    const client = getWSClient();
    if (!client.isConnected) return;
    client.send({
      type: 'chimera.report.transition',
      payload: { reportId, to, reason },
    });
  },

  addReportNote: (reportId, note) => {
    const client = getWSClient();
    if (!client.isConnected) return;
    client.send({
      type: 'chimera.report.add_note',
      payload: { reportId, note },
    });
  },

  transitionFinding: (findingId, to, outcome, reason) => {
    const client = getWSClient();
    if (!client.isConnected) return;
    client.send({
      type: 'chimera.finding.transition',
      payload: { findingId, to, outcome, reason },
    });
  },
}));

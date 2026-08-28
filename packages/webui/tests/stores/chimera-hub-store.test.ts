import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWSClient } from '../../src/lib/ws-client';
import {
  ensureChimeraHubHandlersInstalled,
  useChimeraHubStore,
  type ChimeraReportSummaryItem,
  type ChimeraReportFullDetail,
} from '../../src/stores/chimera-hub-store';

vi.mock('../../src/lib/ws-client', () => {
  const handlers: Record<string, ((msg: unknown) => void)[]> = {};
  const client = {
    isConnected: true,
    send: vi.fn(),
    on: vi.fn((type: string, fn: (msg: unknown) => void) => {
      handlers[type] = handlers[type] || [];
      handlers[type]!.push(fn);
    }),
    emit: (type: string, payload: unknown) => {
      for (const fn of handlers[type] || []) {
        fn({ type, payload });
      }
    },
  };
  return { getWSClient: () => client };
});

describe('chimera-hub-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChimeraHubStore.setState({
      reports: [],
      selectedReportId: null,
      detail: null,
      loading: false,
      detailLoading: false,
      error: null,
      filterSessionId: '',
      filterLifecycle: '',
      searchQuery: '',
    });
    ensureChimeraHubHandlersInstalled();
  });

  it('fetchReports dispatches chimera.reports.list frame', () => {
    const store = useChimeraHubStore.getState();
    store.fetchReports();

    const client = getWSClient();
    expect(client.send).toHaveBeenCalledWith({
      type: 'chimera.reports.list',
      payload: { all: true, sessionId: undefined, lifecycle: undefined },
    });
    expect(useChimeraHubStore.getState().loading).toBe(true);
  });

  it('populates reports on receiving chimera.reports message', () => {
    const mockReport: ChimeraReportSummaryItem = {
      reportId: 'r-100',
      sessionId: 'sess-1',
      reviewedAt: '2026-08-28T12:00:00Z',
      lifecycleStatus: 'open',
      totalFindings: 2,
      hasActionableFindings: true,
    };

    (getWSClient() as unknown as { emit: (t: string, p: unknown) => void }).emit('chimera.reports', {
      reports: [mockReport],
      isQuery: true,
    });

    expect(useChimeraHubStore.getState().reports).toHaveLength(1);
    expect(useChimeraHubStore.getState().reports[0]?.reportId).toBe('r-100');
    expect(useChimeraHubStore.getState().loading).toBe(false);
  });

  it('selectReport requests detail and updates state', () => {
    const store = useChimeraHubStore.getState();
    store.selectReport('r-100');

    const client = getWSClient();
    expect(client.send).toHaveBeenCalledWith({
      type: 'chimera.report.get',
      payload: { reportId: 'r-100' },
    });
    expect(useChimeraHubStore.getState().selectedReportId).toBe('r-100');
    expect(useChimeraHubStore.getState().detailLoading).toBe(true);

    const mockDetail: ChimeraReportFullDetail = {
      report: {
        id: 'r-100',
        reviewedAt: '2026-08-28T12:00:00Z',
        sessionId: 'sess-1',
        agentId: 'chimera-review',
        reviewerModel: 'test-model',
        source: 'chimera',
        reviewStatus: 'success',
        lifecycle: 'open',
        files: [],
        counts: { critical: 1, high: 0, medium: 0, low: 0 },
        totalFindings: 1,
        unparseableCount: 0,
        rawText: 'Report text',
      },
      findings: [
        {
          finding: {
            id: 'f-1',
            fingerprint: 'fp-1',
            severity: 'critical',
            source: 'chimera',
            title: 'Bug',
            description: 'Bug desc',
            createdAt: '2026-08-28T12:00:00Z',
            status: 'active',
            originReport: { reportId: 'r-100', sessionId: 'sess-1', agentId: 'chimera-review', reviewerModel: 'test-model' },
          },
          events: [],
        },
      ],
      events: [
        {
          id: 'ev-1',
          reportId: 'r-100',
          eventType: 'created',
          fromLifecycle: null,
          toLifecycle: 'open',
          actorId: 'chimera',
          actorKind: 'system',
          timestamp: '2026-08-28T12:00:00Z',
        },
      ],
    };

    (getWSClient() as unknown as { emit: (t: string, p: unknown) => void }).emit('chimera.report.detail', mockDetail);

    expect(useChimeraHubStore.getState().detail?.report?.id).toBe('r-100');
    expect(useChimeraHubStore.getState().detail?.findings).toHaveLength(1);
    expect(useChimeraHubStore.getState().detail?.events).toHaveLength(1);
    expect(useChimeraHubStore.getState().detailLoading).toBe(false);
  });

  it('transitionReport, addReportNote, and transitionFinding send appropriate frames', () => {
    const store = useChimeraHubStore.getState();
    const client = getWSClient();

    store.transitionReport('r-100', 'completed', 'All fixed');
    expect(client.send).toHaveBeenCalledWith({
      type: 'chimera.report.transition',
      payload: { reportId: 'r-100', to: 'completed', reason: 'All fixed' },
    });

    store.addReportNote('r-100', 'Audit approved');
    expect(client.send).toHaveBeenCalledWith({
      type: 'chimera.report.add_note',
      payload: { reportId: 'r-100', note: 'Audit approved' },
    });

    store.transitionFinding('f-1', 'resolved', 'fixed', 'PR merged');
    expect(client.send).toHaveBeenCalledWith({
      type: 'chimera.finding.transition',
      payload: { findingId: 'f-1', to: 'resolved', outcome: 'fixed', reason: 'PR merged' },
    });
  });
});

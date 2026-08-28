import { beforeEach, describe, expect, it } from 'vitest';
import {
  useChimeraReportsStore,
  type ChimeraReportNotice,
} from '../../src/stores/chimera-reports-store';

function notice(overrides: Partial<ChimeraReportNotice> = {}): ChimeraReportNotice {
  return {
    reportId: 'report-1',
    sessionId: 'sess-1',
    message: '🦂 Chimera report ready — 2 finding(s).',
    findingCount: 2,
    fileCount: 3,
    hasActionableFindings: true,
    receivedAt: 1_000,
    actionedAt: null,
    source: 'event',
    ...overrides,
  };
}

describe('chimera-reports-store', () => {
  beforeEach(() => {
    useChimeraReportsStore.setState({ bySession: {} });
  });

  it('records one notice per reportId and flags duplicates', () => {
    const store = useChimeraReportsStore.getState();
    expect(store.recordReport(notice())).toBe(true);
    expect(store.recordReport(notice())).toBe(false);
    const list = useChimeraReportsStore.getState().bySession['sess-1'];
    expect(list).toHaveLength(1);
    expect(list?.[0]?.reportId).toBe('report-1');
  });

  it('keeps sessions isolated — one tab never sees another tab\'s report', () => {
    const store = useChimeraReportsStore.getState();
    expect(store.recordReport(notice())).toBe(true);
    expect(store.recordReport(notice({ reportId: 'report-2', sessionId: 'sess-2' }))).toBe(true);
    expect(useChimeraReportsStore.getState().bySession['sess-1']).toHaveLength(1);
    expect(useChimeraReportsStore.getState().bySession['sess-2']).toHaveLength(1);
  });

  it('records a report with an empty reportId is refused', () => {
    expect(useChimeraReportsStore.getState().recordReport(notice({ reportId: '' }))).toBe(false);
    expect(useChimeraReportsStore.getState().bySession['sess-1']).toBeUndefined();
  });

  it('markActioned stamps actionedAt exactly once and is idempotent', () => {
    const store = useChimeraReportsStore.getState();
    store.recordReport(notice());
    store.markActioned('sess-1', 'report-1', 2_000);
    store.markActioned('sess-1', 'report-1', 3_000);
    expect(useChimeraReportsStore.getState().bySession['sess-1']?.[0]?.actionedAt).toBe(2_000);
  });

  it('markActioned is a no-op for unknown sessions or reports', () => {
    const before = useChimeraReportsStore.getState().bySession;
    useChimeraReportsStore.getState().markActioned('sess-x', 'report-x', 2_000);
    expect(useChimeraReportsStore.getState().bySession).toBe(before);
  });

  it('hydrateReports adds only unknown reportIds and never clobbers actionedAt', () => {
    const store = useChimeraReportsStore.getState();
    store.recordReport(notice({ source: 'event' }));
    store.markActioned('sess-1', 'report-1', 5_000);
    // A late hydration for the same report must not reset the actioned stamp.
    store.hydrateReports('sess-1', [
      notice({ source: 'hydrate', receivedAt: 4_000, actionedAt: null }),
      notice({ reportId: 'report-2', source: 'hydrate', receivedAt: 6_000 }),
    ]);
    const list = useChimeraReportsStore.getState().bySession['sess-1'];
    expect(list).toHaveLength(2);
    expect(list?.[0]?.actionedAt).toBe(5_000);
    expect(list?.[1]?.reportId).toBe('report-2');
  });

  it('forgetSession drops only that session\'s list', () => {
    const store = useChimeraReportsStore.getState();
    store.recordReport(notice());
    store.recordReport(notice({ reportId: 'report-2', sessionId: 'sess-2' }));
    store.forgetSession('sess-1');
    expect(useChimeraReportsStore.getState().bySession['sess-1']).toBeUndefined();
    expect(useChimeraReportsStore.getState().bySession['sess-2']).toHaveLength(1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the external seams the handler module touches ────────────────────
// The lanes (chat-lanes / ws-client-utils routing) stay REAL — routing the
// card into the right lane IS the behavior under test.
const { toastInfo, wsSendMessage } = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  wsSendMessage: vi.fn(),
}));

vi.mock('@/components/Toaster', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: toastInfo },
}));

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    on: () => () => {},
    sendMessage: wsSendMessage,
    getGitChanges: () => {},
    getGitInfo: () => {},
    getChimeraReports: () => {},
  }),
}));

vi.mock('@/hooks/ws-handlers/files-mailbox-handlers', () => ({
  reconcileFileTabsAfterEnvChange: () => {},
}));

// The barrel is stubbed except the REAL chimera-reports store, whose state
// the assertions below read back. Everything else misc-handlers touches is
// inert for these handlers.
vi.mock('@/stores', async () => {
  const chimera = await import('../../src/stores/chimera-reports-store');
  const makeStore = (state: Record<string, unknown> = {}) => {
    const fn = (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(state) : state;
    (fn as unknown as { getState: () => Record<string, unknown> }).getState = () => state;
    return fn;
  };
  return {
    useChimeraReportsStore: chimera.useChimeraReportsStore,
    useCouncilLogStore: Object.assign(makeStore({}), { for: () => makeStore({}) }),
    useCronStore: makeStore({ setSnapshot: () => {}, recordFired: () => {} }),
    useFileStore: makeStore({}),
    useGitChangesStore: makeStore({}),
    useGitInfoStore: makeStore({}),
    useGoalRunStore: makeStore({}),
    useGoalStateStore: makeStore({}),
    useSessionStore: makeStore({}),
    useUIStore: makeStore({}),
    useVizStore: makeStore({}),
  };
});

import {
  handleChimeraReportAvailable,
  handleChimeraReports,
} from '../../src/hooks/ws-handlers/misc-handlers';
import { useChimeraReportsStore } from '../../src/stores/chimera-reports-store';
import { DEFAULT_LANE_ID, readLane, useChatLanes } from '../../src/stores/chat-lanes';

function event(
  overrides: Record<string, unknown> = {},
): Parameters<typeof handleChimeraReportAvailable>[0] {
  return {
    type: 'chimera.report_available',
    payload: {
      reportId: 'report-1',
      sessionId: 'sess-1',
      message: '🦂 Chimera report ready — 2 potential finding(s).',
      fileCount: 3,
      findingCount: 2,
      hasActionableFindings: true,
      ...overrides,
    },
  } as Parameters<typeof handleChimeraReportAvailable>[0];
}

function hydration(
  reports: Array<Record<string, unknown>>,
  sessionId = 'sess-1',
): Parameters<typeof handleChimeraReports>[0] {
  return { type: 'chimera.reports', payload: { sessionId, reports } } as Parameters<
    typeof handleChimeraReports
  >[0];
}

function cardReportIds(sessionId: string): string[] {
  return readLane(sessionId).messages.flatMap((m) =>
    m.chimeraReport ? [m.chimeraReport.reportId] : [],
  );
}

describe('chimera.report_available — surfacing in the session lane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChimeraReportsStore.setState({ bySession: {} });
    useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
  });

  it('lands an actionable card in the owning session lane and the registry', () => {
    handleChimeraReportAvailable(event());

    const lane = readLane('sess-1');
    expect(lane.messages).toHaveLength(1);
    expect(lane.messages[0]?.role).toBe('system');
    expect(lane.messages[0]?.chimeraReport).toEqual({
      reportId: 'report-1',
      actionable: true,
      actionedAt: null,
    });
    expect(lane.messages[0]?.content).toContain('Chimera report ready');
    expect(useChimeraReportsStore.getState().bySession['sess-1']).toHaveLength(1);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it('keeps an information-only report out of the transcript', () => {
    handleChimeraReportAvailable(event({ hasActionableFindings: false, findingCount: 0 }));

    expect(readLane('sess-1').messages).toHaveLength(0);
    // Still registered so hydration/other surfaces can consult it.
    expect(useChimeraReportsStore.getState().bySession['sess-1']).toHaveLength(1);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it('never double-cards a duplicate event for the same report', () => {
    handleChimeraReportAvailable(event());
    handleChimeraReportAvailable(event());

    expect(cardReportIds('sess-1')).toEqual(['report-1']);
    expect(toastInfo).toHaveBeenCalledTimes(2);
  });

  it('drops an untagged event without registering or carding', () => {
    handleChimeraReportAvailable(event({ sessionId: undefined }));

    expect(readLane('sess-1').messages).toHaveLength(0);
    expect(useChimeraReportsStore.getState().bySession['sess-1']).toBeUndefined();
  });

  it('routes by payload sessionId — a background lane gets its own card only', () => {
    handleChimeraReportAvailable(event({ sessionId: 'sess-2', reportId: 'report-2' }));

    expect(cardReportIds('sess-2')).toEqual(['report-2']);
    expect(readLane('sess-1').messages).toHaveLength(0);
  });
});

describe('chimera.reports — hydration fills the registry, never the transcript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChimeraReportsStore.setState({ bySession: {} });
    useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
  });

  it('registers pending reports and skips terminal ones, without carding any', () => {
    handleChimeraReports(
      hydration([
        {
          reportId: 'report-a',
          reviewedAt: '2026-08-28T00:00:00Z',
          lifecycleStatus: 'open',
          totalFindings: 2,
          hasActionableFindings: true,
        },
        {
          reportId: 'report-b',
          reviewedAt: '2026-08-27T00:00:00Z',
          lifecycleStatus: 'completed',
          totalFindings: 4,
          hasActionableFindings: false,
        },
        {
          reportId: 'report-c',
          reviewedAt: '2026-08-26T00:00:00Z',
          lifecycleStatus: 'skipped',
          totalFindings: 1,
          hasActionableFindings: false,
        },
        {
          reportId: 'report-d',
          reviewedAt: '2026-08-25T00:00:00Z',
          lifecycleStatus: 'open',
          totalFindings: 0,
          hasActionableFindings: false,
        },
        {
          reportId: 'report-e',
          reviewedAt: '2026-08-24T00:00:00Z',
          lifecycleStatus: 'open',
          totalFindings: 3,
          hasActionableFindings: false,
        },
      ]),
    );

    // No cards, not even for the actionable `report-a`. This response arrives
    // on every tab activation, so carding from it re-wrote review notices into
    // a conversation replayed from a journal that never contained them.
    expect(cardReportIds('sess-1')).toEqual([]);
    // Terminal and finding-less reports are still filtered out of the
    // registry; the rest are addressable for the Chimera panel.
    const hydrated = useChimeraReportsStore.getState().bySession['sess-1'] ?? [];
    expect(hydrated).toHaveLength(2);
    expect(hydrated.find((r) => r.reportId === 'report-e')?.hasActionableFindings).toBe(false);
  });

  it('leaves a live card alone and adds none of its own, however often it replays', () => {
    handleChimeraReportAvailable(event({ reportId: 'report-live' }));
    const payload = [
      {
        reportId: 'report-live',
        reviewedAt: '2026-08-28T00:00:00Z',
        lifecycleStatus: 'open',
        totalFindings: 2,
        hasActionableFindings: true,
      },
      {
        reportId: 'report-new',
        reviewedAt: '2026-08-28T01:00:00Z',
        lifecycleStatus: 'open',
        totalFindings: 1,
        hasActionableFindings: true,
      },
    ];

    // A report that arrived while this session was open keeps its card — it is
    // an event about this run. `report-new` is history and stays in the panel.
    handleChimeraReports(hydration(payload));
    expect(cardReportIds('sess-1')).toEqual(['report-live']);

    // A tab re-activation re-requests the list; the transcript does not move.
    handleChimeraReports(hydration(payload));
    expect(cardReportIds('sess-1')).toEqual(['report-live']);
    // Both are addressable in the registry, live provenance untouched.
    expect(useChimeraReportsStore.getState().bySession['sess-1']).toHaveLength(2);
  });

  it('ignores a response that names no session', () => {
    handleChimeraReports(
      hydration([{ reportId: 'report-a', lifecycleStatus: 'open', totalFindings: 1 }], ''),
    );
    expect(useChimeraReportsStore.getState().bySession['sess-1']).toBeUndefined();
  });
});

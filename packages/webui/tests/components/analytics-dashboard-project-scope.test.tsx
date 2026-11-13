import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalyticsDashboard } from '../../src/components/AnalyticsDashboard';

vi.mock('@/i18n', () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ on: () => () => {}, getStats: () => {} }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIVE = [
  {
    sessionId: 'sess_live',
    projectName: 'WrongStack',
    status: 'running',
    pid: 7,
    startedAt: '2026-11-13T10:00:00.000Z',
    agents: [
      {
        id: 'a1',
        name: 'leader',
        status: 'running',
        currentTool: 'grep',
        iterations: 22,
        toolCalls: 358,
        lastActivityAt: '2026-11-13T10:05:00.000Z',
      },
    ],
  },
];

// 2026-11-13: in the desktop the dashboard is fed by the project engine, which runs no
// conversation, and no interface events are recorded: every cost, usage and event section read
// zero next to 581 real tool calls. Those sections are left out and the live agents shown.
it('shows the live agents and leaves out the zero own-session and event sections', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).includes('/api/sessions')
        ? new Response(JSON.stringify(LIVE), { status: 200 })
        : new Response(null, { status: 503 }),
    ),
  );
  await act(async () => {
    render(<AnalyticsDashboard uiEvents={false} hostSession={false} />);
  });
  expect(await screen.findByText('leader')).toBeTruthy();
  expect(screen.getByText('grep')).toBeTruthy();
  expect(screen.getByText('sess_live')).toBeTruthy();
  for (const gone of [
    'activity:analytics.sessionCost',
    'activity:analytics.sessionDuration',
    'activity:analytics.totalEvents',
    'activity:analytics.activeSessionUsage',
    'activity:analytics.healthErrors',
    'activity:analytics.recentEvents',
    'activity:analytics.eventsByCategory',
  ])
    expect(screen.queryByText(gone), gone).toBeNull();
});

it('keeps the full dashboard for a host that converses in its own engine', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  await act(async () => {
    render(<AnalyticsDashboard />);
  });
  expect(await screen.findByText('activity:analytics.sessionCost')).toBeTruthy();
  expect(screen.getByText('activity:analytics.recentEvents')).toBeTruthy();
});

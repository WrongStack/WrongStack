/**
 * The "Hide idle" toggle: one persisted fleet pref driving both HQ surfaces.
 *
 * Fleet Map assertions run against the compact table presentation; the map
 * canvas and the table consume the SAME filtered topology, so the pure-model
 * suite (fleet-topology-idle.test.ts) covers the canvas path.
 *
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { HqSessionAgentSummary, HqSnapshot } from '@wrongstack/hq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/data/api.js', () => ({
  fetchJson: vi.fn(() => Promise.reject(new Error('offline'))),
  authorizedFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))),
  postCommand: vi.fn(),
  postMailboxSend: vi.fn(),
  fetchEvents: vi.fn(() => Promise.reject(new Error('offline'))),
}));

// React Flow measures its container; jsdom reports zeroes, but the module
// still needs ResizeObserver to exist at import time.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

const { useHqStore } = await import('../../src/data/store/index.js');
const { __test__, resetHqLocalPrefs, setHqFleetPrefs } = await import(
  '../../src/data/local-prefs.js'
);
const { FleetMapView } = await import('../../src/views/fleet/index.js');
const { CockpitView } = await import('../../src/views/cockpit.js');

const T = '2026-10-07T09:00:00.000Z';

function agent(id: string, status: HqSessionAgentSummary['status']): HqSessionAgentSummary {
  return { id, name: id, status, iterations: 1, toolCalls: 2, lastActivityAt: T };
}

function workerSnapshot(): HqSnapshot {
  const session = (sessionId: string, agents: HqSessionAgentSummary[]) => ({
    sessionId,
    clientKind: 'cli' as const,
    machineId: 'machine-1',
    hostname: 'devbox',
    projectId: 'proj-1',
    projectName: 'Project 1',
    projectRoot: 'D:/proj',
    status: 'active' as const,
    startedAt: T,
    lastActivityAt: T,
    agentCount: agents.length,
    agents,
  });
  return {
    generatedAt: T,
    clients: [],
    projects: [
      {
        projectId: 'proj-1',
        projectName: 'Project 1',
        projectRootDisplay: 'D:/proj',
        machineIds: ['machine-1'],
        gitBranch: 'main',
        activeClients: 1,
        activeSessions: 2,
        activeSubagents: 3,
        totalCostUsd: 1.25,
        lastActivityAt: T,
        status: 'active',
      },
    ],
    sessions: [],
    fleets: [],
    mailboxes: [],
    totals: {
      activeProjects: 1,
      activeClients: 0,
      activeSessions: 2,
      activeSubagents: 3,
      unreadMailboxMessages: 0,
      incompleteMailboxMessages: 0,
      totalCostUsd: 1.25,
    },
    machines: [
      {
        machineId: 'machine-1',
        hostname: 'devbox',
        clientCount: 1,
        sessionCount: 2,
        agentCount: 3,
        projectIds: ['proj-1'],
        lastActivityAt: T,
      },
    ],
    liveSessions: [
      session('sess-1', [agent('runner', 'running'), agent('lounger', 'idle')]),
      session('sess-2', [agent('fixer', 'error')]),
    ],
  };
}

function hideIdleToggle(): HTMLElement {
  return screen.getByRole('button', { name: /hide idle/i });
}

function agentsTile(): HTMLElement | undefined {
  return screen
    .getAllByTestId('stat-tile')
    .find((tile) => tile.querySelector('[data-testid="stat-label"]')?.textContent === 'agents');
}

beforeEach(() => {
  window.localStorage.clear();
  resetHqLocalPrefs();
  useHqStore.setState({
    snapshot: workerSnapshot(),
    alerts: [],
    events: [],
    commandStatuses: [],
    connected: true,
    selectedClientId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  resetHqLocalPrefs();
});

describe('Fleet Map hide-idle toggle', () => {
  it('hides idle agents from the compact list and restores them on toggle-off', () => {
    setHqFleetPrefs({ layout: 'compact' });
    render(<FleetMapView />);
    expect(screen.getByText('lounger')).toBeVisible();
    expect(screen.getByText('runner')).toBeVisible();

    fireEvent.click(hideIdleToggle());
    expect(screen.queryByText('lounger')).toBeNull();
    expect(screen.getByText('runner')).toBeVisible();
    expect(screen.getByText('fixer')).toBeVisible();
    expect(hideIdleToggle()).toHaveAttribute('aria-pressed', 'true');

    const raw = window.localStorage.getItem(__test__.STORAGE_KEY);
    const parsed = JSON.parse(raw ?? '{}') as { fleet: { hideIdle: boolean } };
    expect(parsed.fleet.hideIdle).toBe(true);

    fireEvent.click(hideIdleToggle());
    expect(screen.getByText('lounger')).toBeVisible();
  });
});

describe('Cockpit hide-idle toggle', () => {
  it('recounts the agents tile to working workers and shows the hidden idle count', () => {
    render(<CockpitView />);
    expect(agentsTile()?.querySelector('[data-testid="stat-value"]')?.textContent).toBe('3');

    fireEvent.click(hideIdleToggle());
    expect(agentsTile()?.querySelector('[data-testid="stat-value"]')?.textContent).toBe('2');
    expect(agentsTile()?.textContent).toContain('1 idle hidden');
    expect(hideIdleToggle()).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(hideIdleToggle());
    expect(agentsTile()?.querySelector('[data-testid="stat-value"]')?.textContent).toBe('3');
  });

  it('shares the pref with the Fleet Map — hiding on one surface hides on the other', () => {
    setHqFleetPrefs({ hideIdle: true });
    render(<CockpitView />);
    expect(agentsTile()?.querySelector('[data-testid="stat-value"]')?.textContent).toBe('2');
    expect(hideIdleToggle()).toHaveAttribute('aria-pressed', 'true');
  });
});

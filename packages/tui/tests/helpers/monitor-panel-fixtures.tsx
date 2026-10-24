/**
 * Shared fixture harness for the TUI monitor panels.
 *
 * The panels are full-screen surfaces: they read live data through props or a
 * service binding, measure the terminal through `useMonitorSize`, and only
 * honour shortcuts when `usePanelShortcutsEnabled()` is true. Mounting one
 * therefore needs the same two providers the production app supplies plus a
 * real data fixture — this module owns both so the leaked-mouse sweep (and any
 * future panel test) can mount a panel in one line.
 *
 * `vi.mock` cannot live here: Vitest hoists mock declarations per test module,
 * so the module-level mocks a panel needs stay in the test file that imports
 * it. This harness owns the data half; the mock half is documented per panel in
 * the sweep's `CASES` entry.
 */

import type { WorktreeTimelineEvent } from '@wrongstack/contracts/types/worktree-timeline';
import type { ContextBreakdown } from '@wrongstack/core/agent';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import type { GoalSummary } from '../../src/app-state.js';
import type { ContextPanelData } from '../../src/components/context-panel.js';
import type { CronListResult } from '../../src/components/cron-jobs.js';
import { MonitorViewportProvider, PanelInputProvider } from '../../src/components/monitor-shell.js';
import { emptyMemoryContextMonitor } from '../../src/memory-context-monitor.js';
import { createTestState } from './create-test-state.js';

/** Terminal the panels measure against; wide enough that no column is dropped. */
const MONITOR_VIEWPORT = { columns: 120, rows: 40 };

/** Mount a monitor panel with the providers the real app supplies around it. */
export function renderMonitorPanel(element: ReactElement): ReturnType<typeof render> {
  return render(
    <MonitorViewportProvider value={MONITOR_VIEWPORT}>
      <PanelInputProvider value={true}>{element}</PanelInputProvider>
    </MonitorViewportProvider>,
  );
}

/** `coordinator-panel` takes the app state slice verbatim. */
export function coordinatorFixture(): ReturnType<typeof createTestState>['coordinator'] {
  return createTestState().coordinator;
}

/** `goal-panel` renders a populated goal; `GoalSummary` may itself be null. */
export function goalFixture(): NonNullable<GoalSummary> {
  return {
    goal: 'ship the leaked-mouse sweep',
    refinedGoal: 'ship the leaked-mouse sweep across every monitor panel',
    goalState: 'active',
    iterations: 3,
    progress: 0.5,
    progressNote: 'two panels left',
    progressTrend: 'steady',
    deliverables: ['fixture harness', 'swept panels'],
    lastTask: 'mount the monitor panels',
    lastStatus: 'running',
  };
}

/** `worktree-monitor` projects the normalised worktree lifecycle log. */
export function worktreeTimelineEvents(): WorktreeTimelineEvent[] {
  const at = Date.now() - 60_000;
  const base = {
    handleId: 'leaked-mouse-1',
    ownerId: 'agent-1',
    branch: 'wstack/ap/leaked-mouse-1',
  };
  return [
    { kind: 'allocated', at, ...base, ownerLabel: 'agent-1', baseBranch: 'main' },
    {
      kind: 'committed',
      at: at + 20_000,
      ...base,
      committed: true,
      insertions: 42,
      deletions: 7,
      files: 5,
    },
  ];
}

/** One enabled job with a recent and a future run, so the list is non-empty. */
export function cronSnapshot(): CronListResult {
  const now = Date.now();
  return {
    ok: true,
    count: 1,
    maxConcurrent: 2,
    jobs: [
      {
        name: 'heartbeat',
        intervalMs: 60_000,
        action: 'ping the fleet',
        enabled: true,
        lastRun: new Date(now - 30_000).toISOString(),
        nextRun: new Date(now + 30_000).toISOString(),
        runCount: 3,
        overdue: false,
      },
    ],
  };
}

/**
 * `connections-panel` collects its own report through `collectConnectionsHealth`,
 * so the service list has to be populated for the panel to render rows. Fields
 * mirror the report the package's own panel suite uses.
 */
export function connectionsReport(): {
  checkedAt: number;
  overall: 'healthy';
  services: Array<{
    id: string;
    label: string;
    status: string;
    required: boolean;
    mode: string;
    detail: string;
    ownerPid: number;
    latencyMs: number;
  }>;
} {
  return {
    checkedAt: Date.now(),
    overall: 'healthy',
    services: [
      {
        id: 'session-catalog',
        label: 'Session Catalog',
        status: 'healthy',
        required: true,
        mode: 'project-daemon',
        detail: '5 catalog session(s)',
        ownerPid: 1234,
        latencyMs: 2,
      },
      {
        id: 'chronicle',
        label: 'Chronicle telemetry',
        status: 'healthy',
        required: true,
        mode: 'server',
        detail: 'Serving telemetry',
        ownerPid: 2345,
        latencyMs: 1,
      },
    ],
  };
}

/**
 * Minimal but complete `ContextPanelData`: the overview tab needs the token
 * figures, the composition tab needs `breakdown`, and the agents tab needs the
 * leader counters plus a real memory monitor.
 */
export function contextPanelData(): ContextPanelData {
  return {
    ctxPct: 15,
    ctxTokens: 30_000,
    ctxMaxTokens: 200_000,
    provider: 'anthropic',
    model: 'claude-sonnet',
    mode: 'default',
    uptime: '5m',
    breakdown: {
      system: { total: 10_000, bySource: {} as ContextBreakdown['system']['bySource'] },
      tools: { total: 5_000, builtin: 5_000, mcp: 0, count: 3, mcpByServer: {} },
      history: {
        total: 15_000,
        text: 10_000,
        toolInputs: 1_000,
        toolResults: 3_000,
        thinking: 1_000,
        other: 0,
        messageCount: 6,
      },
      volatile: { ledger: 0, nextsteps: 0, total: 0 },
      total: 30_000,
      effectiveMaxContext: 200_000,
      usedPct: 0.15,
      warnings: [],
    },
    fleetEntries: [],
    leaderIterations: 4,
    leaderToolCalls: 9,
    leaderStatus: 'idle',
    memoryContext: emptyMemoryContextMonitor(),
  };
}

import type { TodoItem } from '@wrongstack/core/agent';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { QueueItem } from '../src/app-state-core-types.js';
import type { FleetEntry } from '../src/app-state-fleet.js';
import {
  computeSidebarContentWidth,
  computeSidebarWidth,
  RightSidebar,
} from '../src/components/sidebar.js';
import {
  AgentsPanelSidebar,
  ConnectionsPanelSidebar,
  CoordinatorPanelSidebar,
  FleetPanelSidebar,
  GoalPanelSidebar,
  KanbanPanelSidebar,
  PlanPanelSidebar,
  ProcessListPanelSidebar,
  ProjectPickerSidebar,
  QueuePanelSidebar,
  SessionsPanelSidebar,
  TodosPanelSidebar,
  WorktreePanelSidebar,
} from '../src/components/sidebar-panels.js';
import { Box, Text } from '../src/ink.js';
import { displayWidth } from '../src/terminal-width.js';
import type { PanelId, WorktreeRow } from '../src/ui-contracts.js';
import { glyphs } from '../src/ui-glyphs.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

const NOW = Date.parse('2026-08-07T05:00:00.000Z');
const COLUMNS = [80, 120, 160] as const;

function fleetEntry(
  id: string,
  name: string,
  status: FleetEntry['status'],
  ctxPct: number,
  tool?: string,
): FleetEntry {
  return {
    id,
    name,
    status,
    streamingText: '',
    iterations: 12,
    toolCalls: 34,
    recentTools: [],
    recentMessages: [],
    cost: 0.042,
    startedAt: NOW - 372_300,
    lastEventAt: NOW,
    ctxPct,
    ...(tool ? { currentTool: { name: tool, startedAt: NOW - 1_200 } } : {}),
  };
}

const FLEET: Record<string, FleetEntry> = {
  leader: fleetEntry('leader', 'Leader Agent', 'running', 0.71, 'browser_snapshot'),
  alpha: fleetEntry('alpha', 'security-scanner-東京', 'running', 0.48, 'codebase-search'),
  beta: fleetEntry('beta', 'refactor-planner-with-a-very-long-name', 'running', 0.82, 'typecheck'),
  done: fleetEntry('done', 'completed-reviewer', 'success', 0.33),
  failed: fleetEntry('failed', 'failed-verifier', 'failed', 0.19),
};

const TODOS: TodoItem[] = [
  {
    id: 'active',
    status: 'in_progress',
    content: 'Generate all visual snapshots',
    activeForm: 'Generating thirty-nine real-TTY sidebar snapshots across every routed variant',
  },
  {
    id: 'pending',
    status: 'pending',
    content: 'Inspect Korean 한국어, Japanese 日本語, and emoji 🛰 telemetry at the narrow rail',
  },
  {
    id: 'done',
    status: 'completed',
    content: 'Preserve the existing sixteen content-column contract',
  },
];

const QUEUE: QueueItem[] = [
  {
    id: 1,
    displayText: 'Explain why the connection topology changed after reconnecting',
    blocks: [],
  },
  {
    id: 2,
    displayText: 'Review the Unicode-width behavior for 한국어 and 🛰 status glyphs',
    blocks: [],
  },
  { id: 3, displayText: 'Run the complete TUI regression suite after the visual pass', blocks: [] },
];

const WORKTREES: Record<string, WorktreeRow> = {
  sidebar: {
    branch: 'wstack/ap/sidebar-visual-presentation-and-real-tty-matrix',
    ownerLabel: 'visual-reviewer',
    status: 'active',
    insertions: 1284,
    deletions: 377,
    files: 29,
    allocatedAt: NOW - 600_000,
  },
  unicode: {
    branch: 'wstack/ap/한국어-日本語-width-verification',
    ownerLabel: 'unicode-verifier',
    status: 'needs-review',
    insertions: 84,
    deletions: 9,
    files: 6,
    allocatedAt: NOW - 300_000,
  },
};

function panelFor(id: PanelId, width: number): ReactElement {
  switch (id) {
    case 'projectPicker':
      return (
        <ProjectPickerSidebar
          items={[
            {
              key: 'current',
              label: 'WrongStack — terminal orchestration',
              subtitle: 'D:/Codebox/PROJECTS/WrongStack',
              kind: 'project',
            },
            {
              key: 'unicode',
              label: '国際化-laboratory-with-a-long-project-name',
              subtitle: '/workspace/한국어/日本語/🛰',
              kind: 'project',
            },
            { key: '__divider__', label: '', kind: 'action' },
            {
              key: 'new-session',
              label: 'Create a new isolated session',
              subtitle: 'Fresh context and worktree',
              kind: 'action',
            },
            {
              key: 'prev-sessions',
              label: 'Browse previous sessions',
              subtitle: 'Resume from durable history',
              kind: 'action',
            },
          ]}
          selected={1}
          filter="sidebar visual 한국어"
          hint="Enter opens the highlighted project"
          currentProject="WrongStack — terminal orchestration"
          width={width}
        />
      );
    case 'fleet':
      return <FleetPanelSidebar entries={FLEET} runningCount={3} nowTick={NOW} width={width} />;
    case 'agents':
      return <AgentsPanelSidebar entries={FLEET} totalCost={12.3456} nowTick={NOW} width={width} />;
    case 'worktree':
      return <WorktreePanelSidebar worktrees={WORKTREES} nowTick={NOW} width={width} />;
    case 'plan':
      return (
        <PlanPanelSidebar
          openCount={2}
          inProgressCount={1}
          doneCount={1}
          title="Real-TTY sidebar presentation verification"
          items={[
            {
              id: '1',
              title: 'Generate all thirty-nine routed sidebar snapshots',
              status: 'in_progress',
            },
            {
              id: '2',
              title: 'Inspect long Unicode telemetry without losing identity',
              status: 'open',
            },
            { id: '3', title: 'Keep every row inside the sixteen-column floor', status: 'open' },
            { id: '4', title: 'Preserve RightSidebar clipping ownership', status: 'done' },
          ]}
          width={width}
        />
      );
    case 'todos':
      return <TodosPanelSidebar todos={TODOS} width={width} />;
    case 'queue':
      return <QueuePanelSidebar items={QUEUE} width={width} />;
    case 'processList':
      return (
        <ProcessListPanelSidebar
          activeCount={3}
          totalCount={4}
          processes={[
            { pid: 123456, name: 'wrongstack-tui-with-a-long-process-name', status: 'running' },
            { pid: 234567, name: 'codebase-index-worker-日本語', status: 'running' },
            { pid: 345678, name: 'kanban-ipc-heartbeat', status: 'running' },
            { pid: 456789, name: 'idle-background-observer', status: 'idle' },
          ]}
          width={width}
        />
      );
    case 'goal':
      return (
        <GoalPanelSidebar
          goal={{
            goal: 'Make the right sidebar visually striking without changing its architecture',
            refinedGoal: 'Ship a dense, legible, show-like sidebar across every terminal width',
            goalState: 'active',
            iterations: 7,
            progress: 63,
            deliverables: [
              '[x] Preserve sixteen content columns',
              'Render all thirteen routed variants at three widths',
              'Inspect 한국어, 日本語, and emoji telemetry',
              'Verify the final matrix with production typechecks',
            ],
          }}
          coordinatorRunning
          width={width}
        />
      );
    case 'sessions':
      return (
        <SessionsPanelSidebar
          liveSessions={[
            {
              sessionId: 'current-session',
              projectName: 'WrongStack-main-日本語',
              projectSlug: 'wrongstack',
              workingDir: 'D:/Codebox/PROJECTS/WrongStack',
              status: 'active',
              pid: 12345,
              startedAt: '2026-08-07T04:00:00.000Z',
              agentCount: 3,
              agents: [],
            },
            {
              sessionId: 'other-session',
              projectName: 'internationalization-laboratory',
              projectSlug: 'i18n',
              workingDir: '/workspace/한국어',
              status: 'idle',
              pid: 22345,
              startedAt: '2026-08-07T03:00:00.000Z',
              agentCount: 1,
              agents: [],
            },
          ]}
          resumeSessions={[
            {
              id: 'resume-1',
              title: 'Fix the narrow-terminal connection topology regression',
              startedAt: '2026-08-06T03:00:00.000Z',
              endedAt: '2026-08-06T05:00:00.000Z',
              tokenTotal: 45000,
              iterationCount: 12,
              toolCallCount: 38,
              toolErrorCount: 1,
              outcome: 'completed',
            },
            {
              id: 'resume-2',
              title: 'Unicode-width audit 한국어 日本語 🛰',
              startedAt: '2026-08-05T03:00:00.000Z',
              endedAt: '2026-08-05T05:00:00.000Z',
              tokenTotal: 31000,
              iterationCount: 9,
              toolCallCount: 25,
              toolErrorCount: 0,
              outcome: 'timeout',
            },
          ]}
          currentSessionId="current-session"
          now={NOW}
          width={width}
        />
      );
    case 'coordinator':
      return (
        <CoordinatorPanelSidebar
          running
          activePhases={3}
          completedPhases={4}
          phaseNames={[
            'Generate real-TTY snapshot matrix',
            'Inspect long Unicode presentation',
            'Run typecheck and focused regressions',
          ]}
          elapsedMs={3_723_000}
          width={width}
        />
      );
    case 'kanban':
      return (
        <KanbanPanelSidebar
          columns={[
            { name: 'Backlog', count: 14 },
            { name: 'Todo / Ready', count: 5 },
            { name: 'Running 日本語', count: 3 },
            { name: 'Review', count: 2 },
            { name: 'Done', count: 128 },
          ]}
          totalActive={24}
          activeCardTitles={[
            'Generate all thirty-nine routed sidebar snapshots',
            'Inspect the connection signal matrix at sixteen columns',
            'Verify Unicode telemetry 한국어 日本語 🛰',
            'Run both TypeScript projects and Biome',
          ]}
          width={width}
        />
      );
    case 'connections':
      return (
        <ConnectionsPanelSidebar
          connections={[
            { name: 'Chronicle durable history', status: 'ok', latencyMs: 12 },
            { name: 'Codebase Index 日本語', status: 'ok', latencyMs: 47 },
            { name: 'SAGE Memory Injector', status: 'warn', latencyMs: 10000 },
            { name: 'Kanban IPC heartbeat', status: 'ok', latencyMs: 8 },
            { name: 'Mailbox IPC cross-session', status: 'down' },
          ]}
          width={width}
        />
      );
  }
}

describe('routed sidebar variants — real-TTY visual matrix', () => {
  for (const columns of COLUMNS) {
    for (const id of [
      'projectPicker',
      'fleet',
      'agents',
      'worktree',
      'plan',
      'todos',
      'queue',
      'processList',
      'goal',
      'sessions',
      'coordinator',
      'kanban',
      'connections',
    ] as const satisfies readonly PanelId[]) {
      it(`${id} at ${columns} columns`, { timeout: 5_000 }, async () => {
        const sidebarWidth = computeSidebarWidth(columns);
        const contentWidth = computeSidebarContentWidth(sidebarWidth);
        const view = renderRealTty(
          <Box width={columns} height={32} justifyContent="flex-end" overflowX="hidden">
            <RightSidebar width={sidebarWidth} maxHeight={32}>
              {panelFor(id, contentWidth)}
            </RightSidebar>
          </Box>,
          { columns, rows: 32 },
        );

        await settle();
        const frame = view.lastFrame();
        expect(view.lines().length).toBeLessThanOrEqual(32);
        for (const line of view.lines()) {
          expect(displayWidth(line), `${id}@${columns}: ${line}`).toBeLessThanOrEqual(columns);
        }
        expect(frame).toMatchSnapshot();
        view.unmount();
      });
    }
  }
});

describe('SidebarScrollbar persistent rail — real-TTY grow/shrink matrix', () => {
  const VIEWPORT_ROWS = 32 - 1; // RightSidebar reserves 1 row for its footer.
  const countGlyph = (frame: string, glyph: string): number => frame.split(glyph).length - 1;

  // One sidebar shell whose content and overflow state can be re-rendered on
  // a single live Ink instance: 5 probe rows when idle, 80 when grown. The
  // probe text is too short to wrap at the narrowest rail (18 usable columns).
  function railAt(columns: number, sidebarWidth: number, maxScroll: number): ReactElement {
    return (
      <Box width={columns} height={32} justifyContent="flex-end" overflowX="hidden">
        <RightSidebar width={sidebarWidth} maxHeight={32} maxScroll={maxScroll} scrollOffset={0}>
          <Box flexDirection="column">
            {Array.from({ length: maxScroll > 0 ? 80 : 5 }, (_, i) => (
              <Text key={i}>{`probe ${i + 1}`}</Text>
            ))}
          </Box>
        </RightSidebar>
      </Box>
    );
  }

  for (const columns of COLUMNS) {
    it(`scrollbar rail persists through grow/shrink at ${columns} columns`, {
      timeout: 15_000,
    }, async () => {
      const sidebarWidth = computeSidebarWidth(columns);
      expect(sidebarWidth, `sidebar visible at ${columns} columns`).toBeGreaterThan(0);

      // Idle: content fits — the reserved track column renders ░ cells, no thumb.
      const view = renderRealTty(railAt(columns, sidebarWidth, 0), { columns, rows: 32 });
      await settle();
      const idle = view.lastFrame();
      const idleTrack = countGlyph(idle, glyphs.cellEmpty);
      expect(idleTrack, `idle@${columns}: full-height thumb-less track`).toBe(VIEWPORT_ROWS);
      expect(idle.includes(glyphs.meter7), `idle@${columns}: no thumb when maxScroll is 0`).toBe(
        false,
      );

      // Grow: content overflows — the thumb appears on the SAME live instance.
      view.rerender(railAt(columns, sidebarWidth, 40));
      await settle();
      const grown = view.lastFrame();
      const thumb = countGlyph(grown, glyphs.meter7);
      expect(thumb, `overflow@${columns}: thumb appears`).toBeGreaterThan(0);
      expect(thumb, `overflow@${columns}: thumb smaller than the viewport`).toBeLessThan(
        VIEWPORT_ROWS,
      );
      const thumbLines = view
        .lines()
        .filter((line) => line.trimEnd().endsWith(glyphs.meter7)).length;
      expect(thumbLines, `overflow@${columns}: thumb sits on the right edge`).toBe(thumb);

      // Shrink: thumb disappears, track persists unchanged.
      view.rerender(railAt(columns, sidebarWidth, 0));
      await settle();
      const shrunk = view.lastFrame();
      expect(shrunk.includes(glyphs.meter7), `shrunk@${columns}: thumb disappears again`).toBe(
        false,
      );
      expect(
        countGlyph(shrunk, glyphs.cellEmpty),
        `shrunk@${columns}: rail persists after shrink`,
      ).toBe(idleTrack);
      view.unmount();
    });
  }
});

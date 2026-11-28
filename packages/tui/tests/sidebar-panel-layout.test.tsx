import { describe, expect, it } from 'vitest';
import type { Settings } from '../src/app-settings-type.js';
import { resolveAppSidebarLayout } from '../src/app-ui-state.js';
import { AppViewSidebar } from '../src/app-view-sidebar.js';
import { RightSidebar } from '../src/components/sidebar.js';
import {
  FleetPanelSidebar,
  PlanPanelSidebar,
  WorktreePanelSidebar,
} from '../src/components/sidebar-panels.js';
import { Box, Text } from '../src/ink.js';
import { displayWidth } from '../src/terminal-width.js';
import { createTestState } from './helpers/create-test-state.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

describe('routed sidebar panel layout', () => {
  it('scrolls routed queue items inside a short viewport with a one-row focus hint', async () => {
    const columns = 80;
    const rows = 9;
    const queue = Array.from({ length: 8 }, (_, index) => ({
      id: `queue-${index}`,
      displayText: `ITEM${index + 1}`,
    }));
    const initial = createTestState({ queuePanelOpen: true, sidebarFocused: true });
    function sidebar(offset: number) {
      const props = {
        host: { agent: { ctx: {} } },
        runtime: {
          termRows: rows,
          state: { ...initial, queue, sidebarScrollOffset: offset },
          activity: {},
          environment: {},
          statusbar: { entriesWithLeader: {} },
          dispatch: () => {},
        },
        sidebarWidth: 20,
        sidebarContentWidth: 16,
        sidebarScrollOffset: offset,
        sidebarMaxScroll: 31,
        sidebarSlotVisible: (id: string) => id === 'queue',
        hiddenSidebarPanelCount: 0,
        sidebarConnectionsData: [],
      } as unknown as React.ComponentProps<typeof AppViewSidebar>;
      return <AppViewSidebar {...props} />;
    }

    const view = renderRealTty(sidebar(0), { columns, rows });
    try {
      await settle();
      expect(view.lastFrame()).toContain('ITEM1');
      expect(view.lastFrame()).not.toContain('ITEM8');
      view.rerender(sidebar(4));
      await settle();
      expect(view.lastFrame()).toContain('ITEM8');
      expect(view.lines()).toHaveLength(rows);
      expect(view.lines().at(-1)).toContain('Shift+Tab');
    } finally {
      view.unmount();
    }
  });

  it('keeps a nested panel visible without widening or vertically shifting the terminal row', {
    timeout: 5_000,
  }, async () => {
    const columns = 80;
    const rows = 24;
    const state = createTestState({ monitorOpen: true });
    const { sidebarWidth, sidebarContentWidth, mainColumnWidth, overlayOpen } =
      resolveAppSidebarLayout(
        state,
        columns,
        { panelPositions: { fleet: 'sidebar' } } as unknown as Settings,
        false,
      );

    expect(overlayOpen).toBe(false);
    expect(sidebarWidth).toBe(20);
    expect(sidebarContentWidth).toBe(16);
    expect(mainColumnWidth).toBe(60);
    const view = renderRealTty(
      <Box flexDirection="row" width={columns} height={rows} overflowX="hidden">
        <Box width={mainColumnWidth} height={rows} flexShrink={0}>
          <Text>{'M'.repeat(mainColumnWidth)}</Text>
        </Box>
        <RightSidebar width={sidebarWidth} maxHeight={rows}>
          <FleetPanelSidebar entries={{}} runningCount={0} width={sidebarContentWidth} />
        </RightSidebar>
      </Box>,
      { columns, rows },
    );

    await settle();
    const frame = view.lastFrame();
    expect(frame).toContain('AGENT SWARM');
    expect(frame).toContain('IDLE');
    expect(view.lines().length).toBeLessThanOrEqual(rows);
    for (const line of view.lines()) {
      expect(displayWidth(line)).toBeLessThanOrEqual(columns);
    }
    view.unmount();
  });

  it('keeps plan status, progress, and step text legible at the minimum sidebar width', {
    timeout: 5_000,
  }, async () => {
    const columns = 80;
    const rows = 24;
    const sidebarWidth = 20;
    const contentWidth = 16;
    const view = renderRealTty(
      <Box width={columns} height={rows} justifyContent="flex-end" overflowX="hidden">
        <RightSidebar width={sidebarWidth} maxHeight={rows}>
          <PlanPanelSidebar
            openCount={1}
            inProgressCount={1}
            doneCount={1}
            title="Sidebar polish"
            items={[
              { id: 'active', title: 'Polish hierarchy', status: 'in_progress' },
              { id: 'open', title: 'Verify narrow rail', status: 'open' },
              { id: 'done', title: 'Inspect panels', status: 'done' },
            ]}
            width={contentWidth}
          />
        </RightSidebar>
      </Box>,
      { columns, rows },
    );

    await settle();
    const frame = view.lastFrame();
    expect(frame).toContain('PLAN');
    expect(frame).toContain('◐1');
    // The section header "PROGRESS" may render as "PROGRES··" on terminals
    // whose Unicode-glyph width table measures the leading `☷` glyph as
    // wider than the reference — the label is still legible from its prefix.
    expect(frame.replace(/[·\s]/g, '')).toMatch(/PROGRES/);
    // The step text used to be hard-truncated to ~12 chars at this width.
    // After the wrap-vs-truncate fix, titles soft-wrap onto multiple rows
    // inside `RightSidebar`'s frame, so the un-broken literal "Polish hierarchy"
    // is no longer present in the joined frame — `│` glyphs sit between the
    // wrapped words. Assert the start of the title (which always lands on the
    // first wrapped row) and confirm the second word is reachable by stripping
    // box-glyph characters as well as whitespace before substring matching.
    expect(frame).toContain('Polish');
    // The persistent scrollbar rail (commit 65835e697) interleaves `░` track
    // cells between the wrapped words, so strip the rail glyphs as well as
    // the card's box-glyph characters before substring matching.
    const stripped = frame.replace(/[│╭╮╰╯─░▉]/g, '');
    expect(stripped.replace(/\s+/g, ' ')).toContain('Polish hierarchy');
    for (const line of view.lines()) {
      expect(displayWidth(line)).toBeLessThanOrEqual(columns);
    }
    view.unmount();
  });

  it('prioritizes worktree identity over diff metrics at the minimum sidebar width', {
    timeout: 5_000,
  }, async () => {
    const columns = 80;
    const rows = 24;
    const view = renderRealTty(
      <Box width={columns} height={rows} justifyContent="flex-end" overflowX="hidden">
        <RightSidebar width={20} maxHeight={rows}>
          <WorktreePanelSidebar
            worktrees={{
              one: {
                branch: 'wstack/ap/sidebar-legibility-polish',
                ownerLabel: 'worker',
                status: 'active',
                insertions: 128,
                deletions: 37,
                files: 9,
                allocatedAt: Date.now(),
              },
            }}
            width={16}
          />
        </RightSidebar>
      </Box>,
      { columns, rows },
    );

    await settle();
    const frame = view.lastFrame();
    expect(frame).toContain('sidebar-leg');
    expect(frame).not.toContain('+128/-37');
    for (const line of view.lines()) {
      expect(displayWidth(line), line).toBeLessThanOrEqual(columns);
    }
    view.unmount();
  });
});

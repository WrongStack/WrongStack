import { describe, expect, it } from 'vitest';
import { resolveSidebarLayout } from '../src/app-ui-state.js';
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
  it('keeps a nested panel visible without widening or vertically shifting the terminal row', {
    timeout: 5_000,
  }, async () => {
    const columns = 80;
    const rows = 24;
    const state = createTestState({ monitorOpen: true });
    const { sidebarWidth, sidebarContentWidth, mainColumnWidth, overlayOpen } =
      resolveSidebarLayout(state, columns, { fleet: 'sidebar' }, false);

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
    expect(frame).toContain('PROGRESS');
    // The step text used to be hard-truncated to ~12 chars at this width.
    // After the wrap-vs-truncate fix, titles soft-wrap onto multiple rows
    // inside `RightSidebar`'s frame, so the un-broken literal "Polish hierarchy"
    // is no longer present in the joined frame — `│` glyphs sit between the
    // wrapped words. Assert the start of the title (which always lands on the
    // first wrapped row) and confirm the second word is reachable by stripping
    // box-glyph characters as well as whitespace before substring matching.
    expect(frame).toContain('Polish');
    const stripped = frame.replace(/[│╭╮╰╯─]/g, '');
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
